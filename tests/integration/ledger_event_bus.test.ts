import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Redis } from 'ioredis';
import { LedgerEventBus } from '../../src/core/blockchain/ledger_event_bus.js';

// Sentinel-failover regression test for issue #48.
//
// Self-skips unless a Redis instance is reachable so it stays green in CI
// environments without Redis (mirrors the DB gating in lock_manager.test.ts).
// When Redis is available it proves the durability invariant: events published
// while no consumer is connected (the failover window) are NOT lost — they are
// persisted in the stream and drained once a consumer reconnects.

const REDIS_URL: string | undefined =
  process.env['INTEGRATION_REDIS_URL'] ?? process.env['REDIS_URL'];

let redis: Redis | null = null;
let redisAvailable = false;
const streamKey = `billing:events:test:${String(Date.now())}`;

beforeAll(async () => {
  if (REDIS_URL == null) return;
  try {
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
    await redis.connect();
    await redis.ping();
    redisAvailable = true;
  } catch {
    redisAvailable = false;
  }
});

afterAll(async () => {
  if (redis && redisAvailable) {
    try {
      await redis.del(streamKey);
    } catch {
      /* ignore cleanup errors */
    }
    await redis.quit();
  }
});

describe('LedgerEventBus sentinel failover', () => {
  it('loses zero events published while no consumer is connected', async () => {
    if (!redisAvailable || !redis) return;
    const bus = new LedgerEventBus(redis, { streamKey });
    await bus.ensureGroup();

    // Simulate the 1-3s failover window: 60 events published, no live consumer.
    const total = 60;
    for (let seq = 1; seq <= total; seq++) {
      await bus.publish({ sequence: seq, payload: { hash: `h${String(seq)}` } });
    }

    // Consumer reconnects after failover and drains the backlog.
    const received: number[] = [];
    for (let i = 0; i < 5 && received.length < total; i++) {
      const batch = await bus.consume('consumer_1', { count: total, blockMs: 50 });
      for (const d of batch) {
        received.push(d.event.sequence);
      }
      await bus.ack(batch.map((d) => d.id));
    }

    received.sort((a, b) => a - b);
    expect(received).toHaveLength(total);
    expect(received[0]).toBe(1);
    expect(received[total - 1]).toBe(total);
    // Continuous range invariant: [1, total] with no holes.
    const contiguous = received.every((v, i) => v === i + 1);
    expect(contiguous).toBe(true);
    expect(await bus.pendingCount()).toBe(0);
  }, 20000);
});
