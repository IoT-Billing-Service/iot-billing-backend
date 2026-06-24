import pg from 'pg';

export const BATCH_WINDOW_MS = 5 * 60 * 1_000; // 5 minutes

export enum BatchState {
  OPEN = 'OPEN',
  COMPACTING = 'COMPACTING',
  CLOSED = 'CLOSED',
}

const VALID_TRANSITIONS: Record<BatchState, BatchState[]> = {
  [BatchState.OPEN]: [BatchState.COMPACTING],
  [BatchState.COMPACTING]: [BatchState.CLOSED],
  [BatchState.CLOSED]: [],
};

export interface Batch {
  id: string;
  device_id: string;
  batch_start: Date;
  batch_end: Date;
  state: BatchState;
}

/**
 * Deterministic integer lock key for a batch ID (FNV-1a 32-bit).
 * Must stay positive so it fits in a PostgreSQL int4 advisory lock.
 */
export function batchLockId(batchId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < batchId.length; i++) {
    h ^= batchId.charCodeAt(i);
    h = (Math.imul(h, 0x01000193) >>> 0);
  }
  // mask to 31 bits so it is always a positive signed int
  return (h & 0x7fffffff);
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

export async function createBatch(client: pg.PoolClient, batch: Batch): Promise<void> {
  await client.query(
    `INSERT INTO telemetry_batches (id, device_id, batch_start, batch_end, state)
     VALUES ($1, $2, $3, $4, $5)`,
    [batch.id, batch.device_id, batch.batch_start, batch.batch_end, batch.state],
  );
}

export async function getBatch(
  client: pg.PoolClient,
  batchId: string,
): Promise<Batch | null> {
  const res = await client.query<Batch>(
    `SELECT id, device_id, batch_start, batch_end, state
     FROM telemetry_batches WHERE id = $1`,
    [batchId],
  );
  return res.rows[0] ?? null;
}

export async function getOpenBatch(
  client: pg.PoolClient,
  deviceId: string,
): Promise<Batch | null> {
  const res = await client.query<Batch>(
    `SELECT id, device_id, batch_start, batch_end, state
     FROM telemetry_batches
     WHERE device_id = $1 AND state = $2
     ORDER BY batch_start DESC LIMIT 1`,
    [deviceId, BatchState.OPEN],
  );
  return res.rows[0] ?? null;
}

/**
 * Atomic CAS-style state transition guarded by the advisory lock caller must
 * already hold.  Returns false if the current state does not match `from`.
 */
export async function transitionBatchState(
  client: pg.PoolClient,
  batchId: string,
  from: BatchState,
  to: BatchState,
): Promise<boolean> {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new Error(`Invalid batch transition ${from} → ${to}`);
  }
  const res = await client.query<{ id: string }>(
    `UPDATE telemetry_batches SET state = $1
     WHERE id = $2 AND state = $3
     RETURNING id`,
    [to, batchId, from],
  );
  return (res.rowCount ?? 0) > 0;
}

// ─── Advisory lock helpers ────────────────────────────────────────────────────

/**
 * Acquire a session-level advisory lock for the given batch.
 * Uses pg_try_advisory_lock (non-blocking); returns false immediately if busy.
 */
export async function tryAcquireBatchLock(
  client: pg.PoolClient,
  batchId: string,
): Promise<boolean> {
  const lockId = batchLockId(batchId);
  const res = await client.query<{ locked: boolean }>(
    `SELECT pg_try_advisory_lock($1) AS locked`,
    [lockId],
  );
  return res.rows[0]?.locked === true;
}

export async function releaseBatchLock(
  client: pg.PoolClient,
  batchId: string,
): Promise<void> {
  const lockId = batchLockId(batchId);
  await client.query(`SELECT pg_advisory_unlock($1)`, [lockId]);
}
