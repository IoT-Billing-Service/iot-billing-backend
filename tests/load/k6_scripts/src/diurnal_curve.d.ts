/** Type declarations for the pure JS diurnal-curve model (issue #66). */

export interface DiurnalOptions {
  base?: number;
  amplitude?: number;
  peakHour?: number;
  minRate?: number;
  spikeMultiplier?: number;
  secondsPerHour?: number;
  spikeAtHour?: number;
  spikeDurationSec?: number;
}

export interface DiurnalStage {
  duration: string;
  target: number;
}

export const DIURNAL_DEFAULTS: Required<
  Pick<DiurnalOptions, 'base' | 'amplitude' | 'peakHour' | 'minRate' | 'spikeMultiplier'>
>;

export function diurnalRate(hour: number, opts?: DiurnalOptions): number;
export function buildDiurnalStages(opts?: DiurnalOptions): DiurnalStage[];
export function peakTarget(opts?: DiurnalOptions): number;
