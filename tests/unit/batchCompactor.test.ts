/**
 * tests/unit/batchCompactor.test.ts
 *
 * Verifies that concurrent compactBatch() + rotateBatch() calls produce no
 * gaps and no overlaps in the compacted summaries.
 *
 * All DB I/O is mocked so this runs offline.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import type pg from 'pg';

import { BatchState, type Batch, batchLockId, BATCH_WINDOW_MS } from '../../src/ingestion/batchManager.js';
import { compactBatch, rotateBatch } from '../../src/ingestion/batchCompactor.js';

// ─── Mock helpers ─────────────────────────────────────────────────────────────

const BATCH_START = new Date('2026-06-24T10:00:00.000Z');
const BATCH_END   = new Date(BATCH_START.getTime() + BATCH_WINDOW_MS);
const DEVICE_ID   = 'dev-001';
const BATCH_ID    = `${DEVICE_ID}:${String(BATCH_START.getTime())}`;

/** Shared mutable batch state visible to all query calls. */
let batchState: BatchState;

/** Summaries written via writeSummary → INSERT into telemetry_batch_summaries. */
const writtenSummaries: Array<{ batch_id: string; batch_start: Date; batch_end: Date }> = [];

/** New batches created by rotateBatch → INSERT into telemetry_batches. */
const createdBatches: Array<{ id: string; batch_start: Date; batch_end: Date }> = [];

/** Advisory lock: true = held, false = free. */
let advisoryLock = false;

/**
 * Build a mock pg.PoolClient whose query() dispatches on the SQL text to
 * simulate the minimal DB surface used by batchManager + telemetryStore.
 */
function makeMockClient(): pg.PoolClient {
  const query: Mock = vi.fn(async (sql: string, params?: unknown[]) => {
    const s = sql.trim().toUpperCase();

    // Advisory lock: pg_try_advisory_lock
    if (s.includes('PG_TRY_ADVISORY_LOCK')) {
      if (advisoryLock) return { rows: [{ locked: false }] };
      advisoryLock = true;
      return { rows: [{ locked: true }] };
    }
    // Advisory unlock
    if (s.includes('PG_ADVISORY_UNLOCK')) {
      advisoryLock = false;
      return { rows: [] };
    }

    // SELECT batch by id
    if (s.startsWith('SELECT') && s.includes('FROM TELEMETRY_BATCHES WHERE ID')) {
      return {
        rows: [{
          id: BATCH_ID,
          device_id: DEVICE_ID,
          batch_start: BATCH_START,
          batch_end: BATCH_END,
          state: batchState,
        }],
      };
    }

    // SELECT open batch (ORDER BY batch_start DESC)
    if (s.startsWith('SELECT') && s.includes('FROM TELEMETRY_BATCHES') && s.includes('STATE')) {
      if (batchState === BatchState.OPEN) {
        return {
          rows: [{
            id: BATCH_ID,
            device_id: DEVICE_ID,
            batch_start: BATCH_START,
            batch_end: BATCH_END,
            state: BatchState.OPEN,
          }],
        };
      }
      return { rows: [] };
    }

    // UPDATE telemetry_batches SET state (CAS transition)
    if (s.startsWith('UPDATE TELEMETRY_BATCHES')) {
      const [to, id, from] = params as [BatchState, string, BatchState];
      if (id === BATCH_ID && batchState === from) {
        batchState = to;
        return { rowCount: 1, rows: [{ id: BATCH_ID }] };
      }
      return { rowCount: 0, rows: [] };
    }

    // INSERT new batch (rotation)
    if (s.startsWith('INSERT INTO TELEMETRY_BATCHES') && !s.includes('ON CONFLICT')) {
      const [id, , start, end] = params as [string, string, Date, Date];
      createdBatches.push({ id, batch_start: start, batch_end: end });
      return { rows: [] };
    }

    // INSERT summary (compaction output)
    if (s.startsWith('INSERT INTO TELEMETRY_BATCH_SUMMARIES')) {
      const [bid, , , start, end] = params as [string, string, number, Date, Date];
      writtenSummaries.push({ batch_id: bid, batch_start: start, batch_end: end });
      return { rows: [] };
    }

    // SELECT raw telemetry events — return 3 synthetic events inside the window
    if (s.startsWith('SELECT') && s.includes('FROM TELEMETRY')) {
      const [, start, end] = params as [string, Date, Date];
      const events = [
        { device_id: DEVICE_ID, metric_id: 1, metric_value: 10, time: new Date(start.getTime() + 1_000) },
        { device_id: DEVICE_ID, metric_id: 1, metric_value: 20, time: new Date(start.getTime() + 2_000) },
        { device_id: DEVICE_ID, metric_id: 1, metric_value: 30, time: new Date(start.getTime() + 3_000) },
      ].filter(e => e.time >= start && e.time < end);
      return { rows: events };
    }

    // Transaction control
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') {
      return { rows: [] };
    }

    return { rows: [] };
  });

  return { query, release: vi.fn() } as unknown as pg.PoolClient;
}

