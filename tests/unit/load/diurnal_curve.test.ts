import { describe, it, expect } from 'vitest';
import {
  diurnalRate,
  buildDiurnalStages,
  peakTarget,
  DIURNAL_DEFAULTS,
} from '../../load/k6_scripts/src/diurnal_curve.js';

describe('diurnalRate', () => {
  it('peaks at the configured peak hour', () => {
    const peak = diurnalRate(DIURNAL_DEFAULTS.peakHour);
    // At peak hour the sine term is +1, so rate ~= base + amplitude.
    expect(peak).toBe(DIURNAL_DEFAULTS.base + DIURNAL_DEFAULTS.amplitude);
  });

  it('never returns a rate below the floor, even in the trough', () => {
    // 12h from peak the sine is -1 -> base - amplitude = -1000 (invalid),
    // which must clamp to the floor instead of going negative.
    const trough = diurnalRate(DIURNAL_DEFAULTS.peakHour + 12);
    expect(trough).toBe(DIURNAL_DEFAULTS.minRate);
    expect(trough).toBeGreaterThan(0);
  });

  it('returns the mean (base) a quarter-cycle (6h) off peak', () => {
    expect(diurnalRate(DIURNAL_DEFAULTS.peakHour - 6)).toBe(DIURNAL_DEFAULTS.base);
  });

  it('honors overrides', () => {
    const rate = diurnalRate(0, { base: 500, amplitude: 100, peakHour: 0, minRate: 1 });
    expect(rate).toBe(600);
  });
});

describe('buildDiurnalStages', () => {
  it('produces a stage for every simulated hour plus the firmware spike', () => {
    const stages = buildDiurnalStages();
    // 24 hourly stages + 3 spike stages (ramp-up, hold, ramp-down).
    expect(stages).toHaveLength(24 + 3);
  });

  it('injects a 10x-base firmware spike', () => {
    const stages = buildDiurnalStages();
    const max = Math.max(...stages.map((s) => s.target));
    expect(max).toBe(DIURNAL_DEFAULTS.base * DIURNAL_DEFAULTS.spikeMultiplier);
    expect(peakTarget()).toBe(max);
  });

  it('all stage targets are positive integers with valid durations', () => {
    for (const stage of buildDiurnalStages()) {
      expect(Number.isInteger(stage.target)).toBe(true);
      expect(stage.target).toBeGreaterThan(0);
      expect(stage.duration).toMatch(/^\d+s$/);
    }
  });

  it('places the spike at the configured hour', () => {
    const stages = buildDiurnalStages({ spikeAtHour: 3, secondsPerHour: 2 });
    const spikeTarget = DIURNAL_DEFAULTS.base * DIURNAL_DEFAULTS.spikeMultiplier;
    const spikeIndex = stages.findIndex((s) => s.target === spikeTarget);
    // 4 hourly stages (0,1,2,3) precede the spike that follows hour 3.
    expect(spikeIndex).toBe(4);
  });
});
