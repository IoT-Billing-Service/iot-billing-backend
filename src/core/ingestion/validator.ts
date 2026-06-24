import nacl from 'tweetnacl';
import { Buffer } from 'node:buffer';
import type { Redis } from 'ioredis';
import type { Span } from '@opentelemetry/api';
import { getDiagnosticsTracer } from '../diagnostics/tracer.js';
import { DOMAIN_TELEMETRY, TELEMETRY_DOMAIN_ATTR } from '../diagnostics/sampler.js';
import { refreshAggregatesAdaptively } from '../../database/pool_manager.js';
import { getConfig } from '../../config/index.js';
import { incrementConfigTransitionEvents } from '../../api/metrics/prometheus.js';

export interface SignedPayload {
  deviceId: string;
  timestamp: number;
  nonce: string;
  metrics: Record<string, number | string>;
  signature: string;
}

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

const NONCE_WINDOW_MS = 5000;

/**
 * Sliding-window replay guard. A nonce may only be consumed once within the
 * window; a second attempt to consume the same nonce is a replay.
 *
 * Implementations use compare-and-set (CAS) semantics: {@link tryConsume}
 * atomically claims the nonce and reports whether *this* call was the one that
 * claimed it. The return type is intentionally `boolean | Promise<boolean>` so
 * the in-process cache can stay synchronous on the hot path while the Redis
 * implementation (used for horizontal scaling) can be awaited.
 */
export interface NonceCache {
  /**
   * Atomically claim `nonce`. Returns `true` if the nonce was newly stored
   * (accept), `false` if it was already present within the window (replay).
   */
  tryConsume(nonce: string): boolean | Promise<boolean>;
}

/**
 * In-process {@link NonceCache} backed by a Map of nonce -> expiry timestamp.
 *
 * Suitable for single-instance deployments and tests. A periodic cleanup
 * interval evicts entries whose window has elapsed; this bounds memory and acts
 * as a clock-drift defense so a stuck clock cannot pin stale nonces forever.
 */
export class InMemoryNonceCache implements NonceCache {
  private readonly seen = new Map<string, number>();
  private readonly windowMs: number;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(windowMs: number = NONCE_WINDOW_MS) {
    this.windowMs = windowMs;
    this.cleanupTimer = setInterval(() => {
      this.prune();
    }, windowMs);
    // Do not keep the event loop alive purely for nonce cleanup.
    this.cleanupTimer.unref();
  }

  tryConsume(nonce: string): boolean {
    const now = Date.now();
    const expiresAt = this.seen.get(nonce);
    if (expiresAt !== undefined && expiresAt > now) {
      return false;
    }
    this.seen.set(nonce, now + this.windowMs);
    return true;
  }

  /** Evict nonces whose sliding window has elapsed. */
  private prune(): void {
    const now = Date.now();
    for (const [nonce, expiresAt] of this.seen) {
      if (expiresAt <= now) {
        this.seen.delete(nonce);
      }
    }
  }

  /** Stop the cleanup interval and drop all tracked nonces. */
  dispose(): void {
    clearInterval(this.cleanupTimer);
    this.seen.clear();
  }
}

/**
 * Distributed {@link NonceCache} backed by Redis, for horizontal scaling.
 *
 * Uses `SET <key> 1 EX <ttl> NX`, which atomically sets the key only if it does
 * not already exist and lets Redis expire it after the window. This gives the
 * required CAS replay semantics across every ingestion node sharing the same
 * Redis (see `REDIS_URL` in `src/config/env.ts`).
 */
export class RedisNonceCache implements NonceCache {
  private readonly redis: Redis;
  private readonly ttlSeconds: number;
  private readonly prefix: string;

  constructor(redis: Redis, opts: { windowMs?: number; prefix?: string } = {}) {
    this.redis = redis;
    this.ttlSeconds = Math.max(1, Math.ceil((opts.windowMs ?? NONCE_WINDOW_MS) / 1000));
    this.prefix = opts.prefix ?? 'nonce:';
  }

  async tryConsume(nonce: string): Promise<boolean> {
    const result = await this.redis.set(`${this.prefix}${nonce}`, '1', 'EX', this.ttlSeconds, 'NX');
    return result === 'OK';
  }
}

let validatedCount = 0;

export function getValidatedCount(): number {
  return validatedCount;
}

