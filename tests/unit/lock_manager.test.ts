import { describe, it, expect } from 'vitest';
import { composeIdempotencyKey } from '../../src/core/ingestion/lock_manager.js';

describe('AdvisoryLockManager - Composition', () => {
  it('should compose idempotency key from deviceId and bucketStartEpoch', () => {
    const key = composeIdempotencyKey('dev-001', 1718000000000);
    expect(key).toBe('dev-001:1718000000000');
  });

  it('should produce different keys for different deviceIds', () => {
    const key1 = composeIdempotencyKey('dev-001', 1718000000000);
    const key2 = composeIdempotencyKey('dev-002', 1718000000000);
    expect(key1).not.toBe(key2);
  });

  it('should produce different keys for different bucket epochs', () => {
    const key1 = composeIdempotencyKey('dev-001', 1718000000000);
    const key2 = composeIdempotencyKey('dev-001', 1718000000001);
    expect(key1).not.toBe(key2);
  });
});
