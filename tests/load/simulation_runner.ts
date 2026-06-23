/**
 * High-Density Concurrent Simulated Load Testing Suite
 *
 * Mocks up to 50,000 active concurrent connections delivering real-time
 * telemetry inputs for system performance auditing.
 *
 * Usage:
 *   tsx tests/load/simulation_runner.ts [profile] [concurrentClients] [durationSec] [--http URL]
 *
 * Profiles (issue #20):
 *   - local         : legacy in-process `validateSignature` only.
 *                      Stays synchronous; useful for unit tests and CI smoke.
 *   - steady_state  : sustained 1 payload/sec/device load for `durationSec`.
 *   - burst         : 8 payloads/sec/device SHORT-window peak load.
 *   - recovery      : 0.25 payloads/sec/device - lets sliding-window + nonce
 *                      cache drain between bursts.
 *
 * When `--http URL` is provided (or env `LOAD_TARGET_URL`), the runner
 * spins up HTTP workers against that ingestion endpoint instead of
 * running the in-process check.
 */

import { validateSignature, type SignedPayload } from '../../src/core/ingestion/validator.js';
import nacl from 'tweetnacl';
import { Buffer } from 'node:buffer';
import { runLoad, profileDefaults, type RunLoadOptions } from './lib/run_load.js';
import { type LoadMetrics, type LoadProfile, type SimulationMetrics } from './lib/types.js';
import { parseTrace, replayTrace, type ReplayResult } from './lib/replay_trace.js';

interface SimulatedDevice {
  deviceId: string;
  keyPair: nacl.SignKeyPair;
}

function generateDevice(id: number): SimulatedDevice {
  return {
    deviceId: `sim-device-${id.toString().padStart(5, '0')}`,
    keyPair: nacl.sign.keyPair(),
  };
}

function generatePayload(device: SimulatedDevice): SignedPayload {
  const base = {
    deviceId: device.deviceId,
    timestamp: Date.now(),
    nonce: crypto.randomUUID(),
    metrics: {
      energy_kwh: Math.random() * 100,
      water_l: Math.random() * 50,
      gas_m3: Math.random() * 20,
      temperature: 15 + Math.random() * 30,
    },
  };
  const message = Buffer.from(JSON.stringify(base), 'utf-8');
  const signature = Buffer.from(nacl.sign.detached(message, device.keyPair.secretKey)).toString(
    'hex',
  );
  return { ...base, signature };
}

async function simulateClient(
  device: SimulatedDevice,
  durationMs: number,
  report: (latency: number, accepted: boolean) => void,
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < durationMs) {
    try {
      const payload = generatePayload(device);
      const t0 = performance.now();
      const result = validateSignature(device.keyPair.publicKey, payload);
      const latency = performance.now() - t0;
      report(latency, result.valid);
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 200));
    } catch {
      report(0, false);
    }
  }
}

async function runSimulation(
  concurrentClients: number,
  durationSec: number,
): Promise<SimulationMetrics> {
  console.log(
    `Starting local simulation: ${String(concurrentClients)} clients for ${String(durationSec)}s`,
  );

  const latencies: number[] = [];
  let accepted = 0;
  let rejected = 0;
  const errors = 0;

  const report = (latency: number, accepted_: boolean): void => {
    if (latency > 0) latencies.push(latency);
    if (accepted_) accepted++;
    else rejected++;
  };

  const devices: SimulatedDevice[] = [];
  for (let i = 0; i < concurrentClients; i++) {
    devices.push(generateDevice(i));
  }

  const durationMs = durationSec * 1000;
  const startTime = Date.now();

  const workers = devices.map((device) => simulateClient(device, durationMs, report));
  await Promise.all(workers);

  const elapsedSec = (Date.now() - startTime) / 1000;
  const sortedLatencies = [...latencies].sort(compareNumbers);
  const n = sortedLatencies.length;
  const avgLatencyMs = n > 0 ? sortedLatencies.reduce((a, b) => a + b, 0) / n : 0;
  const p95 = n > 0 ? Math.floor(n * 0.95) : 0;
  const p99 = n > 0 ? Math.floor(n * 0.99) : 0;
  const p95LatencyMs = p95 > 0 ? (sortedLatencies[p95] ?? 0) : 0;
  const p99LatencyMs = p99 > 0 ? (sortedLatencies[p99] ?? 0) : 0;

  return {
    totalPayloads: accepted + rejected + errors,
    accepted,
    rejected,
    errors,
    avgLatencyMs,
    p95LatencyMs,
    p99LatencyMs,
    throughputPerSec: elapsedSec > 0 ? (accepted + rejected) / elapsedSec : 0,
  };
}

function compareNumbers(a: number, b: number): number {
  return a - b;
}

interface ParsedArgs {
  profile: LoadProfile;
  concurrentClients: number;
  durationSec: number;
  targetUrl: string | null;
  writeJsonPath: string | null;
  tracePath: string | null;
}

