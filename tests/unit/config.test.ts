import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { z } from 'zod';
import type {
  generateMonotonicUUID as generateMonotonicUUIDType,
  getConfig as getConfigType,
  commitConfig as commitConfigType,
  initializeConfigWatcher as initializeConfigWatcherType,
  stopConfigWatcher as stopConfigWatcherType,
  BillingTier,
} from '../../src/config/index.js';
import type {
  processBatch as processBatchType,
  TelemetryEvent,
} from '../../src/core/ingestion/validator.js';
import type { Gauge } from 'prom-client';
import type { Redis } from 'ioredis';

beforeAll(() => {
  process.env['DATABASE_URL'] = 'postgresql://localhost:5432/test';
  process.env['TIMESCALEDB_URL'] = 'postgresql://localhost:5432/test';
  process.env['SOROBAN_RPC_URL'] = 'https://rpc.test';
  process.env['SOROBAN_NETWORK_PASSPHRASE'] = 'Test Network';
  process.env['JWT_SECRET'] = 'a'.repeat(32);
  process.env['REDIS_URL'] = 'redis://localhost:6379';
});

describe('Config', () => {
  it('should export loadEnv and getEnv functions', async () => {
    const mod = await import('../../src/config/env.js');
    expect(typeof mod.loadEnv).toBe('function');
    expect(typeof mod.getEnv).toBe('function');
  });

  it('should export Env type', async () => {
    const mod = await import('../../src/config/env.js');
    const env = mod.getEnv();
    expect(env).toBeDefined();
    expect(typeof env.PORT).toBe('number');
    expect(typeof env.NODE_ENV).toBe('string');
  });
});

describe('compactPath', () => {
  it('renders an empty path as (root)', async () => {
    const { compactPath } = await import('../../src/config/env.js');
    expect(compactPath([])).toBe('(root)');
  });

  it('joins string segments with dots', async () => {
    const { compactPath } = await import('../../src/config/env.js');
    expect(compactPath(['telemetry', 'devices', 'value'])).toBe('telemetry.devices.value');
  });

  it('renders numeric (array index) segments in bracket notation', async () => {
    const { compactPath } = await import('../../src/config/env.js');
    expect(compactPath(['telemetry', 'devices', 42, 'readings', 7, 'value'])).toBe(
      'telemetry.devices[42].readings[7].value',
    );
  });
});

describe('formatEnvIssues', () => {
  it('returns one structured entry per Zod issue, preserving path/code/message', async () => {
    const { formatEnvIssues } = await import('../../src/config/env.js');
    const schema = z.object({ PORT: z.number(), JWT_SECRET: z.string().min(32) });
    const result = schema.safeParse({ PORT: 'not-a-number', JWT_SECRET: 'short' });
    expect(result.success).toBe(false);
    if (result.success) return;

    const issues = formatEnvIssues(result.error);
    expect(issues).toHaveLength(2);

    const port = issues.find((i) => i.path === 'PORT');
    expect(port).toBeDefined();
    expect(port?.code).toBe('invalid_type');
    expect(port?.message.length).toBeGreaterThan(0);

    const secret = issues.find((i) => i.path === 'JWT_SECRET');
    expect(secret).toBeDefined();
    expect(secret?.code).toBe('too_small');
  });

  it('preserves a deeply nested path in full without truncation (issue #69)', async () => {
    const { formatEnvIssues, compactPath } = await import('../../src/config/env.js');

    // Build a >300-char path that would have been truncated at 256 chars by the
    // old formatter, then assert the structured output keeps every segment.
    const deepPath: (string | number)[] = ['telemetry'];
    for (let device = 0; device < 20; device++) {
      deepPath.push('devices', device, 'readings', device, 'measurementValue');
    }
    const expected = compactPath(deepPath);
    expect(expected.length).toBeGreaterThan(300);

    const error = new z.ZodError([{ code: 'custom', path: deepPath, message: 'failing field' }]);
    const issues = formatEnvIssues(error);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe(expected);
    expect(issues[0]?.path).toContain('measurementValue');
    expect(issues[0]?.path.length).toBeGreaterThan(256);
  });
});

describe('tenantContext', () => {
  it('returns the AsyncLocalStorage tenant while the context is active', async () => {
    const { runWithTenantContext, tenantContext } = await import('../../src/config/index.js');

    const tenantId = runWithTenantContext('tenant-a', () => tenantContext());

    expect(tenantId).toBe('tenant-a');
  });

  it('falls back to the current request x-tenant-id header when ALS is unavailable', async () => {
    const { setCurrentTenantRequest, clearCurrentTenantRequest, tenantContext } =
      await import('../../src/config/index.js');
    const request = {
      headers: { 'x-tenant-id': 'tenant-from-header' },
    };

    setCurrentTenantRequest(request as never);
    try {
      expect(tenantContext()).toBe('tenant-from-header');
    } finally {
      clearCurrentTenantRequest(request as never);
    }
  });
});

// --- Mock Redis for two-phase commit config tests ---
class SimpleMockRedis {
  private store = new Map<string, string>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key) ?? null);
  }

  set(key: string, value: string): Promise<'OK'> {
    this.store.set(key, value);
    return Promise.resolve('OK');
  }

  exists(key: string): Promise<number> {
    return Promise.resolve(this.store.has(key) ? 1 : 0);
  }

  rename(src: string, dest: string): Promise<'OK'> {
    const val = this.store.get(src);
    if (val === undefined) {
      return Promise.reject(new Error(`ERR no such key: ${src}`));
    }
    this.store.set(dest, val);
    this.store.delete(src);
    return Promise.resolve('OK');
  }
}

