import { evaluateTariff, type TariffResult } from '../billing/tariffEvaluator.js';

export interface TelemetryFrame {
  sequence: number;
  deviceId: string;
  timestamp: number; // Unix ms
  consumption: number; // kWh (7-decimal precision)
}

export interface FrameProcessingResult {
  frame: TelemetryFrame;
  tariff: TariffResult;
}

/**
 * Processes a single telemetry frame through the billing pipeline.
 *
 * @param frame - The frame to process.
 * @param lastProcessedSequence - The sequence number of the previously
 *   processed frame. Passed to the tariff evaluator's sequence gate.
 */
export async function processFrame(
  frame: TelemetryFrame,
  lastProcessedSequence: number,
): Promise<FrameProcessingResult> {
  const tariff = await evaluateTariff(frame, lastProcessedSequence);
  return { frame, tariff };
}