const NAMED_PROFILES: readonly LoadProfile[] = [
  'steady_state',
  'burst',
  'recovery',
  'local',
  'production',
];

function isLoadProfile(value: string): value is LoadProfile {
  return (NAMED_PROFILES as readonly string[]).includes(value);
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = [...argv];
  let profile: LoadProfile = 'local';
  let concurrentClients = 1000;
  let durationSec = 30;
  let targetUrl: string | null = null;
  let writeJsonPath: string | null = null;
  let tracePath: string | null = null;

  const first = args.shift();
  if (first !== undefined && isLoadProfile(first)) {
    profile = first;
  } else if (first !== undefined && /^\d+$/.test(first)) {
    concurrentClients = Number.parseInt(first, 10);
  }

  while (args.length > 0) {
    const token = args.shift();
    if (token === '--http' && args.length > 0) {
      targetUrl = args.shift() ?? null;
    } else if (token === '--json' && args.length > 0) {
      writeJsonPath = args.shift() ?? null;
    } else if (token === '--trace' && args.length > 0) {
      tracePath = args.shift() ?? null;
    } else if (token !== undefined && /^\d+$/.test(token)) {
      if (concurrentClients === 1000) {
        concurrentClients = Number.parseInt(token, 10);
      } else {
        durationSec = Number.parseInt(token, 10);
      }
    }
  }

  if (targetUrl == null) {
    const env = process.env['LOAD_TARGET_URL'];
    if (env !== undefined && env !== '') {
      targetUrl = env;
    }
  }

  return { profile, concurrentClients, durationSec, targetUrl, writeJsonPath, tracePath };
}

/**
 * Production profile: replay a captured CSV trace of real event timestamps
 * against the ingestion target, asserting P99 < 500ms and zero dropped
 * events (issue #66, blueprint item 2).
 */
async function runProductionReplay(targetUrl: string, tracePath: string): Promise<ReplayResult> {
  const fs = await import('node:fs');
  const csv = await fs.promises.readFile(tracePath, 'utf-8');
  const trace = parseTrace(csv);
  console.log(
    `[simulation_runner] production replay: ${String(trace.length)} events ` +
      `from ${tracePath} -> ${targetUrl}`,
  );
  const result = await replayTrace({
    targetUrl,
    trace,
    log: (msg) => {
      console.log(msg);
    },
  });
  if (!result.passed) {
    throw new Error(
      `Production replay failed invariants: p99Met=${String(result.p99Met)} ` +
        `(p99=${result.latency.p99Ms.toFixed(2)}ms target=${String(result.p99TargetMs)}ms) ` +
        `zeroDropped=${String(result.zeroDropped)} (dropped=${String(result.dropped)})`,
    );
  }
  return result;
}

export async function runProfile(
  profile: LoadProfile,
  targetUrl: string,
  concurrentClients: number,
  durationSec: number,
  extraOpts: Partial<RunLoadOptions> = {},
): Promise<LoadMetrics> {
  const defaults = profileDefaults(profile);
  console.log(
    `[simulation_runner] HTTP profile=${profile} clients=${String(concurrentClients)} ` +
      `duration=${String(durationSec)}s target=${targetUrl} ` +
      `payloadsPerSec=${String(defaults.payloadsPerSec)}`,
  );
  return runLoad({
    profile,
    targetUrl,
    concurrentClients,
    durationSec,
    payloadsPerSec: defaults.payloadsPerSec,
    ...extraOpts,
  });
}

async function main(): Promise<void> {
  const { profile, concurrentClients, durationSec, targetUrl, writeJsonPath, tracePath } =
    parseArgs(process.argv.slice(2));

  let metrics: LoadMetrics | SimulationMetrics | ReplayResult;
  if (profile === 'production') {
    if (targetUrl === null) {
      throw new Error('production profile requires an HTTP target (--http URL or LOAD_TARGET_URL)');
    }
    if (tracePath === null) {
      throw new Error('production profile requires a captured trace (--trace path/to/trace.csv)');
    }
    metrics = await runProductionReplay(targetUrl, tracePath);
  } else if (profile === 'local' || targetUrl === null) {
    metrics = await runSimulation(concurrentClients, durationSec);
  } else {
    metrics = await runProfile(profile, targetUrl, concurrentClients, durationSec);
  }

  console.log('\n=== SIMULATION RESULTS ===');
  console.log(JSON.stringify(metrics, null, 2));

  if (writeJsonPath !== null) {
    const fs = await import('node:fs');
    await fs.promises.writeFile(writeJsonPath, JSON.stringify(metrics, null, 2), 'utf-8');
    console.log(`[simulation_runner] wrote metrics → ${writeJsonPath}`);
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('simulation_runner.ts')) {
  main()
    .then(() => {
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error('Simulation failed:', err);
      process.exit(1);
    });
}

export { runSimulation };
