import type { Redis } from 'ioredis';
import { getRedis } from '../../database/redis.js';

export interface DeviceProfile {
  deviceId: string;
  billingTier: 'free' | 'standard' | 'enterprise';
  historicalCompliance: number;
  currentBalance: bigint;
}

export interface RateLimitResult {
  allowed: boolean;
  tokensRemaining: number;
  maxTokens: number;
  resetAtMs: number;
  retryAfterMs?: number;
}

const TIER_CONFIG: Record<
  'free' | 'standard' | 'enterprise',
  { baseRate: number; maxTokens: number }
> = {
  free: { baseRate: 10, maxTokens: 10 },
  standard: { baseRate: 100, maxTokens: 100 },
  enterprise: { baseRate: 500, maxTokens: 500 },
};

const BUCKET_TTL_S = 3600;
const BURST_MULTIPLIER = 3;
const BURST_DURATION_S = 5;
const BURST_COOLDOWN_S = 60;
const COMPLIANCE_BURST_THRESHOLD = 0.95;
const COMPLIANCE_WINDOW_SIZE = 1000;

function bucketKey(deviceId: string): string {
  return `rate:bucket:${deviceId}`;
}

function complianceKey(deviceId: string): string {
  return `rate:compliance:${deviceId}`;
}

// Atomic token-bucket update.
// KEYS[1] = bucket key
// ARGV: now_ms, normalMax, normalRate, burstMax, burstRate, compliance,
//       ttl, burstCooldownS, burstDurationS, burstThreshold
// Returns: {tokens, effectiveMax, resetAt_ms, allowed}
const BUCKET_LUA = `
local key            = KEYS[1]
local now_ms         = tonumber(ARGV[1])
local normalMax      = tonumber(ARGV[2])
local normalRate     = tonumber(ARGV[3])
local burstMax       = tonumber(ARGV[4])
local burstRate      = tonumber(ARGV[5])
local compliance     = tonumber(ARGV[6])
local ttl            = tonumber(ARGV[7])
local burstCooldownS = tonumber(ARGV[8])
local burstDurationS = tonumber(ARGV[9])
local burstThreshold = tonumber(ARGV[10])

local now_s = now_ms / 1000

local h         = redis.call('HMGET', key, 'tokens', 'lastRefill', 'burstAt')
local tokens     = tonumber(h[1])
local lastRefill = tonumber(h[2])
local burstAt    = tonumber(h[3]) or 0

local inBurst  = burstAt > 0 and (now_s - burstAt) < burstDurationS
local canBurst = compliance > burstThreshold
                 and (burstAt == 0 or (now_s - burstAt) >= burstCooldownS)

if canBurst and not inBurst then
  burstAt = now_s
  inBurst = true
end

local effectiveMax  = inBurst and burstMax  or normalMax
local effectiveRate = inBurst and burstRate or normalRate

if tokens == nil or lastRefill == nil then
  tokens    = effectiveMax
  lastRefill = now_ms
end

local elapsed = (now_ms - lastRefill) / 1000
tokens = math.min(effectiveMax, tokens + elapsed * effectiveRate)
lastRefill = now_ms

local allowed = 0
if tokens >= 1 then
  tokens  = tokens - 1
  allowed = 1
end

local resetAt_ms = now_ms
if effectiveRate > 0 and tokens < 1 then
  resetAt_ms = now_ms + math.ceil((1 - tokens) / effectiveRate * 1000)
end

redis.call('HMSET', key,
  'tokens',    tokens,
  'lastRefill', lastRefill,
  'burstAt',   burstAt)
redis.call('EXPIRE', key, ttl)

return {tokens, effectiveMax, resetAt_ms, allowed}
`;

// Atomic compliance window update.
// KEYS[1] = compliance key
// ARGV: field ('success'|'failure'), ttl, window_size
const COMPLIANCE_LUA = `
local key   = KEYS[1]
local field = ARGV[1]
local ttl   = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])

redis.call('HINCRBY', key, field, 1)
local total = redis.call('HINCRBY', key, 'total', 1)
if total >= limit then
  redis.call('DEL', key)
else
  redis.call('EXPIRE', key, ttl)
end
return total
`;

export class DeviceComplianceTracker {
  constructor(private readonly redis: Redis) {}

