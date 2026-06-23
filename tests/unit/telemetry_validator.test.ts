import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  validateTelemetryBatch,
  formatValidationError,
  resetValidationLogState,
  compactPath,
} from '../../src/core/ingestion/telemetry_validator.js';
import {
  MAX_DEVICES_PER_BATCH,
  MAX_READINGS_PER_DEVICE,
} from '../../src/core/ingestion/telemetry_schema.js';

/** Build a valid batch of `devices` x `readings`, optionally corrupting one field. */
function buildBatch(
  devices: number,
  readings: number,
  corrupt?: { device: number; reading: number; value: unknown },
): unknown {
  return {
    telemetry: {
      batchId: 'batch-001',
      devices: Array.from({ length: devices }, (_, d) => ({
        deviceId: `dev-${String(d)}`,
        readings: Array.from({ length: readings }, (_, r) => ({
          metricId: 'energy_kwh',
          value: corrupt?.device === d && corrupt.reading === r ? corrupt.value : 1.5,
          unit: 'kWh',
          recordedAt: 1_700_000_000,
        })),
      })),
    },
  };
}

describe('validateTelemetryBatch', () => {
  beforeEach(() => {
    resetValidationLogState();
    vi.restoreAllMocks();
  });

  it('accepts a well-formed batch and returns typed data', () => {
    const result = validateTelemetryBatch(buildBatch(2, 3));
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.data.telemetry.devices).toHaveLength(2);
    expect(result.data.telemetry.devices[0]?.readings).toHaveLength(3);
  });

  it('accepts a batch at the documented size limits (100 x 50)', () => {
    const result = validateTelemetryBatch(
      buildBatch(MAX_DEVICES_PER_BATCH, MAX_READINGS_PER_DEVICE),
    );
    expect(result.valid).toBe(true);
  });

  it('reports the complete nested path for a deep failure (issue #69)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    // 100 devices x 50 readings, with a bad value buried at [42].readings[7].
    const result = validateTelemetryBatch(
      buildBatch(MAX_DEVICES_PER_BATCH, MAX_READINGS_PER_DEVICE, {
        device: 42,
        reading: 7,
        value: 'not-a-number',
      }),
    );

    expect(result.valid).toBe(false);
    if (result.valid) return;
    const paths = result.issues.map((i) => i.path);
    expect(paths).toContain('telemetry.devices[42].readings[7].value');
  });

  it('emits one structured warn record per failing field, untruncated', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    validateTelemetryBatch(buildBatch(50, 50, { device: 42, reading: 7, value: 'not-a-number' }));

    expect(warn).toHaveBeenCalled();
    const record = JSON.parse(warn.mock.calls[0]?.[0] as string) as {
      event: string;
      path: string;
      code: string;
      received: unknown;
    };
    expect(record.event).toBe('telemetry.validation.issue');
    expect(record.path).toBe('telemetry.devices[42].readings[7].value');
    expect(record.code).toBe('invalid_type');
    expect(record.received).toBe('string');
  });

  it('rate-limits the verbose full dump to once per minute', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const bad = buildBatch(2, 2, { device: 0, reading: 0, value: 'x' });

    validateTelemetryBatch(bad);
    validateTelemetryBatch(bad);

    const modes = debug.mock.calls.map(
      (c) => (JSON.parse(c[0] as string) as { mode: string }).mode,
    );
    expect(modes[0]).toBe('full');
    expect(modes[1]).toBe('abbreviated');

    vi.setSystemTime(60_000);
    validateTelemetryBatch(bad);
    const after = JSON.parse(debug.mock.calls[2]?.[0] as string) as { mode: string };
    expect(after.mode).toBe('full');

    vi.useRealTimers();
  });
});

describe('formatValidationError / compactPath (issue #69)', () => {
  it('renders array indices in bracket notation', () => {
    expect(compactPath(['telemetry', 'devices', 42, 'readings', 7, 'value'])).toBe(
      'telemetry.devices[42].readings[7].value',
    );
  });

  it('preserves a >300-char path in full without truncation', () => {
    // Construct a path whose compacted string exceeds 300 chars — well past the
    // old 256-char log truncation limit that hid the failing field.
    const deepPath: (string | number)[] = ['telemetry'];
    for (let i = 0; i < 20; i++) {
      deepPath.push('devices', i, 'readings', i, 'measurementValue');
    }
    const expected = compactPath(deepPath);
    expect(expected.length).toBeGreaterThan(300);

    const error = new z.ZodError([{ code: 'custom', path: deepPath, message: 'failing field' }]);
    const issues = formatValidationError(error);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe(expected);
    expect(issues[0]?.path.length).toBeGreaterThan(256);
    expect(issues[0]?.path).toContain('measurementValue');
  });

  it('includes path, message, code and received for each issue', () => {
    const schema = z.object({ value: z.number() });
    const parsed = schema.safeParse({ value: 'nope' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const [issue] = formatValidationError(parsed.error);
    expect(issue?.path).toBe('value');
    expect(issue?.code).toBe('invalid_type');
    expect(issue?.message.length).toBeGreaterThan(0);
    expect(issue?.received).toBe('string');
  });
});
