import { describe, it, expect, vi, beforeEach } from 'vitest';
import type pg from 'pg';
import {
  appendEvent,
  readEvents,
  tenantLockId,
  createTableDDL,
  SequenceConflictError,
  type AppendResult,
} from '../../src/ingestion/eventStore.js';

// ─── Mock pg.PoolClient factory ───────────────────────────────────────────────
//
// appendEvent() requires a real pg.PoolClient because it issues:
//   BEGIN → pg_advisory_xact_lock → SELECT MAX(sequence) → INSERT → COMMIT
// (or ROLLBACK on failure).
//
// Rather than spinning up a real Postgres instance we build a stateful in-memory
// mock that:
//   • Tracks the per-tenant max sequence in a shared Map (simulating a DB table)
//   • Enforces the UNIQUE(tenant_id, sequence) constraint — duplicate inserts
//     return zero rows (ON CONFLICT DO NOTHING behaviour)
//   • Serialises advisory-locked operations via a per-tenant async queue so
//     concurrent callers do not interleave inside the same mock "transaction"
//
// This makes the mock faithful enough to verify the race-condition fix without
// a live database.

interface StoredEvent {
  id: string;
  tenantId: string;
  sequence: number;
  eventType: string;
  occurredAt: Date;
}

// Shared state across all mock clients (simulates a single DB)
const db = {
  events: [] as StoredEvent[],
  // Per-tenant lock queues — each entry is a chain of Promises that serialises
  // advisory-locked sections for the same tenant, mirroring pg_advisory_xact_lock.
  lockQueues: new Map<string, Promise<void>>(),

  reset(): void {
    this.events = [];
    this.lockQueues.clear();
  },

  maxSequence(tenantId: string): number {
    const tenantEvents = this.events.filter((e) => e.tenantId === tenantId);
    return tenantEvents.length === 0 ? 0 : Math.max(...tenantEvents.map((e) => e.sequence));
  },

  insert(event: StoredEvent): boolean {
    // Enforce UNIQUE(tenant_id, sequence) — return false if duplicate
    const exists = this.events.some(
      (e) => e.tenantId === event.tenantId && e.sequence === event.sequence,
    );
    if (exists) return false;
    this.events.push(event);
    return true;
  },

  readOrdered(tenantId: string, afterSeq: number, limit: number): StoredEvent[] {
    return this.events
      .filter((e) => e.tenantId === tenantId && e.sequence > afterSeq)
      .sort((a, b) => a.sequence - b.sequence)
      .slice(0, limit);
  },
};

// Per-client transaction state
interface TxState {
  active: boolean;
  lockHeld: string | null; // tenantId whose lock this client holds
  releaseLock: (() => void) | null;
}

let clientIdCounter = 0;