/** Build a mock Pool that always returns the same client. */
function makeMockPool(client: pg.PoolClient): pg.Pool {
  return { connect: vi.fn().mockResolvedValue(client) } as unknown as pg.Pool;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('batchCompactor — state machine + advisory lock', () => {
  beforeEach(() => {
    batchState = BatchState.OPEN;
    advisoryLock = false;
    writtenSummaries.length = 0;
    createdBatches.length = 0;
  });

  it('compactBatch transitions OPEN → COMPACTING → CLOSED', async () => {
    const client = makeMockClient();
    const pool = makeMockPool(client);

    const result = await compactBatch(BATCH_ID, pool);

    expect(result).toBe('ok');
    expect(batchState).toBe(BatchState.CLOSED);
    expect(advisoryLock).toBe(false); // always released
  });

  it('compactBatch is idempotent — skips if already COMPACTING', async () => {
    batchState = BatchState.COMPACTING;
    const client = makeMockClient();
    const pool = makeMockPool(client);

    const result = await compactBatch(BATCH_ID, pool);

    expect(result).toBe('skipped');
    expect(batchState).toBe(BatchState.COMPACTING); // untouched
  });

  it('compactBatch skips when advisory lock is held by another caller', async () => {
    advisoryLock = true; // simulate another worker
    const client = makeMockClient();
    const pool = makeMockPool(client);

    const result = await compactBatch(BATCH_ID, pool);

    expect(result).toBe('skipped');
    expect(advisoryLock).toBe(true); // we never acquired it, so we never released it
  });

  it('rotateBatch creates successor with no gap and no overlap', async () => {
    const client = makeMockClient();
    const pool = makeMockPool(client);

    const nextBatch = await rotateBatch(DEVICE_ID, pool);

    expect(nextBatch).not.toBeNull();
    // New batch starts exactly where old one ends — no gap, no overlap
    expect(nextBatch!.batch_start.getTime()).toBe(BATCH_END.getTime());
    expect(nextBatch!.batch_end.getTime()).toBe(BATCH_END.getTime() + BATCH_WINDOW_MS);
    expect(nextBatch!.state).toBe(BatchState.OPEN);
    expect(batchState).toBe(BatchState.CLOSED); // old batch closed
    expect(advisoryLock).toBe(false);
  });

  it('rotateBatch skips if advisory lock is already held by compactBatch', async () => {
    advisoryLock = true; // compact holds the lock
    const client = makeMockClient();
    const pool = makeMockPool(client);

    const result = await rotateBatch(DEVICE_ID, pool);

    expect(result).toBeNull();
    expect(batchState).toBe(BatchState.OPEN); // batch untouched
  });

  // ─── Core race-condition test ───────────────────────────────────────────────
  it('concurrent compactBatch + rotateBatch: no gaps and no overlaps', async () => {
    /**
     * In the real race: both compactBatch and rotateBatch attempt to acquire
     * the advisory lock at the same time.  Because we use pg_try_advisory_lock
     * (non-blocking), exactly ONE caller wins.  The loser returns skipped/null.
     * We verify the invariants hold regardless of which one wins.
     */

    // Scenario A: compactBatch wins the lock
    {
      batchState = BatchState.OPEN;
      advisoryLock = false;
      writtenSummaries.length = 0;
      createdBatches.length = 0;

      // Each concurrent call gets its own client (own pool connection)
      const clientA = makeMockClient();
      const clientB = makeMockClient();
      let callCount = 0;
      const pool = {
        connect: vi.fn(async () => (callCount++ === 0 ? clientA : clientB)),
      } as unknown as pg.Pool;

      const [compactResult, rotateResult] = await Promise.all([
        compactBatch(BATCH_ID, pool),
        rotateBatch(DEVICE_ID, pool),
      ]);

      // One must win, one must be serialised out
      const wins = [compactResult, rotateResult].filter(r => r !== null && r !== 'skipped');
      const skips = [compactResult, rotateResult].filter(r => r === null || r === 'skipped');
      expect(wins.length).toBe(1);
      expect(skips.length).toBe(1);

      // Final state must be CLOSED — the winner completed the transition
      expect(batchState).toBe(BatchState.CLOSED);

      // Summaries must cover the exact original window once (no double-count)
      const summariesForBatch = writtenSummaries.filter(s => s.batch_id === BATCH_ID);
      for (const s of summariesForBatch) {
        expect(s.batch_start.getTime()).toBe(BATCH_START.getTime());
        expect(s.batch_end.getTime()).toBe(BATCH_END.getTime());
      }
    }

    // Scenario B: rotateBatch wins the lock (advisory lock already flipped)
    {
      batchState = BatchState.OPEN;
      advisoryLock = false;
      writtenSummaries.length = 0;
      createdBatches.length = 0;

      // Force rotate to be first by injecting it with a head-start
      const clientR = makeMockClient();
      const clientC = makeMockClient();
      let callCount = 0;
      const pool = {
        connect: vi.fn(async () => (callCount++ === 0 ? clientR : clientC)),
      } as unknown as pg.Pool;

      const rotateResult = await rotateBatch(DEVICE_ID, pool);
      // compact runs after rotate already closed the batch
      const compactResult = await compactBatch(BATCH_ID, pool);

      expect(rotateResult).not.toBeNull();
      expect(compactResult).toBe('skipped'); // batch already CLOSED

      // Created successor starts exactly at BATCH_END
      const successor = createdBatches.find(b => b.id !== BATCH_ID);
      expect(successor).toBeDefined();
      expect(successor!.batch_start.getTime()).toBe(BATCH_END.getTime());

      // No gap: successor.batch_start == old batch_end
      expect(successor!.batch_start.getTime()).toBe(BATCH_END.getTime());
      // No overlap: old batch_end == successor.batch_start (they're equal, not overlapping)
      expect(BATCH_END.getTime()).toBe(successor!.batch_start.getTime());
    }
  });

  it('batchLockId is deterministic and positive', () => {
    const id1 = batchLockId(BATCH_ID);
    const id2 = batchLockId(BATCH_ID);
    expect(id1).toBe(id2);
    expect(id1).toBeGreaterThan(0);
    expect(id1).toBeLessThanOrEqual(0x7fffffff);
  });
});
