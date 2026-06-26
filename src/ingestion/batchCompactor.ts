import pg from 'pg';
import { getTimescalePool } from '../database/pool_manager.js';
import {
  BATCH_WINDOW_MS,
  BatchState,
  type Batch,
  createBatch,
  getBatch,
  getOpenBatch,
  transitionBatchState,
  tryAcquireBatchLock,
  releaseBatchLock,
} from './batchManager.js';
import { readRawEvents, writeSummary, type TelemetrySummary } from './telemetryStore.js';

function newBatchId(deviceId: string, startEpoch: number): string {
  return `${deviceId}:${String(startEpoch)}`;
}

/**
 * Compact a batch that is already in COMPACTING state (caller holds advisory
 * lock and has already done the OPEN → COMPACTING transition).
 *
 * Reads events strictly within [batch.batch_start, batch.batch_end) — the
 * boundary is immutable once the batch is created, so this read is safe
 * regardless of where rotation is in its lifecycle.
 */
async function doCompact(client: pg.PoolClient, batch: Batch): Promise<void> {
  const events = await readRawEvents(client, batch.device_id, batch.batch_start, batch.batch_end);
  if (events.length === 0) return;

  // Group by metric_id
  const byMetric = new Map<number, number[]>();
  for (const e of events) {
    const vals = byMetric.get(e.metric_id) ?? [];
    vals.push(e.metric_value);
    byMetric.set(e.metric_id, vals);
  }

  for (const [metric_id, vals] of byMetric) {
    const min_value = Math.min(...vals);
    const max_value = Math.max(...vals);
    const sum_value = vals.reduce((a, b) => a + b, 0);
    const avg_value = sum_value / vals.length;

    const summary: TelemetrySummary = {
      batch_id: batch.id,
      device_id: batch.device_id,
      metric_id,
      batch_start: batch.batch_start,
      batch_end: batch.batch_end,
      min_value,
      max_value,
      avg_value,
      sum_value,
      event_count: vals.length,
    };
    await writeSummary(client, summary);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compact a specific batch by ID.
 *
 * Race-condition fix:
 * 1. Acquire advisory lock keyed by batch ID (serialises with rotateBatch).
 * 2. Transition OPEN → COMPACTING atomically in the DB (CAS).
 *    If the batch is not OPEN (already COMPACTING or CLOSED) we bail out —
 *    another worker has it.
 * 3. Read events using the immutable [batch_start, batch_end) boundary.
 * 4. Write summary with ON CONFLICT DO NOTHING (idempotent).
 * 5. Transition COMPACTING → CLOSED.
 * 6. Release advisory lock.
 *
 * rotateBatch() refuses to close a batch unless it is OPEN, so it will never
 * interfere with a compaction in progress.
 */
export async function compactBatch(batchId: string, pool?: pg.Pool): Promise<'ok' | 'skipped'> {
  const p = pool ?? getTimescalePool();
  const client = await p.connect();
  try {
    const locked = await tryAcquireBatchLock(client, batchId);
    if (!locked) return 'skipped';

    try {
      const batch = await getBatch(client, batchId);
      if (batch?.state !== BatchState.OPEN) return 'skipped';

      const moved = await transitionBatchState(
        client,
        batchId,
        BatchState.OPEN,
        BatchState.COMPACTING,
      );
      if (!moved) return 'skipped'; // another worker raced in

      await doCompact(client, batch);

      await transitionBatchState(client, batchId, BatchState.COMPACTING, BatchState.CLOSED);
      return 'ok';
    } finally {
      await releaseBatchLock(client, batchId);
    }
  } finally {
    client.release();
  }
}

/**
 * Close the current OPEN batch and create the next one atomically.
 *
 * Race-condition fix:
 * 1. Acquire advisory lock keyed by batch ID.
 * 2. Re-read state under the lock — bail if already COMPACTING or CLOSED.
 *    This prevents rotation from racing an in-progress compaction.
 * 3. The new batch's start == old batch's end, guaranteeing zero overlap and
 *    zero gap regardless of wall-clock drift.
 * 4. Release advisory lock.
 */
export async function rotateBatch(deviceId: string, pool?: pg.Pool): Promise<Batch | null> {
  const p = pool ?? getTimescalePool();
  const client = await p.connect();
  try {
    const current = await getOpenBatch(client, deviceId);
    if (!current) return null;

    const locked = await tryAcquireBatchLock(client, current.id);
    if (!locked) return null; // compaction holds the lock; skip rotation

    try {
      // Re-read state under lock to guard against a compactBatch() that snuck
      // in between getOpenBatch and tryAcquireBatchLock.
      const fresh = await getBatch(client, current.id);
      if (fresh?.state !== BatchState.OPEN) return null;

      // The new batch starts exactly where the old one ends — no gap, no overlap.
      const newStart = current.batch_end;
      const newEnd = new Date(newStart.getTime() + BATCH_WINDOW_MS);
      const newId = newBatchId(deviceId, newStart.getTime());

      const nextBatch: Batch = {
        id: newId,
        device_id: deviceId,
        batch_start: newStart,
        batch_end: newEnd,
        state: BatchState.OPEN,
      };

      // Mark old batch COMPACTING so it can be finalised by compactBatch() and
      // create the successor in a single transaction.
      await client.query('BEGIN');
      try {
        const moved = await transitionBatchState(
          client,
          current.id,
          BatchState.OPEN,
          BatchState.COMPACTING,
        );
        if (!moved) {
          await client.query('ROLLBACK');
          return null;
        }
        await createBatch(client, nextBatch);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }

      // Now finish compacting the old batch (still under the advisory lock on old id).
      const oldBatch: Batch = { ...current, state: BatchState.COMPACTING };
      await doCompact(client, oldBatch);
      await transitionBatchState(client, current.id, BatchState.COMPACTING, BatchState.CLOSED);

      return nextBatch;
    } finally {
      await releaseBatchLock(client, current.id);
    }
  } finally {
    client.release();
  }
}

/**
 * Ensure an OPEN batch exists for the device.  Creates one anchored to the
 * current 5-minute time bucket if none exists.
 */
export async function ensureOpenBatch(deviceId: string, pool?: pg.Pool): Promise<Batch> {
  const p = pool ?? getTimescalePool();
  const client = await p.connect();
  try {
    const existing = await getOpenBatch(client, deviceId);
    if (existing) return existing;

    const now = Date.now();
    const bucketStart = now - (now % BATCH_WINDOW_MS);
    const batchStart = new Date(bucketStart);
    const batchEnd = new Date(bucketStart + BATCH_WINDOW_MS);
    const id = newBatchId(deviceId, bucketStart);

    const batch: Batch = {
      id,
      device_id: deviceId,
      batch_start: batchStart,
      batch_end: batchEnd,
      state: BatchState.OPEN,
    };

    // INSERT … ON CONFLICT DO NOTHING handles concurrent ensureOpenBatch calls
    await client.query(
      `INSERT INTO telemetry_batches (id, device_id, batch_start, batch_end, state)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [batch.id, batch.device_id, batch.batch_start, batch.batch_end, batch.state],
    );

    return batch;
  } finally {
    client.release();
  }
}