function createMockClient(): pg.PoolClient {
  const id = ++clientIdCounter;
  const tx: TxState = { active: false, lockHeld: null, releaseLock: null };

  const client = {
    _id: id,

    query: vi.fn(async (sql: string, params?: unknown[]) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      // ── BEGIN ──────────────────────────────────────────────────────────────
      if (/^BEGIN$/i.test(normalized)) {
        tx.active = true;
        return { rows: [], rowCount: 0 };
      }

      // ── COMMIT ─────────────────────────────────────────────────────────────
      if (/^COMMIT$/i.test(normalized)) {
        tx.active = false;
        if (tx.releaseLock) {
          tx.releaseLock();
          tx.releaseLock = null;
          tx.lockHeld = null;
        }
        return { rows: [], rowCount: 0 };
      }

      // ── ROLLBACK ───────────────────────────────────────────────────────────
      if (/^ROLLBACK$/i.test(normalized)) {
        tx.active = false;
        if (tx.releaseLock) {
          tx.releaseLock();
          tx.releaseLock = null;
          tx.lockHeld = null;
        }
        return { rows: [], rowCount: 0 };
      }

      // ── pg_advisory_xact_lock ──────────────────────────────────────────────
      // Serialise per-tenant by chaining onto that tenant's queue Promise.
      if (/pg_advisory_xact_lock/i.test(normalized)) {
        // Find the tenantId that maps to this lockId
        const lockId = params?.[0] as number;
        // We store the tenantId on the tx so COMMIT/ROLLBACK can release it.
        // To reverse-map lockId → tenantId we smuggle it via a WeakMap keyed
        // on the client — simpler: just store lockId and resolve via queue key.
        const key = String(lockId);

        // Build a serialisation queue per lock key
        const prev = db.lockQueues.get(key) ?? Promise.resolve();
        let resolveNext!: () => void;
        const next = new Promise<void>((res) => {
          resolveNext = res;
        });
        db.lockQueues.set(
          key,
          prev.then(() => next),
        );

        // Wait for our turn
        await prev;

        tx.releaseLock = resolveNext;
        tx.lockHeld = key;

        return { rows: [], rowCount: 0 };
      }

      // ── SELECT COALESCE(MAX(sequence)) ─────────────────────────────────────
      if (/COALESCE\(MAX\(sequence\)/i.test(normalized)) {
        const tenantId = params?.[0] as string;
        const nextSeq = db.maxSequence(tenantId) + 1;
        return { rows: [{ next_seq: String(nextSeq) }], rowCount: 1 };
      }

      // ── INSERT … ON CONFLICT DO NOTHING RETURNING … ───────────────────────
      if (/INSERT INTO billing_events/i.test(normalized)) {
        const [tenantId, sequence, eventType] = params as [string, number, string];
        const event: StoredEvent = {
          id: `evt_${String(id)}_${String(sequence)}_${String(Date.now())}`,
          tenantId,
          sequence,
          eventType,
          occurredAt: new Date(),
        };
        const inserted = db.insert(event);
        if (!inserted) {
          // ON CONFLICT DO NOTHING — return zero rows
          return { rows: [], rowCount: 0 };
        }
        const row: AppendResult = {
          id: event.id,
          tenantId: event.tenantId,
          sequence: event.sequence,
          eventType: event.eventType,
          occurredAt: event.occurredAt,
        };
        return { rows: [row], rowCount: 1 };
      }

      // ── SELECT for readEvents ──────────────────────────────────────────────
      if (/FROM billing_events/i.test(normalized)) {
        const [tenantId, afterSeq, limit] = params as [string, number, number];
        const rows = db.readOrdered(tenantId, afterSeq, limit).map((e) => ({
          id: e.id,
          tenantId: e.tenantId,
          sequence: e.sequence,
          eventType: e.eventType,
          payload: {},
          occurredAt: e.occurredAt,
        }));
        return { rows, rowCount: rows.length };
      }

      return { rows: [], rowCount: 0 };
    }),

    release: vi.fn(),
  } as unknown as pg.PoolClient;

  return client;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function newClient(): pg.PoolClient {
  return createMockClient();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('tenantLockId', () => {
  it('returns a non-negative integer', () => {
    const id = tenantLockId('tenant-abc');
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(id)).toBe(true);
  });

  it('is deterministic — same input always produces the same output', () => {
    expect(tenantLockId('tenant-xyz')).toBe(tenantLockId('tenant-xyz'));
  });

  it('produces different ids for different tenants', () => {
    expect(tenantLockId('tenant-A')).not.toBe(tenantLockId('tenant-B'));
  });

  it('handles empty string without throwing', () => {
    expect(() => tenantLockId('')).not.toThrow();
  });
});

describe('createTableDDL', () => {
  it('returns a non-empty string', () => {
    const ddl = createTableDDL();
    expect(typeof ddl).toBe('string');
    expect(ddl.trim().length).toBeGreaterThan(0);
  });

  it('includes the billing_events table name', () => {
    expect(createTableDDL()).toContain('billing_events');
  });

  it('includes the UNIQUE(tenant_id, sequence) constraint', () => {
    const ddl = createTableDDL();
    expect(ddl).toContain('UNIQUE');
    expect(ddl).toContain('tenant_id');
    expect(ddl).toContain('sequence');
  });

  it('uses CREATE TABLE IF NOT EXISTS', () => {
    expect(createTableDDL()).toContain('CREATE TABLE IF NOT EXISTS');
  });
});

describe('SequenceConflictError', () => {
  it('is an instance of Error', () => {
    const err = new SequenceConflictError('t1', 3);
    expect(err).toBeInstanceOf(Error);
  });

  it('has name SequenceConflictError', () => {
    expect(new SequenceConflictError('t1', 3).name).toBe('SequenceConflictError');
  });

  it('exposes tenantId and attempts', () => {
    const err = new SequenceConflictError('my-tenant', 5);
    expect(err.tenantId).toBe('my-tenant');
    expect(err.attempts).toBe(5);
  });

  it('message includes tenant id and attempt count', () => {
    const err = new SequenceConflictError('acme', 2);
    expect(err.message).toContain('acme');
    expect(err.message).toContain('2');
  });
});

describe('appendEvent — sequential writes', () => {
  beforeEach(() => {
    db.reset();
  });

  it('returns an AppendResult with sequence 1 for the first event', async () => {
    const client = newClient();
    const result = await appendEvent(client, 'tenant-1', 'usage.recorded', { kwh: 1.5 });
    expect(result.sequence).toBe(1);
    expect(result.tenantId).toBe('tenant-1');
    expect(result.eventType).toBe('usage.recorded');
    expect(typeof result.id).toBe('string');
    expect(result.occurredAt).toBeInstanceOf(Date);
  });

  it('assigns strictly increasing sequences for sequential writes', async () => {
    const sequences: number[] = [];
    for (let i = 0; i < 5; i++) {
      const client = newClient();
      const r = await appendEvent(client, 'tenant-seq', 'ping', {});
      sequences.push(r.sequence);
    }
    expect(sequences).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps sequences independent across tenants', async () => {
    const rA = await appendEvent(newClient(), 'tenant-A', 'ev', {});
    const rB = await appendEvent(newClient(), 'tenant-B', 'ev', {});
    const rA2 = await appendEvent(newClient(), 'tenant-A', 'ev', {});

    expect(rA.sequence).toBe(1);
    expect(rB.sequence).toBe(1); // tenant-B starts its own sequence
    expect(rA2.sequence).toBe(2);
  });

  it('issues BEGIN and COMMIT for a successful append', async () => {
    const client = newClient();
    await appendEvent(client, 'tenant-tx', 'ev', {});
    const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) =>
      (c[0] as string).trim(),
    );
    expect(calls[0]).toBe('BEGIN');
    expect(calls[calls.length - 1]).toBe('COMMIT');
  });

  it('acquires the advisory lock before reading the sequence', async () => {
    const client = newClient();
    await appendEvent(client, 'tenant-lock', 'ev', {});
    const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) =>
      (c[0] as string).trim(),
    );
    const lockIdx = calls.findIndex((s: string) => s.includes('pg_advisory_xact_lock'));
    const seqIdx = calls.findIndex((s: string) => s.includes('COALESCE'));
    expect(lockIdx).toBeGreaterThan(-1);
    expect(seqIdx).toBeGreaterThan(lockIdx); // lock acquired BEFORE reading max sequence
  });
});

