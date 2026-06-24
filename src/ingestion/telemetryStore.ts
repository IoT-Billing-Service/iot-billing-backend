import pg from 'pg';

export interface RawEvent {
  device_id: string;
  metric_id: number;
  metric_value: number;
  time: Date;
}

export interface TelemetrySummary {
  batch_id: string;
  device_id: string;
  metric_id: number;
  batch_start: Date;
  batch_end: Date;
  min_value: number;
  max_value: number;
  avg_value: number;
  sum_value: number;
  event_count: number;
}

/**
 * Insert a raw telemetry event.
 */
export async function insertRawEvent(client: pg.PoolClient, event: RawEvent): Promise<void> {
  await client.query(
    `INSERT INTO telemetry (time, device_id, metric_id, metric_value)
     VALUES ($1, $2, $3, $4)`,
    [event.time, event.device_id, event.metric_id, event.metric_value],
  );
}

/**
 * Read raw events strictly within [batchStart, batchEnd).
 * Boundary-anchored: uses the batch's immutable start/end timestamps so results
 * are stable regardless of when this is called relative to rotation.
 */
export async function readRawEvents(
  client: pg.PoolClient,
  deviceId: string,
  batchStart: Date,
  batchEnd: Date,
): Promise<RawEvent[]> {
  const result = await client.query<RawEvent>(
    `SELECT device_id, metric_id, metric_value, time
     FROM telemetry
     WHERE device_id = $1
       AND time >= $2
       AND time < $3
     ORDER BY time ASC`,
    [deviceId, batchStart, batchEnd],
  );
  return result.rows;
}

/**
 * Write the compacted summary for a batch.
 */
export async function writeSummary(
  client: pg.PoolClient,
  summary: TelemetrySummary,
): Promise<void> {
  await client.query(
    `INSERT INTO telemetry_batch_summaries
       (batch_id, device_id, metric_id, batch_start, batch_end,
        min_value, max_value, avg_value, sum_value, event_count, compacted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())
     ON CONFLICT (batch_id, device_id, metric_id) DO NOTHING`,
    [
      summary.batch_id,
      summary.device_id,
      summary.metric_id,
      summary.batch_start,
      summary.batch_end,
      summary.min_value,
      summary.max_value,
      summary.avg_value,
      summary.sum_value,
      summary.event_count,
    ],
  );
}
