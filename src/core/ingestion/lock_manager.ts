import pg from 'pg';
import { EventEmitter } from 'node:events';

export interface LockAcquisitionResult {
  acquired: boolean;
  lockId: number;
  client?: pg.PoolClient;
}

export interface LockOptions {
  ttlMs: number;
  retryAttempts?: number;
  retryBaseDelayMs?: number;
  heartbeatIntervalMs?: number;
}

const DEFAULT_LOCK_OPTIONS: Required<Omit<LockOptions, 'heartbeatIntervalMs'>> & {
  heartbeatIntervalMs: number;
} = {
  ttlMs: 30_000,
  retryAttempts: 3,
  retryBaseDelayMs: 200,
  heartbeatIntervalMs: 10_000,
};

/** Per-lock listener metadata registered via onExpired() / onReleased(). */
interface LockListenerEntry {
  lockId: number;
  listeners: { event: string; handler: (...args: unknown[]) => void }[];
}

export class AdvisoryLockManager extends EventEmitter {
  private pool: pg.Pool;
  private heldLocks = new Map<
    number,
    {
      timer: ReturnType<typeof setTimeout>;
      heartbeat?: ReturnType<typeof setInterval>;
      client: pg.PoolClient;
    }
  >();

  /** Tracks per-lock listener registrations so they can be cleaned up on expiry. */
  private lockListenerIndex = new Map<number, LockListenerEntry>();

  constructor(pool: pg.Pool) {
    super();
    this.setMaxListeners(Infinity);
    this.pool = pool;
  }

  private compositeLockId(deviceId: string, bucketStartEpoch: number): number {
    let hash = 0;
    const composite = `${deviceId}:${String(bucketStartEpoch)}`;
    for (let i = 0; i < composite.length; i++) {
      const chr = composite.charCodeAt(i);
      hash = (hash << 5) - hash + chr;
      hash |= 0;
    }
    return Math.abs(hash);
  }

