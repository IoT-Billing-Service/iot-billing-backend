import { processFrame, type TelemetryFrame } from './frameProcessor.js';

export const CATCH_UP_BATCH_SIZE = 10;

export interface ReconnectState {
  deviceId: string;
  lastProcessedSequence: number;
}

/**
 * Processes a burst of missed catch-up frames in strict sequence order.
 *
 * Frames are sorted by sequence number, then processed in batches of
 * CATCH_UP_BATCH_SIZE sequentially (async for-of), so the downstream billing
 * processor always receives frames in ascending sequence order.
 *
 * Catch-up throughput is not latency-sensitive, so the sequential cost is
 * acceptable. This replaces the prior Promise.all() that allowed frame 150
 * to complete before frame 100, causing wrong tariff rates to be applied.
 */
export async function processCatchUp(
  frames: TelemetryFrame[],
  state: ReconnectState,
): Promise<ReconnectState> {
  const sorted = [...frames].sort((a, b) => a.sequence - b.sequence);

  for (let i = 0; i < sorted.length; i += CATCH_UP_BATCH_SIZE) {
    const batch = sorted.slice(i, i + CATCH_UP_BATCH_SIZE);
    for (const frame of batch) {
      await processFrame(frame, state.lastProcessedSequence);
      state = { ...state, lastProcessedSequence: frame.sequence };
    }
  }

  return state;
}
