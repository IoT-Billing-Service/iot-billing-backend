/**
 * Production trace replay (issue #66, blueprint item 2).
 *
 * The synthetic profiles (steady_state / burst / recovery) only approximate
 * production timing. The `production` profile instead *replays a captured
 * trace* of real event timestamps so the test reproduces the actual diurnal
 * shape and firmware-rollout spikes that occur in the field.
 *
 * Trace format (CSV, one event per line):
 *
 *   timestampMs[,deviceId]
 *
 * - A header row (`timestampMs,deviceId` or `offsetMs,...`) is optional and
 *   detected/skipped automatically.
 * - `timestampMs` may be absolute epoch ms or a relative offset; offsets are
 *   always computed relative to the earliest event, so either works.
 * - `deviceId` is optional; events sharing a deviceId reuse one signing key,
 *   matching how a real device emits a stream.
 *
 * The replay asserts the two invariants the issue calls out: P99 latency
 * under 500ms and zero dropped events.
 */

import { performance } from 'node:perf_hooks';
import {
  type LatencyHistogram,
  computeLatencyHistogram,
  type SignedTelemetryPayload,
} from './types.js';
import {
  generateDevice,
  buildUnsignedPayload,
  signPayload,
  type SimulatedDevice,
} from './sign_payload.js';

export interface TraceEvent {
  /** Milliseconds after the earliest event in the trace. */
  offsetMs: number;
  deviceId: string;
}

export interface ReplayResult {
  totalEvents: number;
  accepted: number;
  rejected: number;
  /** Dropped == transport/connection errors (never reached the server). */
  dropped: number;
  latency: LatencyHistogram;
  /** Issue #66 invariants. */
  p99TargetMs: number;
  p99Met: boolean;
  zeroDropped: boolean;
  passed: boolean;
}

export interface ReplayOptions {
  targetUrl: string;
  trace: readonly TraceEvent[];
  /** P99 latency budget in ms. Defaults to the issue's 500ms. */
  p99TargetMs?: number;
  /**
   * Compress (or stretch) the captured timeline by this factor. 1 = real
   * time; 0 = fire everything immediately (used by unit tests so they don't
   * wait out the original wall-clock span). Defaults to 1.
   */
  timeScale?: number;
  log?: (msg: string) => void;
}

const DEFAULT_P99_TARGET_MS = 500;
const INGEST_PATH = '/ingest';

/**
 * Parse a CSV trace into ordered {@link TraceEvent}s with offsets relative to
 * the earliest event. Blank lines are skipped; a leading non-numeric header
 * row is detected and ignored.
 */
export function parseTrace(csv: string): TraceEvent[] {
  const rows = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (rows.length === 0) return [];

  // Detect and drop a header row: first column is not a number.
  const firstCol = (rows[0] ?? '').split(',')[0]?.trim() ?? '';
  if (firstCol === '' || Number.isNaN(Number(firstCol))) {
    rows.shift();
  }

  // Parse to absolute timestamps first so the offset baseline is the EARLIEST
  // event, not merely the first row (captured traces are not always sorted).
  const absolute: { ts: number; deviceId: string }[] = rows.map((row, index) => {
    const cols = row.split(',');
    const ts = Number(cols[0]?.trim());
    if (Number.isNaN(ts)) {
      throw new Error(`Trace row ${String(index)} has a non-numeric timestamp: "${row}"`);
    }
    const deviceId = cols[1]?.trim();
    return {
      ts,
      deviceId:
        deviceId !== undefined && deviceId !== '' ? deviceId : `trace-device-${String(index)}`,
    };
  });

  const baseline = Math.min(...absolute.map((e) => e.ts));
  return absolute
    .map((e) => ({ offsetMs: e.ts - baseline, deviceId: e.deviceId }))
    .sort((a, b) => a.offsetMs - b.offsetMs);
}

function ingestUrl(targetUrl: string): string {
  const url = new URL(targetUrl);
  url.pathname = INGEST_PATH;
  url.search = '';
  return url.toString();
}

async function postEvent(
  url: string,
  device: SimulatedDevice,
): Promise<{ outcome: 'accepted' | 'rejected' | 'dropped'; latencyMs: number }> {
  const payload: SignedTelemetryPayload = signPayload(device, buildUnsignedPayload(device));
  const body = JSON.stringify({ payload, publicKey: device.publicKeyHex });
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const latencyMs = performance.now() - startedAt;
    let accepted = false;
    try {
      const parsed = (await response.json()) as { status?: string };
      accepted = response.ok && parsed.status === 'accepted';
    } catch {
      accepted = false;
    }
    return { outcome: accepted ? 'accepted' : 'rejected', latencyMs };
  } catch {
    // Connection refused / reset / timeout == the event never landed.
    return { outcome: 'dropped', latencyMs: performance.now() - startedAt };
  }
}

/**
 * Replay a parsed trace against an ingestion endpoint, preserving the
 * captured inter-event timing (scaled by {@link ReplayOptions.timeScale}).
 */
export async function replayTrace(opts: ReplayOptions): Promise<ReplayResult> {
  const log = opts.log ?? ((): void => undefined);
  const p99TargetMs = opts.p99TargetMs ?? DEFAULT_P99_TARGET_MS;
  const timeScale = opts.timeScale ?? 1;
  const url = ingestUrl(opts.targetUrl);

  // One signing identity per distinct deviceId in the trace.
  const devices = new Map<string, SimulatedDevice>();
  let nextId = 0;
  const deviceFor = (deviceId: string): SimulatedDevice => {
    let device = devices.get(deviceId);
    if (device === undefined) {
      device = { ...generateDevice(nextId++), deviceId };
      devices.set(deviceId, device);
    }
    return device;
  };

  const latencies: number[] = [];
  let accepted = 0;
  let rejected = 0;
  let dropped = 0;

  const startedAt = performance.now();
  const inFlight: Promise<void>[] = [];

  for (const event of opts.trace) {
    const dueAt = startedAt + event.offsetMs * timeScale;
    const wait = dueAt - performance.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    const device = deviceFor(event.deviceId);
    inFlight.push(
      postEvent(url, device).then(({ outcome, latencyMs }) => {
        if (latencyMs > 0) latencies.push(latencyMs);
        if (outcome === 'accepted') accepted += 1;
        else if (outcome === 'rejected') rejected += 1;
        else dropped += 1;
      }),
    );
  }

  await Promise.all(inFlight);

  const latency = computeLatencyHistogram(latencies);
  const p99Met = latency.p99Ms <= p99TargetMs;
  const zeroDropped = dropped === 0;
  const result: ReplayResult = {
    totalEvents: opts.trace.length,
    accepted,
    rejected,
    dropped,
    latency,
    p99TargetMs,
    p99Met,
    zeroDropped,
    passed: p99Met && zeroDropped,
  };
  log(
    `[replay] events=${String(result.totalEvents)} accepted=${String(accepted)} ` +
      `rejected=${String(rejected)} dropped=${String(dropped)} ` +
      `p99=${latency.p99Ms.toFixed(2)}ms target=${String(p99TargetMs)}ms passed=${String(result.passed)}`,
  );
  return result;
}