  async acquireLock(
    deviceId: string,
    bucketStartEpoch: number,
    options?: Partial<LockOptions>,
  ): Promise<LockAcquisitionResult> {
    const opts = { ...DEFAULT_LOCK_OPTIONS, ...options };
    const lockId = this.compositeLockId(deviceId, bucketStartEpoch);

    const client = await this.pool.connect();
    try {
      const result = await client.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock($1) AS locked`,
        [lockId],
      );

      if (result.rows[0]?.locked === true) {
        const timer = setTimeout(() => {
          this.autoRelease(lockId);
        }, opts.ttlMs);

        if (opts.heartbeatIntervalMs > 0) {
          const heartbeat = setInterval(() => {
            this.heartbeat(lockId, opts.ttlMs);
          }, opts.heartbeatIntervalMs);
          this.heldLocks.set(lockId, { timer, heartbeat, client });
        } else {
          this.heldLocks.set(lockId, { timer, client });
        }

        this.emit('lockAcquired', { deviceId, bucketStartEpoch, lockId });
        return { acquired: true, lockId, client };
      }

      client.release();
      return { acquired: false, lockId };
    } catch (error) {
      client.release();
      throw error;
    }
  }

  async tryAcquireWithRetry(
    deviceId: string,
    bucketStartEpoch: number,
    options?: Partial<LockOptions>,
  ): Promise<LockAcquisitionResult> {
    const opts = { ...DEFAULT_LOCK_OPTIONS, ...options };
    const maxAttempts = opts.retryAttempts;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const result = await this.acquireLock(deviceId, bucketStartEpoch, options);
      if (result.acquired) return result;

      if (attempt < maxAttempts - 1) {
        const delay = opts.retryBaseDelayMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    const lockId = this.compositeLockId(deviceId, bucketStartEpoch);
    return { acquired: false, lockId };
  }

  async releaseLock(deviceId: string, bucketStartEpoch: number): Promise<boolean> {
    const lockId = this.compositeLockId(deviceId, bucketStartEpoch);
    return this.releaseLockById(lockId);
  }

  async releaseLockById(lockId: number): Promise<boolean> {
    const held = this.heldLocks.get(lockId);
    if (!held) {
      this.emit('lockReleased', { lockId });
      return true;
    }

    clearTimeout(held.timer);
    if (held.heartbeat) clearInterval(held.heartbeat);
    this.heldLocks.delete(lockId);
    this.removeLockListeners(lockId);

    try {
      await held.client.query(`SELECT pg_advisory_unlock($1)`, [lockId]);
      return true;
    } finally {
      held.client.release();
      this.emit('lockReleased', { lockId });
    }
  }

  private heartbeat(lockId: number, ttlMs: number): void {
    const held = this.heldLocks.get(lockId);
    if (!held) return;

    clearTimeout(held.timer);
    held.timer = setTimeout(() => {
      this.autoRelease(lockId);
    }, ttlMs);

    this.emit('heartbeat', { lockId });
  }

  private autoRelease(lockId: number): void {
    const held = this.heldLocks.get(lockId);
    if (!held) return;

    if (held.heartbeat) clearInterval(held.heartbeat);
    this.heldLocks.delete(lockId);

    held.client
      .query(`SELECT pg_advisory_unlock($1)`, [lockId])
      .then(() => {
        held.client.release();
      })
      .catch(() => {
        held.client.release();
      });

    // Emit BEFORE removing listeners so per-lock handlers fire
    this.emit('lockExpired', { lockId });

    // Clean up per-lock event listeners to prevent MaxListenersWarning / memory leak
    this.removeLockListeners(lockId);
  }

  /**
   * Register a one-shot listener that fires when this specific lock expires.
   * Automatically cleaned up on expiry or explicit release.
   */
  onExpired(
    lockId: number,
    handler: (payload: { lockId: number }) => void,
  ): void {
    const wrapped = (payload: { lockId: number }): void => {
      if (payload.lockId === lockId) {
        handler(payload);
        this.removeLockListeners(lockId);
      }
    };
    this.on('lockExpired', wrapped);
    const existing = this.lockListenerIndex.get(lockId);
    if (existing) {
      existing.listeners.push({
        event: 'lockExpired',
        handler: wrapped as (...args: unknown[]) => void,
      });
    } else {
      this.lockListenerIndex.set(lockId, {
        lockId,
        listeners: [
          {
            event: 'lockExpired',
            handler: wrapped as (...args: unknown[]) => void,
          },
        ],
      });
    }
  }

  /**
   * Register a one-shot listener that fires when this specific lock is released.
   * Automatically cleaned up on release or expiry.
   */
  onReleased(
    lockId: number,
    handler: (payload: { lockId: number }) => void,
  ): void {
    const wrapped = (payload: { lockId: number }): void => {
      if (payload.lockId === lockId) {
        handler(payload);
        this.removeLockListeners(lockId);
      }
    };
    this.on('lockReleased', wrapped);
    const existing = this.lockListenerIndex.get(lockId);
    if (existing) {
      existing.listeners.push({
        event: 'lockReleased',
        handler: wrapped as (...args: unknown[]) => void,
      });
    } else {
      this.lockListenerIndex.set(lockId, {
        lockId,
        listeners: [
          {
            event: 'lockReleased',
            handler: wrapped as (...args: unknown[]) => void,
          },
        ],
      });
    }
  }

  /** Remove all registered per-lock listeners for a given lockId. */
  removeLockListeners(lockId: number): void {
    const entry = this.lockListenerIndex.get(lockId);
    if (!entry) return;
    for (const { event, handler } of entry.listeners) {
      this.off(event, handler);
    }
    this.lockListenerIndex.delete(lockId);
  }

  isLockHeld(deviceId: string, bucketStartEpoch: number): boolean {
    const lockId = this.compositeLockId(deviceId, bucketStartEpoch);
    return this.heldLocks.has(lockId);
  }

  getActiveLockCount(): number {
    return this.heldLocks.size;
  }

  /** Number of actively registered per-lock event handlers. Used to detect listener leaks. */
  getEventListenerCount(): number {
    let count = 0;
    for (const entry of this.lockListenerIndex.values()) {
      count += entry.listeners.length;
    }
    return count;
  }

  async releaseAll(): Promise<void> {
    for (const lockId of this.heldLocks.keys()) {
      await this.releaseLockById(lockId);
    }
  }
}

export function composeIdempotencyKey(deviceId: string, bucketStartEpoch: number): string {
  return `${deviceId}:${String(bucketStartEpoch)}`;
}