export function resetValidatedCount(): void {
  validatedCount = 0;
}

function incrementValidationCount(): void {
  validatedCount++;
  if (validatedCount >= 10000) {
    validatedCount = 0;
    void refreshAggregatesAdaptively().catch((err: unknown) => {
      console.error('Failed to trigger adaptive refresh from validator:', err);
    });
  }
}

/**
 * Run every check that does not touch the nonce cache: signature length,
 * timestamp sliding window, and the Ed25519 signature itself. Returns a
 * rejecting {@link ValidationResult} on failure, or `null` when the payload is
 * authentic and ready for the nonce-claim (replay) step.
 */
function verifyAuthenticity(
  span: Span,
  publicKey: Uint8Array,
  payload: SignedPayload,
): ValidationResult | null {
  const { signature, ...rest } = payload;
  const message = Buffer.from(JSON.stringify(rest), 'utf-8');
  const sigBytes = Buffer.from(signature, 'hex');

  if (sigBytes.length !== 64) {
    span.setAttribute('validation.result', 'invalid_signature_length');
    return { valid: false, reason: 'Invalid signature length' };
  }

  const now = Date.now();
  if (Math.abs(now - payload.timestamp) > NONCE_WINDOW_MS) {
    span.setAttribute('validation.result', 'stale_timestamp');
    return { valid: false, reason: 'Timestamp outside sliding window' };
  }

  const verified = nacl.sign.detached.verify(message, sigBytes, publicKey);
  if (!verified) {
    span.setAttribute('validation.result', 'signature_mismatch');
    return { valid: false, reason: 'Ed25519 signature mismatch' };
  }

  return null;
}

const REPLAY_RESULT: ValidationResult = {
  valid: false,
  reason: 'Nonce already consumed (replay detected)',
};

/**
 * Build an async validator backed by an injected {@link NonceCache}. This is
 * the production entry point: pair it with a {@link RedisNonceCache} so replay
 * protection holds across horizontally scaled ingestion nodes.
 */
export function createValidator(
  cache: NonceCache,
): (publicKey: Uint8Array, payload: SignedPayload) => Promise<ValidationResult> {
  const tracer = getDiagnosticsTracer();

  return (publicKey, payload) =>
    tracer.traceAsync(
      'ingestion.validateSignature',
      async (span) => {
        span.setAttributes({
          [TELEMETRY_DOMAIN_ATTR]: DOMAIN_TELEMETRY,
          'device.id': payload.deviceId,
          'payload.nonce': payload.nonce,
        });

        const rejection = verifyAuthenticity(span, publicKey, payload);
        if (rejection !== null) {
          return rejection;
        }

        // Atomically claim the nonce only after authenticity is proven, so a
        // forged payload can never burn a legitimate device's nonce.
        const claimed = await cache.tryConsume(payload.nonce);
        if (!claimed) {
          span.setAttribute('validation.result', 'replay_detected');
          return REPLAY_RESULT;
        }

        span.setAttribute('validation.result', 'valid');
        incrementValidationCount();
        return { valid: true };
      },
      { [TELEMETRY_DOMAIN_ATTR]: DOMAIN_TELEMETRY },
    );
}

// Default single-instance nonce cache used by the synchronous entry point.
const defaultNonceCache = new InMemoryNonceCache();

/**
 * Synchronous validator backed by the process-local {@link InMemoryNonceCache}.
 * Retained for the in-process hot path, tests, and load simulation. For
 * multi-node deployments use {@link createValidator} with {@link RedisNonceCache}.
 */
export function validateSignature(publicKey: Uint8Array, payload: SignedPayload): ValidationResult {
  const tracer = getDiagnosticsTracer();

  return tracer.traceSync(
    'ingestion.validateSignature',
    (span) => {
      span.setAttributes({
        [TELEMETRY_DOMAIN_ATTR]: DOMAIN_TELEMETRY,
        'device.id': payload.deviceId,
        'payload.nonce': payload.nonce,
      });

      const rejection = verifyAuthenticity(span, publicKey, payload);
      if (rejection !== null) {
        return rejection;
      }

      const claimed = defaultNonceCache.tryConsume(payload.nonce);
      if (!claimed) {
        span.setAttribute('validation.result', 'replay_detected');
        return REPLAY_RESULT;
      }

      span.setAttribute('validation.result', 'valid');
      incrementValidationCount();
      return { valid: true };
    },
    { [TELEMETRY_DOMAIN_ATTR]: DOMAIN_TELEMETRY },
  );
}

