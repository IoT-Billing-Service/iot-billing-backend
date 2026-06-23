/**
 * k6 diurnal-pattern profile (issue #66).
 *
 * Steady-state and burst profiles only ever exercise a flat or linearly
 * ramped load, so production's diurnal peaks (3x at shift changes) and the
 * 10x firmware-rollout spike went untested. This profile replays one
 * compressed 24-hour day as a sine wave plus a firmware spike, using the
 * shared {@link buildDiurnalStages} model, and fails fast on backpressure.
 *
 * Open-model `ramping-arrival-rate` keeps the *arrival rate* on the curve
 * regardless of how quickly VUs return, which is what we want when probing
 * for queue growth under a spike.
 *
 *   BASE_RATE        default 1000   (events/sec at the diurnal mean)
 *   AMPLITUDE        default 2000   (peak deviation from the mean)
 *   PEAK_HOUR        default 12     (UTC hour of the midday peak)
 *   SECONDS_PER_HOUR default 5      (wall-clock seconds per simulated hour)
 *   SPIKE_AT_HOUR    default 12     (hour the firmware rollout fires)
 *   SPIKE_MULTIPLIER default 10     (rollout = 10x base)
 *   TARGET_URL       default http://localhost:4000
 */

import http from 'k6/http';
import { check } from 'k6';
import { Rate, Counter } from 'k6/metrics';
import { generateDevice, generatePayload, encodeBody, defaultOptions } from './common.js';
import { buildBackpressureChecks, recordBackpressure } from './common.js';
import { buildDiurnalStages, peakTarget } from './diurnal_curve.js';

const curveOpts = {
  base: Number(__ENV.BASE_RATE ?? 1000),
  amplitude: Number(__ENV.AMPLITUDE ?? 2000),
  peakHour: Number(__ENV.PEAK_HOUR ?? 12),
  secondsPerHour: Number(__ENV.SECONDS_PER_HOUR ?? 5),
  spikeAtHour: Number(__ENV.SPIKE_AT_HOUR ?? 12),
  spikeMultiplier: Number(__ENV.SPIKE_MULTIPLIER ?? 10),
};
const TARGET_URL = __ENV.TARGET_URL ?? 'http://localhost:4000';

const stages = buildDiurnalStages(curveOpts);
const peak = peakTarget(curveOpts);

const backpressure = buildBackpressureChecks(Rate, Counter);

export const options = {
  scenarios: {
    diurnal: {
      executor: 'ramping-arrival-rate',
      startRate: stages[0].target,
      timeUnit: '1s',
      stages,
      // Allocate VUs for the peak arrival rate so the open model never
      // starves at the firmware spike.
      preAllocatedVUs: Math.min(peak, 2000),
      maxVUs: peak,
    },
  },
  thresholds: {
    http_req_duration: ['p(99)<500'],
    http_req_failed: ['rate<0.10'],
    ...backpressure.thresholds,
  },
  discardResponseBodies: true,
  ...defaultOptions(),
};

export default function () {
  const device = generateDevice(__VU);
  const { payload, fault } = generatePayload(device);
  const body = encodeBody(device, payload);
  const res = http.post(`${TARGET_URL}/ingest`, body, {
    tags: { fault: fault ?? 'none' },
  });
  recordBackpressure(backpressure.metrics, res);
  check(res, {
    'status below 500': (r) => r.status < 500,
  });
}
