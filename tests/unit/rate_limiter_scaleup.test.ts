/**
 * HPA scale-up consistency test for the rate limiter (issue #50, item 5).
 *
 * The production limiter keeps ALL token-bucket state in Redis (an atomic
 * server-side Lua script), so a request's decision depends only on the
 * device's recent usage — never on which pod handled it. This test encodes
 * that invariant directly:
 *
 *   - "6 pods" = six `DynamicRateLimiter` instances. When they share one Redis
 *     (production), routing a device's requests round-robin across all six
 *     yields EXACTLY the same decisions as a single pod handling them all.
 *   - As a negative control, six pods each with their OWN store (the old
 *     per-pod in-memory bug the issue describes) diverge massively — every
 *     pod hands the device a fresh bucket, so far more requests are wrongly
 *     allowed.
 *
 * `FakeBucketRedis.eval` is a faithful in-process port of BUCKET_LUA operating
 * on a plain Map, so the test is deterministic and needs no live Redis. The
 * production path runs the real Lua against real Redis; the double exists only
 * to exercise shared-vs-isolated state behaviour in a unit test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { DynamicRateLimiter, type DeviceProfile } from '../../src/api/middleware/rate_limiter.js';

interface BucketState {
  tokens: number;
  lastRefill: number;
  burstAt: number;
}

/** In-process token-bucket store mirroring BUCKET_LUA, backed by a shared Map. */
class FakeBucketRedis {
  constructor(private readonly store: Map<string, BucketState>) {}

  // Only `eval` (the bucket script) is exercised by checkLimit in this test.
  eval(_script: string, _numKeys: number, key: string, ...argv: string[]): Promise<number[]> {
    const nums = argv.map(Number);
    const nowMs = nums[0] ?? 0;
    const normalMax = nums[1] ?? 0;
    const normalRate = nums[2] ?? 0;
    const burstMax = nums[3] ?? 0;
    const burstRate = nums[4] ?? 0;
    const compliance = nums[5] ?? 0;
    // nums[6] is the TTL, irrelevant to this in-process double.
    const burstCooldownS = nums[7] ?? 0;
    const burstDurationS = nums[8] ?? 0;
    const burstThreshold = nums[9] ?? 0;

    const nowS = nowMs / 1000;
    const existing = this.store.get(key);
    let tokens = existing?.tokens;
    let lastRefill = existing?.lastRefill;
    let burstAt = existing?.burstAt ?? 0;

    let inBurst = burstAt > 0 && nowS - burstAt < burstDurationS;
    const canBurst =
      compliance > burstThreshold && (burstAt === 0 || nowS - burstAt >= burstCooldownS);
    if (canBurst && !inBurst) {
      burstAt = nowS;
      inBurst = true;
    }

    const effectiveMax = inBurst ? burstMax : normalMax;
    const effectiveRate = inBurst ? burstRate : normalRate;

    if (tokens === undefined || lastRefill === undefined) {
      tokens = effectiveMax;
      lastRefill = nowMs;
    }

    const elapsed = (nowMs - lastRefill) / 1000;
    tokens = Math.min(effectiveMax, tokens + elapsed * effectiveRate);
    lastRefill = nowMs;

    let allowed = 0;
    if (tokens >= 1) {
      tokens -= 1;
      allowed = 1;
    }

    let resetAtMs = nowMs;
    if (effectiveRate > 0 && tokens < 1) {
      resetAtMs = nowMs + Math.ceil(((1 - tokens) / effectiveRate) * 1000);
    }

    this.store.set(key, { tokens, lastRefill, burstAt });
    return Promise.resolve([tokens, effectiveMax, resetAtMs, allowed]);
  }
}

function makePod(store: Map<string, BucketState>): DynamicRateLimiter {
  return new DynamicRateLimiter(new FakeBucketRedis(store) as unknown as Redis);
}