describe('appendEvent — concurrent writes (race-condition regression)', () => {
  beforeEach(() => {
    db.reset();
  });

  it('produces unique, dense sequences under 100 concurrent writers for the same tenant', async () => {
    const CONCURRENCY = 100;
    const TENANT = 'tenant-concurrent-100';

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        appendEvent(newClient(), TENANT, 'usage.recorded', { kwh: Math.random() }),
      ),
    );

    const sequences = results.map((r) => r.sequence).sort((a, b) => a - b);

    // All sequences must be unique
    const unique = new Set(sequences);
    expect(unique.size).toBe(CONCURRENCY);

    // Sequences must be dense: 1, 2, 3, … N
    expect(sequences[0]).toBe(1);
    expect(sequences[i]).toBe((sequences[i - 1] ?? 0) + 1);
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toBe(sequences[i - 1]! + 1);
    }
  });

  it('produces unique, dense sequences under 1 000 concurrent writers for the same tenant', async () => {
    const CONCURRENCY = 1_000;
    const TENANT = 'tenant-concurrent-1000';

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        appendEvent(newClient(), TENANT, 'usage.recorded', { kwh: Math.random() }),
      ),
    );

    const sequences = results.map((r) => r.sequence).sort((a, b) => a - b);

    const unique = new Set(sequences);
    expect(unique.size).toBe(CONCURRENCY);

    expect(sequences[0]).toBe(1);
    expect(sequences[i]).toBe((sequences[i - 1] ?? 0) + 1);
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toBe(sequences[i - 1]! + 1);
    }
  });

  it('concurrent writes to different tenants do not cross-contaminate sequences', async () => {
    const TENANTS = ['alpha', 'beta', 'gamma'];
    const PER_TENANT = 50;

    const allResults = await Promise.all(
      TENANTS.flatMap((tenant) =>
        Array.from({ length: PER_TENANT }, () =>
          appendEvent(newClient(), tenant, 'ev', { tenant }),
        ),
      ),
    );

    for (const tenant of TENANTS) {
      const seqs = allResults
        .filter((r) => r.tenantId === tenant)
        .map((r) => r.sequence)
        .sort((a, b) => a - b);

      expect(new Set(seqs).size).toBe(PER_TENANT);
      expect(seqs[0]).toBe(1);
      expect(seqs[seqs.length - 1]).toBe(PER_TENANT);
    }
  });

  it('no event is stored more than once under concurrent load', async () => {
    const CONCURRENCY = 200;
    const TENANT = 'tenant-dedup';

    await Promise.all(
      Array.from({ length: CONCURRENCY }, () => appendEvent(newClient(), TENANT, 'ping', {})),
    );

    const storedForTenant = db.events.filter((e) => e.tenantId === TENANT);
    expect(storedForTenant.length).toBe(CONCURRENCY);
  });
});

