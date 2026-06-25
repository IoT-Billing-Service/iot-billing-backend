import pg from 'pg';

/**
 * A single billing event stored in the event log.
 */
export interface BillingEvent {
  id: string;
  tenantId: string;
  sequence: number;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

/**
 * The shape of a row returned by appendEvent().
 */
export interface AppendResult {
  id: string;
  tenantId: string;
  sequence: number;
  eventType: string;
  occurredAt: Date;
}

/**
 * Thrown when the maximum number of ON CONFLICT retries is exhausted.
 * This should never happen in practice because the advisory lock serialises
 * all sequence assignments for the same tenant — it is a last-resort guard.
 */
export class SequenceConflictError extends Error {
  readonly tenantId: string;
  readonly attempts: number;

  constructor(tenantId: string, attempts: number) {
    super(
      `Sequence conflict for tenant "${tenantId}" not resolved after ${String(attempts)} attempt(s)`,
    );
    this.name = 'SequenceConflictError';
    this.tenantId = tenantId;
    this.attempts = attempts;
  }
}

/**
 * Maximum number of times appendEvent() will retry after a
 * UNIQUE(tenant_id, sequence) violation before giving up.
 */
const MAX_RETRY_ATTEMPTS = 3;

/**
 * Derive a stable 32-bit integer lock ID from a tenant ID string.
 *
 * PostgreSQL advisory locks take a bigint.  We hash the tenant ID string
 * into a 32-bit integer using the same djb2-style mix used elsewhere in
 * the codebase (see lock_manager.ts) so the mapping is deterministic and
 * collision-resistant across reasonable tenant counts.
 */
export function tenantLockId(tenantId: string): number {
  let hash = 0;
  for (let i = 0; i < tenantId.length; i++) {
    const chr = tenantId.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0; // convert to 32-bit int
  }
  return Math.abs(hash);
}

/**
 * Append a billing event to the per-tenant ordered event log.
 *
 * ## Race-condition fix
 *
 * The original implementation used `COUNT(*) + 1` to assign the next
 * sequence number.  Under concurrent writes two callers could read the same
 * count and produce a duplicate sequence, causing double-billing or missed
 * events in the downstream billing processor.
 *
 * This implementation eliminates the race with two complementary mechanisms:
 *
 * 1. **`pg_advisory_xact_lock`** — acquires a transaction-scoped advisory
 *    lock keyed on `hash(tenant_id)` before reading the current max sequence.
 *    PostgreSQL releases the lock automatically when the transaction commits or
 *    rolls back, so there is no risk of a leaked lock.  Only one writer per
 *    tenant can hold the lock at a time, serialising sequence assignment while
 *    still allowing full parallelism across different tenants.
 *
 * 2. **`UNIQUE(tenant_id, sequence)` + `ON CONFLICT` retry** — a database
 *    constraint guarantees uniqueness at the storage layer.  If a conflict is
 *    somehow raised (e.g. a bug in the locking logic, or a direct DB write that
 *    bypasses this function), the function re-reads the current max inside the
 *    same transaction and retries up to MAX_RETRY_ATTEMPTS times before
 *    throwing a SequenceConflictError.
 *
 * Together these give strong sequential guarantees without requiring a
 * dedicated sequence object or UUIDv7, keeping the schema minimal and the
 * migration path simple.
 *
 * @param client  - A `pg.PoolClient` already checked out by the caller.
 *                  The caller is responsible for releasing it.
 * @param tenantId - Tenant identifier; used as both the partition key and
 *                   the advisory lock discriminator.
 * @param eventType - Application-level event type label.
 * @param payload   - Arbitrary JSON payload for the event.
 *
 * @returns The persisted event row including the assigned sequence number.
 */
export async function appendEvent(
  client: pg.PoolClient,
  tenantId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<AppendResult> {
  const lockId = tenantLockId(tenantId);

  await client.query('BEGIN');

  try {
    // Acquire a transaction-scoped advisory lock for this tenant.
    // pg_advisory_xact_lock blocks until the lock is available and is
    // automatically released at COMMIT/ROLLBACK — no manual unlock needed.
    await client.query('SELECT pg_advisory_xact_lock($1)', [lockId]);

    let attempt = 0;

    while (attempt < MAX_RETRY_ATTEMPTS) {
      // Read the current maximum sequence for this tenant while holding the
      // lock.  COALESCE handles the empty-table case (first event → seq 1).
      const seqResult = await client.query<{ next_seq: string }>(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq
           FROM billing_events
          WHERE tenant_id = $1`,
        [tenantId],
      );

      const nextSeq = parseInt(seqResult.rows[0]?.next_seq ?? '1', 10);

      try {
        const insertResult = await client.query<AppendResult>(
          `INSERT INTO billing_events (tenant_id, sequence, event_type, payload, occurred_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (tenant_id, sequence) DO NOTHING
           RETURNING id, tenant_id AS "tenantId", sequence, event_type AS "eventType", occurred_at AS "occurredAt"`,
          [tenantId, nextSeq, eventType, JSON.stringify(payload)],
        );

        if (insertResult.rows.length > 0 && insertResult.rows[0] !== undefined) {
          await client.query('COMMIT');
          return insertResult.rows[0];
        }

        // ON CONFLICT DO NOTHING returned zero rows — a duplicate sequence
        // slipped through.  Increment attempt counter and retry inside the
        // same transaction (the advisory lock is still held).
        attempt++;
      } catch (err) {
        // Re-throw anything that is not a unique_violation (code 23505).
        const pgErr = err as { code?: string };
        if (pgErr.code !== '23505') {
          await client.query('ROLLBACK');
          throw err;
        }
        attempt++;
      }
    }

    await client.query('ROLLBACK');
    throw new SequenceConflictError(tenantId, MAX_RETRY_ATTEMPTS);
  } catch (err) {
    // Ensure the transaction is always cleaned up on unexpected errors.
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback errors — the connection will be returned to the pool
      // regardless and the pool will detect the broken state.
    }
    throw err;
  }
}

/**
 * Read billing events for a tenant in strict sequence order.
 *
 * The downstream billing processor depends on monotonically increasing
 * sequence numbers to process events exactly once, in order.  This query
 * returns events ordered by sequence so the processor never needs to sort.
 *
 * @param client   - A `pg.PoolClient` to use for the query.
 * @param tenantId - Tenant whose events to fetch.
 * @param afterSeq - Only return events with sequence > afterSeq (pagination).
 * @param limit    - Maximum number of events to return (default 100).
 */
export async function readEvents(
  client: pg.PoolClient,
  tenantId: string,
  afterSeq = 0,
  limit = 100,
): Promise<BillingEvent[]> {
  const result = await client.query<BillingEvent>(
    `SELECT id,
            tenant_id   AS "tenantId",
            sequence,
            event_type  AS "eventType",
            payload,
            occurred_at AS "occurredAt"
       FROM billing_events
      WHERE tenant_id = $1
        AND sequence  > $2
      ORDER BY sequence ASC
      LIMIT $3`,
    [tenantId, afterSeq, limit],
  );

  return result.rows;
}

/**
 * Return the DDL required to create the billing_events table.
 *
 * Call this from a migration or test setup to ensure the table exists
 * before using appendEvent() or readEvents().
 *
 * The `UNIQUE(tenant_id, sequence)` constraint is what backs the
 * ON CONFLICT clause in appendEvent() and acts as the hard guarantee
 * that duplicate sequences can never be silently stored.
 */
export function createTableDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS billing_events (
      id          TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
      tenant_id   TEXT        NOT NULL,
      sequence    INTEGER     NOT NULL,
      event_type  TEXT        NOT NULL,
      payload     JSONB       NOT NULL DEFAULT '{}',
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      PRIMARY KEY (id),
      CONSTRAINT billing_events_tenant_seq_unique UNIQUE (tenant_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS idx_billing_events_tenant_seq
      ON billing_events (tenant_id, sequence ASC);
  `;
}
