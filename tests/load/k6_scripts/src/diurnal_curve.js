/**
 * Pure, dependency-free model of the production diurnal traffic curve
 * (issue #66). Kept free of any k6 or Node imports so it can be both
 * (a) bundled into the k6 `diurnal_pattern` snapshot and (b) imported
 * directly by a Vitest unit test to verify the curve math.
 *
 * Production traffic follows a diurnal sine wave with shift-change peaks,
 * on top of which firmware rollouts produce a short, very large spike as
 * every device reconnects at once.
 *
 *   events_per_second(hour) = BASE + AMPLITUDE * sin(2*PI*(hour - PEAK_HOUR)/24)
 *
 * Note on phase: the issue's literal `sin` form crosses its mean (not its
 * maximum) at PEAK_HOUR — the true peak lands 6h later. Since the variable
 * is named PEAK_HOUR and the intent is "traffic peaks at midday", we phase
 * the wave by a quarter-day so its MAXIMUM lands exactly on PEAK_HOUR
 * (algebraically `sin(x + PI/2) == cos(x)`). Peak at PEAK_HOUR, trough 12h
 * away, mean at +-6h.
 *
 * The raw wave can go below zero (when AMPLITUDE > BASE), which is not a
 * valid arrival rate, so every rate is clamped to a positive floor.
 */

export const DIURNAL_DEFAULTS = {
  base: 1000,
  amplitude: 2000,
  // 12:00 UTC midday peak; shift changes at 09:00/12:00/18:00 all sit on
  // the rising/peak portion of a midday-centred sine.
  peakHour: 12,
  // Arrival rate is never allowed below this floor (a sine trough with
  // amplitude > base would otherwise demand a negative rate).
  minRate: 100,
  // Firmware rollout: every device reconnects at once -> 10x the base rate.
  spikeMultiplier: 10,
};

/**
 * Diurnal arrival rate (events/sec) for a given hour-of-day, clamped to a
 * positive integer floor.
 *
 * @param {number} hour - hour of day, may be fractional (e.g. 9.5)
 * @param {object} [opts]
 * @returns {number} events per second (>= minRate, integer)
 */
export function diurnalRate(hour, opts = {}) {
  const { base, amplitude, peakHour, minRate } = { ...DIURNAL_DEFAULTS, ...opts };
  const radians = (2 * Math.PI * (hour - peakHour)) / 24;
  // Phase-shifted so the maximum lands on peakHour (sin(x + PI/2) == cos(x)).
  const raw = base + amplitude * Math.cos(radians);
  return Math.max(minRate, Math.round(raw));
}

/**
 * Build the `ramping-arrival-rate` stage list for one compressed 24-hour
 * day. Each simulated hour is mapped to `secondsPerHour` of wall-clock
 * time; the target of each stage is the diurnal rate for that hour. A
 * single firmware-rollout spike stage is injected at `spikeAtHour`.
 *
 * @param {object} [opts]
 * @param {number} [opts.secondsPerHour=5]  wall-clock seconds per simulated hour
 * @param {number} [opts.spikeAtHour=12]     hour at which the firmware spike fires
 * @param {number} [opts.spikeDurationSec=10] duration of the spike stage
 * @returns {{duration: string, target: number}[]} k6 ramping-arrival-rate stages
 */
export function buildDiurnalStages(opts = {}) {
  const cfg = { ...DIURNAL_DEFAULTS, ...opts };
  const secondsPerHour = opts.secondsPerHour ?? 5;
  const spikeAtHour = opts.spikeAtHour ?? cfg.peakHour;
  const spikeDurationSec = opts.spikeDurationSec ?? 10;
  const spikeRate = cfg.base * cfg.spikeMultiplier;

  const stages = [];
  for (let hour = 0; hour < 24; hour++) {
    stages.push({
      duration: `${String(secondsPerHour)}s`,
      target: diurnalRate(hour, cfg),
    });
    // Inject the firmware-rollout spike at the start of the target hour:
    // ramp sharply up to 10x base, hold briefly, then drop back to the
    // diurnal rate so the rest of the curve continues normally.
    if (hour === spikeAtHour) {
      stages.push({ duration: '1s', target: spikeRate });
      stages.push({ duration: `${String(spikeDurationSec)}s`, target: spikeRate });
      stages.push({ duration: '1s', target: diurnalRate(hour, cfg) });
    }
  }
  return stages;
}

/** Peak target across the whole day, including the firmware spike. */
export function peakTarget(opts = {}) {
  return Math.max(...buildDiurnalStages(opts).map((s) => s.target));
}