function profile(deviceId: string): DeviceProfile {
  return {
    deviceId,
    billingTier: 'standard', // maxTokens 100, baseRate 100
    historicalCompliance: 0.5, // below burst threshold -> deterministic, no burst
    currentBalance: 100n,
  };
}

/** Run an ordered request sequence and return one allow/deny bit per request. */
async function runSequence(
  pods: DynamicRateLimiter[],
  requests: { deviceId: string }[],
): Promise<boolean[]> {
  const decisions: boolean[] = [];
  let i = 0;
  for (const req of requests) {
    const pod = pods[i % pods.length];
    i++;
    if (pod === undefined) continue;
    const result = await pod.checkLimit(profile(req.deviceId));
    decisions.push(result.allowed);
  }
  return decisions;
}

function divergenceFraction(a: boolean[], b: boolean[]): number {
  const n = Math.min(a.length, b.length);
  let differing = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) differing++;
  }
  return n === 0 ? 0 : differing / n;
}

describe('rate limiter HPA scale-up consistency (issue #50)', () => {
  const DEVICES = 1000;
  const POD_COUNT = 6; // HPA scaled 2 -> 6 replicas
  // standard tier bucket cap is 100; a burst past it forces denials so the
  // test exercises BOTH the allowed and the rate-limited decision paths.
  const BURST_PER_DEVICE = 120;

  beforeEach(() => {
    // Freeze time so refill is deterministic across every checkLimit call.
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Deterministic, routing-order-independent request list: each device fires a
  // BURST_PER_DEVICE burst, interleaved device-by-device so the round-robin pod
  // assignment (index % POD_COUNT) spreads each device's events across pods.
  function buildBurstRequests(devices: number): { deviceId: string }[] {
    const reqs: { deviceId: string }[] = [];
    for (let r = 0; r < BURST_PER_DEVICE; r++) {
      for (let d = 0; d < devices; d++) {
        reqs.push({ deviceId: `device-${String(d)}` });
      }
    }
    return reqs;
  }

  it('6 pods sharing Redis match a single pod within 1% (invariant holds)', async () => {
    const requests = buildBurstRequests(DEVICES);

    const sharedStore = new Map<string, BucketState>();
    const sixPods = Array.from({ length: POD_COUNT }, () => makePod(sharedStore));
    const sixPodDecisions = await runSequence(sixPods, requests);

    const baselineStore = new Map<string, BucketState>();
    const onePodDecisions = await runSequence([makePod(baselineStore)], requests);

    // The scenario must actually exercise both outcomes, else "consistent"
    // would be vacuously true.
    expect(onePodDecisions).toContain(true);
    expect(onePodDecisions).toContain(false);

    const divergence = divergenceFraction(sixPodDecisions, onePodDecisions);
    expect(divergence).toBeLessThan(0.01);
    expect(divergence).toBe(0); // shared state => decisions are exactly identical
  }, 30_000);

  it('negative control: 6 pods with isolated state drift far beyond 1%', async () => {
    // Fewer devices keeps the call count modest; each still bursts past the cap.
    const requests = buildBurstRequests(50);

    const sharedStore = new Map<string, BucketState>();
    const sharedDecisions = await runSequence(
      Array.from({ length: POD_COUNT }, () => makePod(sharedStore)),
      requests,
    );

    // Old bug: each pod keeps its own bucket, so a device routed round-robin
    // gets POD_COUNT fresh buckets and is wrongly allowed far more often.
    const isolatedPods = Array.from({ length: POD_COUNT }, () =>
      makePod(new Map<string, BucketState>()),
    );
    const isolatedDecisions = await runSequence(isolatedPods, requests);

    const divergence = divergenceFraction(isolatedDecisions, sharedDecisions);
    expect(divergence).toBeGreaterThan(0.01);
    const sharedAllowed = sharedDecisions.filter(Boolean).length;
    const isolatedAllowed = isolatedDecisions.filter(Boolean).length;
    expect(isolatedAllowed).toBeGreaterThan(sharedAllowed);
  }, 30_000);
});