describe('readEvents', () => {
  beforeEach(() => {
    db.reset();
  });

  it('returns events in ascending sequence order', async () => {
    const TENANT = 'tenant-read';
    // Write 5 events sequentially
    for (let i = 0; i < 5; i++) {
      await appendEvent(newClient(), TENANT, 'ev', { i });
    }

    const client = newClient();
    const events = await readEvents(client, TENANT);
    const sequences = events.map((e) => e.sequence);
    expect(sequences).toEqual([1, 2, 3, 4, 5]);
  });

  it('respects afterSeq — only returns events with sequence > afterSeq', async () => {
    const TENANT = 'tenant-after';
    for (let i = 0; i < 5; i++) {
      await appendEvent(newClient(), TENANT, 'ev', {});
    }

    const events = await readEvents(newClient(), TENANT, 3);
    expect(events.every((e) => e.sequence > 3)).toBe(true);
    expect(events.map((e) => e.sequence)).toEqual([4, 5]);
  });

  it('respects limit — returns at most N events', async () => {
    const TENANT = 'tenant-limit';
    for (let i = 0; i < 10; i++) {
      await appendEvent(newClient(), TENANT, 'ev', {});
    }

    const events = await readEvents(newClient(), TENANT, 0, 3);
    expect(events.length).toBe(3);
  });

  it('returns an empty array when no events exist for the tenant', async () => {
    const events = await readEvents(newClient(), 'tenant-empty');
    expect(events).toEqual([]);
  });

  it('returns an empty array when afterSeq is beyond the last event', async () => {
    const TENANT = 'tenant-beyond';
    await appendEvent(newClient(), TENANT, 'ev', {});
    const events = await readEvents(newClient(), TENANT, 999);
    expect(events).toEqual([]);
  });

  it('does not return events from a different tenant', async () => {
    await appendEvent(newClient(), 'tenant-X', 'ev', {});
    await appendEvent(newClient(), 'tenant-Y', 'ev', {});

    const events = await readEvents(newClient(), 'tenant-X');
    expect(events.every((e) => e.tenantId === 'tenant-X')).toBe(true);
    expect(events.length).toBe(1);
  });
});
