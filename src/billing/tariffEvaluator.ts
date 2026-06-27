import type { TelemetryFrame } from '../ingestion/frameProcessor.js';

export interface TariffResult {
  ratePerKwh: number;
  zone: 'peak' | 'off_peak';
  billedAmount: number;
}

export class SequenceGapError extends Error {
  constructor(
    readonly expected: number,
    readonly received: number,
  ) {
    super(`Sequence gap: expected ${expected}, received ${received}`);
    this.name = 'SequenceGapError';
  }
}

const SEQUENCE_GAP_TIMEOUT_MS = 5_000;

// Peak hours: 08:00–20:00 UTC
function resolveZone(timestampMs: number): 'peak' | 'off_peak' {
  const hour = new Date(timestampMs).getUTCHours();
  return hour >= 8 && hour < 20 ? 'peak' : 'off_peak';
}

const RATES: Record<'peak' | 'off_peak', number> = {
  peak: 0.18,
  off_peak: 0.09,
};

/**
 * Sequence validation gate: ensures frame.sequence === lastProcessedSequence + 1
 * before evaluating the tariff. If not, waits up to SEQUENCE_GAP_TIMEOUT_MS for
 * the gap to close, then throws SequenceGapError.
 *
 * This prevents tariff misapplication when frames arrive out of order (e.g.
 * frame 150's peak rate being applied to frame 100's off-peak consumption).
 */
export async function evaluateTariff(
  frame: TelemetryFrame,
  lastProcessedSequence: number,
): Promise<TariffResult> {
  const expected = lastProcessedSequence + 1;

  if (frame.sequence !== expected) {
    await new Promise<void>((_, reject) =>
      setTimeout(
        () => reject(new SequenceGapError(expected, frame.sequence)),
        SEQUENCE_GAP_TIMEOUT_MS,
      ),
    );
  }

  const zone = resolveZone(frame.timestamp);
  const ratePerKwh = RATES[zone];
  return {
    ratePerKwh,
    zone,
    billedAmount: frame.consumption * ratePerKwh,
  };
}