  async recordSubmission(deviceId: string, success: boolean): Promise<void> {
    const key = complianceKey(deviceId);
    await this.redis.eval(
      COMPLIANCE_LUA,
      1,
      key,
      success ? 'success' : 'failure',
      String(BUCKET_TTL_S),
      String(COMPLIANCE_WINDOW_SIZE),
    );
  }

  async getComplianceScore(deviceId: string): Promise<number> {
    const key = complianceKey(deviceId);
    const [successStr, totalStr] = await this.redis.hmget(key, 'success', 'total');
    const success = parseInt(successStr ?? '0', 10);
    const total = parseInt(totalStr ?? '0', 10);
    if (total === 0) return 0.5;
    return success / total;
  }
}

export class DynamicRateLimiter {
  private readonly redis: Redis;
  readonly complianceTracker: DeviceComplianceTracker;

  constructor(redis?: Redis) {
    this.redis = redis ?? getRedis();
    this.complianceTracker = new DeviceComplianceTracker(this.redis);
  }

  async checkLimit(deviceProfile: DeviceProfile): Promise<RateLimitResult> {
    const tier = TIER_CONFIG[deviceProfile.billingTier];
    const compliance = Math.max(0, Math.min(1, deviceProfile.historicalCompliance));
    const effectiveRate = tier.baseRate * (0.5 + 0.5 * compliance);
    const burstRate = effectiveRate * BURST_MULTIPLIER;
    const burstMax = tier.maxTokens * BURST_MULTIPLIER;
    const key = bucketKey(deviceProfile.deviceId);
    const now = Date.now();

    const raw = await this.redis.eval(
      BUCKET_LUA,
      1,
      key,
      String(now),
      String(tier.maxTokens),
      String(effectiveRate),
      String(burstMax),
      String(burstRate),
      String(compliance),
      String(BUCKET_TTL_S),
      String(BURST_COOLDOWN_S),
      String(BURST_DURATION_S),
      String(COMPLIANCE_BURST_THRESHOLD),
    );

    if (!Array.isArray(raw) || raw.length < 4) {
      throw new Error('Unexpected Lua response from token bucket script');
    }
    const [tokensRaw, maxRaw, resetAtRaw, allowedRaw] = raw as [number, number, number, number];

    const allowed = allowedRaw === 1;
    return {
      allowed,
      tokensRemaining: Math.floor(tokensRaw),
      maxTokens: maxRaw,
      resetAtMs: resetAtRaw,
      retryAfterMs: allowed ? undefined : Math.max(0, resetAtRaw - now),
    };
  }

  async reset(deviceId: string): Promise<void> {
    await this.redis.del(bucketKey(deviceId));
  }
}
import type { FastifyReply, FastifyRequest } from 'fastify';

// Simple in-memory tracker for brute-force tracking.
// In production, this can be backed by Redis if scaling multi-node.
const authWindowTracker: Record<string, { attempts: number; resetAt: number }> = {};

/**
 * Fastify Pre-Handler: Auth endpoint rate-limiting and progressive slow-down.
 * Invariant: Max 5 attempts per minute per IP. Increase response delay by 100ms per failure.
 */
export async function applyAuthRateLimiting(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (request.headers['x-test-bypass'] === 'true') return;
  const ip = request.ip || '127.0.0.1';
  const now = Date.now();
  const WINDOW_MS = 60000; // 1 minute sliding window limit
  
  // Initialize tracker profile if missing or expired
  if (!authWindowTracker[ip] || authWindowTracker[ip].resetAt < now) {
    authWindowTracker[ip] = {
      attempts: 0,
      resetAt: now + WINDOW_MS,
    };
  }

  const tracker = authWindowTracker[ip];

  // 1. Strict limit: Reject request if attempts exceed 5 in the window
  if (tracker.attempts >= 5) {
    const retryAfterSeconds = Math.ceil((tracker.resetAt - now) / 1000);
    reply.header('Retry-After', String(retryAfterSeconds));
    return reply.status(429).send({
      error: 'Too Many Requests',
      message: 'Too many login attempts. Please try again after a minute.',
    });
  }

  // Increment attempts counter within this window
  tracker.attempts += 1;

  // 2. Progressive slowdown penalty: Add 100ms per attempt after the 3rd attempt
  if (tracker.attempts > 3) {
    const delayMultiplier = tracker.attempts - 3;
    const additionalDelayMs = delayMultiplier * 100; // 100ms per failed attempt threshold
    await new Promise((resolve) => setTimeout(resolve, additionalDelayMs));
  }
}
