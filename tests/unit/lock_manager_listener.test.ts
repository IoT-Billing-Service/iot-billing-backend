import { describe, it, expect, afterEach, vi } from 'vitest';
import { AdvisoryLockManager } from '../../src/core/ingestion/lock_manager.js';
import type pg from 'pg';

/**
 * Mock pg.Pool that returns controllable clients so we can test
 * lock acquisition, expiry, and listener lifecycle without a
 * real PostgreSQL database.
 */
function makeMockPool(): pg.Pool {
  interface MockClient {
    id: number;
    released: boolean;
    query: () => Promise<{ rows: { locked: boolean }[] }>;
    release: () => void;
  }
  const clients: MockClient[] = [];
  let nextId = 0;

  const createClient = (): MockClient => {
    const id = nextId++;
    const client: MockClient = {
      id,
      released: false,
      query: () => Promise.resolve({ rows: [{ locked: true }] }),
      release: () => {
        client.released = true;
      },
    };
    clients.push(client);
    return client;
  };

  const connect = vi.fn(() => Promise.resolve(createClient()));

  return {
    connect,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as pg.Pool;
}

describe('AdvisoryLockManager listener leak prevention', () => {
  let manager: AdvisoryLockManager;

  afterEach(() => {
    manager.removeAllListeners();
  });

  it('should acquire and release a lock with zero listener leakage', async () => {
    const pool = makeMockPool();
    manager = new AdvisoryLockManager(pool);

    const result = await manager.acquireLock('dev-1', 1000, { ttlMs: 5000 });
    expect(result.acquired).toBe(true);
    expect(manager.getEventListenerCount()).toBe(0); // no per-lock listeners registered yet

    // Register per-lock listener
    let expiredCalled = false;
    manager.onExpired(result.lockId, () => {
      expiredCalled = true;
    });
    expect(manager.getEventListenerCount()).toBe(1);

    // Explicit release should clean up
    await manager.releaseLockById(result.lockId);
    expect(manager.getEventListenerCount()).toBe(0);
    // Dummy reference to avoid unused-vars lint
    void expiredCalled;
  });

  it('should clean up listeners on auto-expiry', async () => {
    const pool = makeMockPool();
    manager = new AdvisoryLockManager(pool);

    const result = await manager.acquireLock('dev-2', 2000, { ttlMs: 50 });
    expect(result.acquired).toBe(true);

    let expiredCalled = false;
    manager.onExpired(result.lockId, () => {
      expiredCalled = true;
    });
    expect(manager.getEventListenerCount()).toBe(1);

    // Wait for TTL expiry
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(expiredCalled).toBe(true);
    expect(manager.getEventListenerCount()).toBe(0);
  }, 10000);

  it('should acquire 100 locks, expire 50, and confirm 0 listener leaks', async () => {
    const pool = makeMockPool();
    manager = new AdvisoryLockManager(pool);

    const lockIds: number[] = [];

    // Acquire 100 locks with per-lock listeners
    for (let i = 0; i < 100; i++) {
      const result = await manager.acquireLock(`dev-${String(i)}`, 1000 + i, {
        ttlMs: i < 50 ? 50 : 30000,
      });
      expect(result.acquired).toBe(true);
      lockIds.push(result.lockId);

      manager.onExpired(result.lockId, () => {
        /* noop — listener cleanup test */
      });
      manager.onReleased(result.lockId, () => {
        /* noop — listener cleanup test */
      });
    }

    expect(manager.getEventListenerCount()).toBe(200); // 2 listeners per lock
    expect(manager.getActiveLockCount()).toBe(100);

    // Wait for the first 50 locks to expire (50ms TTL)
    await new Promise((resolve) => setTimeout(resolve, 150));

    // 50 locks should have expired, 50 remain
    // Expired listeners should have been cleaned up
    expect(manager.getActiveLockCount()).toBe(50);
    expect(manager.getEventListenerCount()).toBe(100); // 2 x 50 remaining

    // Release remaining 50
    for (const lockId of lockIds.slice(50)) {
      await manager.releaseLockById(lockId);
    }

    expect(manager.getActiveLockCount()).toBe(0);
    expect(manager.getEventListenerCount()).toBe(0);
  }, 15000);

  it('should clean up mixed expired/released listeners correctly', async () => {
    const pool = makeMockPool();
    manager = new AdvisoryLockManager(pool);

    const result = await manager.acquireLock('dev-mix', 5000, { ttlMs: 100 });
    expect(result.acquired).toBe(true);

    manager.onExpired(result.lockId, () => {
      /* noop — listener cleanup test */
    });
    manager.onReleased(result.lockId, () => {
      /* noop — listener cleanup test */
    });
    expect(manager.getEventListenerCount()).toBe(2);

    // release before expiry
    await manager.releaseLockById(result.lockId);
    // Both expired and released listeners should be gone
    expect(manager.getEventListenerCount()).toBe(0);
  });
});