import { describe, it, expect, beforeAll } from 'vitest';
import { z } from 'zod';

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