export interface ReorderBuffer {
  submit(deviceId: string, frameSeq: number, payload: SignedPayload): Promise<SignedPayload[]>;
  getDeliverCount(deviceId: string): Promise<number>;
}

export class RedisReorderBuffer implements ReorderBuffer {
  private redis: Redis;
  private maxWindow: number;

  constructor(redis: Redis, maxWindow = 256) {
    this.redis = redis;
    this.maxWindow = maxWindow;
  }

  async submit(
    deviceId: string,
    frameSeq: number,
    payload: SignedPayload,
  ): Promise<SignedPayload[]> {
    const deliveredKey = `reorder:delivered:${deviceId}`;
    const zsetKey = `reorder:buffer:${deviceId}`;
    const dropCountKey = `reorder:drops:${deviceId}`;

    // Get current delivered
    const currentDeliveredStr = await this.redis.get(deliveredKey);
    let currentDelivered = currentDeliveredStr != null ? parseInt(currentDeliveredStr, 10) : 0;

    if (frameSeq <= currentDelivered) {
      // Already delivered, drop
      return [];
    }

    if (frameSeq === currentDelivered + 1) {
      // In sequence, we can deliver it right away, and then check buffer for more.
      const delivered: SignedPayload[] = [payload];
      currentDelivered++;

      // Fetch contiguous frames from buffer
      let done = false;
      while (!done) {
        const nextFrames = await this.redis.zrangebyscore(
          zsetKey,
          currentDelivered + 1,
          currentDelivered + 1,
        );
        if (nextFrames.length > 0) {
          const frameStr = nextFrames[0] ?? '{}';
          delivered.push(JSON.parse(frameStr) as SignedPayload);
          await this.redis.zremrangebyscore(zsetKey, currentDelivered + 1, currentDelivered + 1);
          currentDelivered++;
        } else {
          done = true;
        }
      }

      await this.redis.set(deliveredKey, currentDelivered.toString());
      return delivered;
    } else {
      // Out of sequence. Add to ZSET.
      await this.redis.zadd(zsetKey, frameSeq, JSON.stringify(payload));

      // Check size and evict if > maxWindow
      const count = await this.redis.zcard(zsetKey);
      if (count > this.maxWindow) {
        // PRIORITY EVICTION: drop the LARGEST sequence (newest).
        // ZPOPMAX returns [member, score]
        const popped = await this.redis.zpopmax(zsetKey);
        if (popped.length > 0) {
          await this.redis.incr(dropCountKey);
        }
      }
      return [];
    }
  }

  async getDeliverCount(deviceId: string): Promise<number> {
    const val = await this.redis.get(`reorder:delivered:${deviceId}`);
    return val != null ? parseInt(val, 10) : 0;
  }
}

export interface TelemetryEvent {
  deviceId: string;
  value: number;
}

export interface ProcessedEvent {
  deviceId: string;
  value: number;
  tier: string;
}

export interface BatchProcessingResult {
  versionId: string;
  results: ProcessedEvent[];
}

export function applyTier(value: number, configVersionId: string): string {
  const config = getConfig(configVersionId);
  for (const [tierName, range] of Object.entries(config.tiers)) {
    if (value >= range.min && value <= range.max) {
      return tierName;
    }
  }
  return 'UNKNOWN_TIER';
}

export async function processBatch(
  events: TelemetryEvent[],
  simulateDelayMs = 0,
): Promise<BatchProcessingResult> {
  for (;;) {
    const startConfig = getConfig();
    const capturedVersion = startConfig.version_id;

    const results: ProcessedEvent[] = [];
    for (const event of events) {
      const tier = applyTier(event.value, capturedVersion);
      results.push({
        deviceId: event.deviceId,
        value: event.value,
        tier,
      });

      if (simulateDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, simulateDelayMs));
      }
    }

    const endConfig = getConfig();
    const currentVersion = endConfig.version_id;

    if (capturedVersion !== currentVersion) {
      // Overlap detected! Increment transition event gauge and re-process the batch.
      incrementConfigTransitionEvents(capturedVersion, currentVersion);
      continue;
    }

    return {
      versionId: capturedVersion,
      results,
    };
  }
}
