import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { LedgerGapDetector, type LedgerGap } from '../../src/core/ingestion/backpressure.js';
import { LedgerEventBus } from '../../src/core/blockchain/ledger_event_bus.js';
import { redisPubsubMessagesLost } from '../../src/api/metrics/prometheus.js';

// ─── In-memory Redis Streams fake ──────────────────────────────────────────
// Implements just enough of XADD/XGROUP/XREADGROUP/XACK/XPENDING for the bus.

interface StoredEntry {
  id: string;
  fields: string[];
}

class FakeRedisStream {
  private entries: StoredEntry[] = [];
  private seqCounter = 0;
  private groupCreated = false;
  private lastDelivered = '0';
  private pending = new Set<string>();

  xadd = vi.fn((..._args: unknown[]): Promise<string> => {
    const args = _args as string[];
    // [key, 'MAXLEN', '~', maxlen, '*', ...fields]
    const fields = args.slice(5);
    const id = `${String(Date.now())}-${String(this.seqCounter++)}`;
    this.entries.push({ id, fields });
    return Promise.resolve(id);
  });

  xgroup = vi.fn((..._args: unknown[]): Promise<string> => {
    if (this.groupCreated) {
      return Promise.reject(new Error('BUSYGROUP Consumer Group name already exists'));
    }
    this.groupCreated = true;
    return Promise.resolve('OK');
  });

  xreadgroup = vi.fn((..._args: unknown[]): Promise<unknown> => {
    const args = _args.map(String);
    const streamsIdx = args.indexOf('STREAMS');
    const cursor = args[streamsIdx + 2];
    let selected: StoredEntry[];
    if (cursor === '0') {
      // pending entries for this consumer
      selected = this.entries.filter((e) => this.pending.has(e.id));
    } else {
      // new entries after lastDelivered
      const idx = this.entries.findIndex((e) => e.id > this.lastDelivered);
      selected = idx === -1 ? [] : this.entries.slice(idx);
      for (const e of selected) {
        this.pending.add(e.id);
        this.lastDelivered = e.id;
      }
    }
    if (selected.length === 0) return Promise.resolve(null);
    const reply = [['billing:events', selected.map((e) => [e.id, e.fields])]];
    return Promise.resolve(reply);
  });

  xack = vi.fn((..._args: unknown[]): Promise<number> => {
    const ids = (_args as string[]).slice(2);
    let acked = 0;
    for (const id of ids) {
      if (this.pending.delete(id)) acked++;
    }
    return Promise.resolve(acked);
  });

  xpending = vi.fn((): Promise<unknown> => {
    return Promise.resolve([this.pending.size, '0', '0', null]);
  });

  /** Simulate a failover: events arrive but the prior delivery cursor is lost. */
  injectRaw(fields: string[]): void {
    const id = `${String(Date.now())}-${String(this.seqCounter++)}`;
    this.entries.push({ id, fields });
  }
}

function makeBus(fake: FakeRedisStream, onGap?: (g: LedgerGap) => void): LedgerEventBus {
  return new LedgerEventBus(fake as unknown as Redis, { onGap });
}

// ─── LedgerGapDetector ─────────────────────────────────────────────────────

describe('LedgerGapDetector', () => {
  it('returns null for the first observed sequence', () => {
    const d = new LedgerGapDetector();
    expect(d.record(10)).toBeNull();
    expect(d.getLastSeq()).toBe(10);
  });

  it('returns null for a contiguous sequence', () => {
    const d = new LedgerGapDetector();
    d.record(10);
    expect(d.record(11)).toBeNull();
    expect(d.record(12)).toBeNull();
  });

  it('detects and emits a forward gap', () => {
    const d = new LedgerGapDetector();
    const seen: LedgerGap[] = [];
    d.on('LedgerGapDetected', (g: LedgerGap) => seen.push(g));
    d.record(10);
    const gap: LedgerGap | null = d.record(14);
    expect(gap).toEqual({ expectedSeq: 11, observedSeq: 14, missingCount: 3 });
    expect(seen).toHaveLength(1);
    expect(d.getLastSeq()).toBe(14);
  });

  it('ignores duplicates and out-of-order replays', () => {
    const d = new LedgerGapDetector();
    d.record(10);
    d.record(11);
    expect(d.record(11)).toBeNull();
    expect(d.record(9)).toBeNull();
    expect(d.getLastSeq()).toBe(11);
  });

  it('reset clears tracking', () => {
    const d = new LedgerGapDetector();
    d.record(10);
    d.reset();
    expect(d.getLastSeq()).toBeNull();
    expect(d.record(99)).toBeNull();
  });
});

// ─── LedgerEventBus ────────────────────────────────────────────────────────

describe('LedgerEventBus', () => {
  let fake: FakeRedisStream;

  beforeEach(() => {
    fake = new FakeRedisStream();
  });

  it('publishes events with seq and payload fields', async () => {
    const bus = makeBus(fake);
    await bus.publish({ sequence: 1, payload: { hash: 'h1' } });
    expect(fake.xadd).toHaveBeenCalledTimes(1);
    const args = fake.xadd.mock.calls[0] as unknown as string[];
    expect(args).toContain('MAXLEN');
    expect(args).toContain('seq');
    expect(args).toContain('h1');
  });

  it('ensureGroup is idempotent across BUSYGROUP', async () => {
    const bus = makeBus(fake);
    await bus.ensureGroup();
    await bus.ensureGroup();
    // Second call short-circuits via the groupReady flag (only one xgroup call).
    expect(fake.xgroup).toHaveBeenCalledTimes(1);
  });

  it('consumes published events in order and tracks sequence', async () => {
    const bus = makeBus(fake);
    await bus.publish({ sequence: 1, payload: { hash: 'h1' } });
    await bus.publish({ sequence: 2, payload: { hash: 'h2' } });

    const delivered = await bus.consume('consumer_1', { blockMs: 0 });
    expect(delivered.map((d) => d.event.sequence)).toEqual([1, 2]);
    expect(delivered[0]?.event.payload).toEqual({ hash: 'h1' });
    expect(bus.getLastSeq()).toBe(2);
  });

  it('re-delivers pending entries on reconnect (no loss across failover)', async () => {
    const bus = makeBus(fake);
    await bus.publish({ sequence: 1, payload: { hash: 'h1' } });
    const first = await bus.consume('consumer_1', { blockMs: 0 });
    expect(first).toHaveLength(1);

    // Consumer crashed before ack: a fresh consume drains the pending list.
    const replay = await bus.consume('consumer_1', { blockMs: 0 });
    expect(replay.map((d) => d.event.sequence)).toEqual([1]);
    expect(await bus.pendingCount()).toBe(1);

    await bus.ack(replay.map((d) => d.id));
    expect(await bus.pendingCount()).toBe(0);
  });

  it('detects a sequence gap and increments the loss counter', async () => {
    const gaps: LedgerGap[] = [];
    const bus = makeBus(fake, (g) => gaps.push(g));
    const before = await getCounter('billing:events');

    // Stream skips sequence 2 and 3 (lost during failover window).
    await bus.publish({ sequence: 1, payload: {} });
    await bus.publish({ sequence: 4, payload: {} });

    await bus.consume('consumer_1', { blockMs: 0 });

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ expectedSeq: 2, observedSeq: 4, missingCount: 2 });
    const after = await getCounter('billing:events');
    expect(after - before).toBe(2);
  });
});

async function getCounter(stream: string): Promise<number> {
  const metrics = await redisPubsubMessagesLost.get();
  const sample = metrics.values.find((v) => v.labels['stream'] === stream);
  return sample?.value ?? 0;
}