describe('Versioned Config and Two-Phase Commit', () => {
  let generateMonotonicUUID: typeof generateMonotonicUUIDType;
  let getConfig: typeof getConfigType;
  let commitConfig: typeof commitConfigType;
  let initializeConfigWatcher: typeof initializeConfigWatcherType;
  let stopConfigWatcher: typeof stopConfigWatcherType;
  let processBatch: typeof processBatchType;
  let configTransitionEvents: Gauge;

  beforeAll(async () => {
    const configMod = await import('../../src/config/index.js');
    generateMonotonicUUID = configMod.generateMonotonicUUID;
    getConfig = configMod.getConfig;
    commitConfig = configMod.commitConfig;
    initializeConfigWatcher = configMod.initializeConfigWatcher;
    stopConfigWatcher = configMod.stopConfigWatcher;

    const validatorMod = await import('../../src/core/ingestion/validator.js');
    processBatch = validatorMod.processBatch;

    const prometheusMod = await import('../../src/api/metrics/prometheus.js');
    configTransitionEvents = prometheusMod.configTransitionEvents;
  });

  beforeEach(() => {
    configTransitionEvents.reset();
  });

  it('should generate monotonic UUIDs', () => {
    const uuids: string[] = [];
    for (let i = 0; i < 50; i++) {
      uuids.push(generateMonotonicUUID());
    }
    // Verify uniqueness
    const unique = new Set(uuids);
    expect(unique.size).toBe(50);
    // Verify sorting order
    const sorted = [...uuids].sort();
    expect(uuids).toEqual(sorted);
  });

  it('should support two-phase commit and update current config in watcher', async () => {
    const redis = new SimpleMockRedis() as unknown as Redis;

    // Start watcher
    await initializeConfigWatcher(redis, 10);

    try {
      const initialConfig = getConfig();
      expect(initialConfig.tiers['TIER_2']?.max).toBe(10000);

      const newTiers: Record<string, BillingTier> = {
        TIER_1: { min: 0, max: 500 },
        TIER_2: { min: 501, max: 50000 },
        TIER_3: { min: 50001, max: Infinity },
      };

      // Commit new config via 2PC
      const newVersionId = await commitConfig(redis, newTiers, 20);
      expect(newVersionId).toBeDefined();

      // Wait for watcher to poll
      await new Promise((resolve) => setTimeout(resolve, 50));

      const updatedConfig = getConfig();
      expect(updatedConfig.version_id).toBe(newVersionId);
      expect(updatedConfig.tiers['TIER_2']?.max).toBe(50000);
    } finally {
      stopConfigWatcher();
    }
  });

  it('should re-process the batch and avoid mixed-version processing if config changes mid-batch', async () => {
    const redis = new SimpleMockRedis() as unknown as Redis;

    // Start config watcher
    await initializeConfigWatcher(redis, 10);

    try {
      const initialConfig = getConfig();
      const initialVersionId = initialConfig.version_id;

      // Define a batch of events
      const events: TelemetryEvent[] = [
        { deviceId: 'dev-1', value: 2000 },
        { deviceId: 'dev-2', value: 3000 },
        { deviceId: 'dev-3', value: 4000 },
      ];

      // Process batch asynchronously with a delay between items (e.g. 20ms)
      const processPromise = processBatch(events, 20);

      // Mid-batch, we update the configuration!
      // Initial: TIER_2 is [1001, 10000]. 2000 is TIER_2.
      // New config: TIER_2 is [1001, 1500]. TIER_3 is [1501, Infinity]. 2000 will be TIER_3.
      const newTiers: Record<string, BillingTier> = {
        TIER_1: { min: 0, max: 1000 },
        TIER_2: { min: 1001, max: 1500 },
        TIER_3: { min: 1501, max: Infinity },
      };

      // We trigger the commit after 15ms so it falls exactly in the middle of processing the 3 events
      await new Promise((resolve) => setTimeout(resolve, 15));
      const newVersionId = await commitConfig(redis, newTiers, 0); // 0 delay for commit in test

      // Wait for watcher to pick up the new config (watcher polls every 10ms)
      await new Promise((resolve) => setTimeout(resolve, 15));

      const result = await processPromise;

      // The result must be processed entirely with the new configuration version
      expect(result.versionId).toBe(newVersionId);
      for (const res of result.results) {
        expect(res.tier).toBe('TIER_3'); // since 2000, 3000, 4000 are all >= 1501, so TIER_3
      }

      // Verify that the configTransitionEvents gauge was incremented
      const metricValue = await configTransitionEvents.get();
      const total = metricValue.values.reduce((sum, item) => sum + item.value, 0);
      expect(total).toBeGreaterThanOrEqual(1);

      // Make sure the labels on the gauge are correct
      const transitions = metricValue.values.filter((item) => item.value > 0);
      expect(transitions.length).toBeGreaterThanOrEqual(1);
      const transition = transitions[0];
      expect(transition).toBeDefined();
      if (transition !== undefined) {
        expect(transition.labels['start_version']).toBe(initialVersionId);
        expect(transition.labels['end_version']).toBe(newVersionId);
      }
    } finally {
      stopConfigWatcher();
    }
  });
});
