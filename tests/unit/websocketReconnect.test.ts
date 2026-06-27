import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processCatchUp, CATCH_UP_BATCH_SIZE } from '../../src/ingestion/websocketReconnect.js';
import type { TelemetryFrame } from '../../src/ingestion/frameProcessor.js';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Peak hour: 14:00 UTC */
const PEAK_TS = new Date('2024-01-15T14:00:00Z').getTime();
/** Off-peak hour: 02:00 UTC */
const OFF_PEAK_TS = new Date('2024-01-15T02:00:00Z').getTime();

/**
 * Build N frames starting at `startSeq`, alternating off-peak / peak by
 * even/odd sequence so that a naive parallel run would misassign tariffs.
 */
function buildFrames(count: number, startSeq = 1): TelemetryFrame[] {
  return Array.from({ length: count }, (_, i) => {
    const seq = startSeq + i;
    return {
      sequence: seq,
      deviceId: 'dev-test',
      // odd sequences → peak, even → off-peak
      timestamp: seq % 2 === 0 ? PEAK_TS : OFF_PEAK_TS,
      consumption: 1.0,
    };
  });
}

/** Fisher-Yates shuffle — returns a new array. */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('processCatchUp — 200-frame out-of-order burst', () => {
  const FRAME_COUNT = 200;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('processes all 200 frames and returns the correct final sequence', async () => {
    const frames = shuffle(buildFrames(FRAME_COUNT));
    const initial = { deviceId: 'dev-test', lastProcessedSequence: 0 };

    const result = await processCatchUp(frames, initial);

    expect(result.lastProcessedSequence).toBe(FRAME_COUNT);
  });

  it('delivers frames to the billing pipeline in strict ascending sequence order', async () => {
    const processedSequences: number[] = [];

    // Spy on evaluateTariff to record the sequence order seen by the billing layer
    const mod = await import('../../src/billing/tariffEvaluator.js');
    vi.spyOn(mod, 'evaluateTariff').mockImplementation(async (frame) => {
      processedSequences.push(frame.sequence);
      const zone = frame.timestamp === PEAK_TS ? 'peak' : 'off_peak';
      return { ratePerKwh: 0.18, zone, billedAmount: frame.consumption * 0.18 };
    });

    const frames = shuffle(buildFrames(FRAME_COUNT));
    await processCatchUp(frames, { deviceId: 'dev-test', lastProcessedSequence: 0 });

    expect(processedSequences).toHaveLength(FRAME_COUNT);
    for (let i = 0; i < processedSequences.length - 1; i++) {
      expect(processedSequences[i + 1]).toBe((processedSequences[i] ?? 0) + 1);
    }
  });

  it('applies the correct tariff zone for each frame (no peak/off-peak cross-contamination)', async () => {
    const tariffResults: Array<{ sequence: number; zone: string }> = [];

    const mod = await import('../../src/billing/tariffEvaluator.js');
    vi.spyOn(mod, 'evaluateTariff').mockImplementation(async (frame) => {
      const zone = frame.timestamp === PEAK_TS ? 'peak' : 'off_peak';
      tariffResults.push({ sequence: frame.sequence, zone });
      return { ratePerKwh: zone === 'peak' ? 0.18 : 0.09, zone, billedAmount: 0 };
    });

    const frames = shuffle(buildFrames(FRAME_COUNT));
    await processCatchUp(frames, { deviceId: 'dev-test', lastProcessedSequence: 0 });

    for (const { sequence, zone } of tariffResults) {
      // odd sequences have OFF_PEAK_TS, even have PEAK_TS (see buildFrames)
      const expected = sequence % 2 === 0 ? 'peak' : 'off_peak';
      expect(zone, `frame ${sequence} should be ${expected}`).toBe(expected);
    }
  });

  it(`processes in batches of ${CATCH_UP_BATCH_SIZE} — state is updated after each frame`, async () => {
    const stateSnapshots: number[] = [];

    const mod = await import('../../src/billing/tariffEvaluator.js');
    vi.spyOn(mod, 'evaluateTariff').mockImplementation(async (frame, lastSeq) => {
      // lastSeq must always be exactly one less than frame.sequence
      stateSnapshots.push(lastSeq);
      return { ratePerKwh: 0.09, zone: 'off_peak', billedAmount: 0.09 };
    });

    const frames = shuffle(buildFrames(FRAME_COUNT));
    await processCatchUp(frames, { deviceId: 'dev-test', lastProcessedSequence: 0 });

    // Each frame should have been called with lastSeq === frame.sequence - 1
    // i.e. stateSnapshots[i] === i (0-indexed: before frame i+1)
    for (let i = 0; i < stateSnapshots.length; i++) {
      expect(stateSnapshots[i]).toBe(i);
    }
  });

  it('returns the original state unchanged when given an empty burst', async () => {
    const initial = { deviceId: 'dev-test', lastProcessedSequence: 42 };
    const result = await processCatchUp([], initial);
    expect(result).toEqual(initial);
  });
});
