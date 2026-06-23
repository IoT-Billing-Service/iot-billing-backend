import type { Redis } from 'ioredis';
import { getRedis } from '../../database/redis.js';
import { recordRateLimiterRedisHit } from '../metrics/prometheus.js';

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
    // Every decision is resolved against shared Redis state — record it so the
    // pod-agnostic limiter's Redis load is observable as replicas scale.
    recordRateLimiterRedisHit(allowed ? 'allowed' : 'denied');
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
