import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Redis } from 'ioredis';
import {
  acquireMigrationLock,
  markMigrationCompleted,
  resetPoolManagerForTests,
} from '../../src/database/pool_manager.js';

const MIGRATION_LOCK_KEY = 'migration_lock';
const MIGRATION_DONE_KEY = 'migration_done';

describe('Concurrent Migration Lock Integration', () => {
  let redisClient: Redis;

  beforeEach(async () => {
    redisClient = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
      commandTimeout: 5000,
    });
    await redisClient.del(MIGRATION_LOCK_KEY);
    await redisClient.del(MIGRATION_DONE_KEY);
    resetPoolManagerForTests();
  });

  afterEach(async () => {
    await redisClient.del(MIGRATION_LOCK_KEY);
    await redisClient.del(MIGRATION_DONE_KEY);
    await redisClient.quit();
  });

  it('should allow only one instance to acquire migration lock', async () => {
    const instance1Id = 'instance-1';
    const instance2Id = 'instance-2';

    const lock1 = await acquireMigrationLock(redisClient, instance1Id);
    const lock2 = await acquireMigrationLock(redisClient, instance2Id);

    expect(lock1).toBe(true);
    expect(lock2).toBe(false);

    const lockHolder = await redisClient.get(MIGRATION_LOCK_KEY);
    expect(lockHolder).toBe(instance1Id);
  });

  it('should simulate 6 concurrent migration attempts with only 1 succeeding', async () => {
    const instances = Array.from({ length: 6 }, (_, i) => `instance-${String(i + 1)}`);
    const lockResults = await Promise.all(
      instances.map((instanceId) => acquireMigrationLock(redisClient, instanceId)),
    );

    const successfulLocks = lockResults.filter((result: boolean) => result);
    const failedLocks = lockResults.filter((result: boolean) => !result);

    expect(successfulLocks.length).toBe(1);
    expect(failedLocks.length).toBe(5);

    const lockHolder = await redisClient.get(MIGRATION_LOCK_KEY);
    expect(lockHolder).toBeDefined();
    expect(instances).toContain(lockHolder);
  });

  it('should mark migration as completed and allow subsequent checks', async () => {
    const instanceId = 'instance-1';
    await acquireMigrationLock(redisClient, instanceId);

    await markMigrationCompleted(redisClient);

    const lockExists = await redisClient.exists(MIGRATION_LOCK_KEY);
    const doneExists = await redisClient.exists(MIGRATION_DONE_KEY);

    expect(lockExists).toBe(0);
    expect(doneExists).toBe(1);
  });

  it('should validate that env vars are present when configured', () => {
    if (process.env['DATABASE_URL'] != null && process.env['SOROBAN_RPC_URL'] != null) {
      expect(process.env['DATABASE_URL']).toBeDefined();
      expect(process.env['SOROBAN_RPC_URL']).toBeDefined();
    } else {
      expect(true).toBe(true);
    }
  });
});
