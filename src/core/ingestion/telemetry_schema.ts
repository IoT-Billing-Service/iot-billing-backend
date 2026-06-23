import { z } from 'zod';

/**
 * Schemas for an incoming telemetry batch.
 *
 * The shape is intentionally nested so the validation path to a failing field
 * is deep — `telemetry.devices[42].readings[7].value` — which is the scenario
 * issue #69 cares about. Bounds mirror the documented batch limits (up to 100
 * devices, each with up to 50 readings).
 */

export const MAX_DEVICES_PER_BATCH = 100;
export const MAX_READINGS_PER_DEVICE = 50;

/** A single sensor reading: the deepest level of the batch. */
export const ReadingSchema = z.object({
  metricId: z.string().min(1),
  value: z.number().finite(),
  unit: z.string().min(1),
  recordedAt: z.number().int().nonnegative(),
});

/** One device and its readings. */
export const DeviceSchema = z.object({
  deviceId: z.string().min(1),
  readings: z.array(ReadingSchema).max(MAX_READINGS_PER_DEVICE),
});

/**
 * The top-level envelope. The outer `telemetry` key is what makes a failing
 * path begin with `telemetry.devices[...]`, matching the issue's example.
 */
export const TelemetryBatchSchema = z.object({
  telemetry: z.object({
    batchId: z.string().min(1),
    devices: z.array(DeviceSchema).max(MAX_DEVICES_PER_BATCH),
  }),
});

export type Reading = z.infer<typeof ReadingSchema>;
export type Device = z.infer<typeof DeviceSchema>;
export type TelemetryBatch = z.infer<typeof TelemetryBatchSchema>;
