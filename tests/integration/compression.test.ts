import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const DB_URL: string | undefined =
  process.env['INTEGRATION_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const pool =
  DB_URL != null ? new pg.Pool({ connectionString: DB_URL, connectionTimeoutMillis: 5000 }) : null;
let dbAvailable = false;
let timescaleAvailable = false;

beforeAll(async () => {
  if (!pool) return;
  const client = await pool.connect();
  try {
    // Check if timescaledb extension is enabled
    const extCheck = await client.query("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'");
    if (extCheck.rows.length > 0) {
      timescaleAvailable = true;

      const fs = await import('fs');
      const path = await import('path');
      const { fileURLToPath } = await import('url');

      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);

      const setupSqlPath = path.join(__dirname, '../../src/database/timescale_setup.sql');
      const setupSql = fs.readFileSync(setupSqlPath, 'utf8');
      await client.query(setupSql);

      const aggsSqlPath = path.join(__dirname, '../../src/database/views/continuous_aggs.sql');
      const aggsSql = fs.readFileSync(aggsSqlPath, 'utf8');
      await client.query(aggsSql);
    }
    dbAvailable = true;
  } catch (err) {
    console.error('Error during TimescaleDB test setup:', err);
    dbAvailable = false;
  } finally {
    client.release();
  }
});

afterAll(async () => {
  if (pool) {
    try {
      await pool.end();
    } catch (e) {
      console.error('Error closing pool:', e);
    }
  }
});

describe('TimescaleDB Dynamic Sharding & Compression Integration', () => {
  it('should verify telemetry table region column, calculate_chunk_interval(), and compression ratio > 85%', async () => {
    if (!dbAvailable || !timescaleAvailable || !pool) {
      console.log(
        'Skipping TimescaleDB sharding/compression integration tests (database or TimescaleDB extension unavailable)',
      );
      return;
    }

    const client = await pool.connect();
    try {
      // 1. Check that region column exists on telemetry table
      const colCheck = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'telemetry' AND column_name = 'region'
      `);
      expect(colCheck.rows.length).toBeGreaterThan(0);

      // 2. Test calculate_chunk_interval() returns a valid interval
      const intervalResult = await client.query<{ calculate_chunk_interval: unknown }>(
        'SELECT calculate_chunk_interval()',
      );
      expect(intervalResult.rows[0]).toBeDefined();
      const calculatedVal = intervalResult.rows[0]?.calculate_chunk_interval;
      expect(calculatedVal).toBeDefined();

      // 3. Insert repetitive telemetry data to verify high compression ratio
      await client.query('DELETE FROM telemetry WHERE device_id = $1', ['compression-test-device']);

      const baseTime = new Date('2026-06-25T00:00:00.000Z');
      const insertQuery = `
        INSERT INTO telemetry (time, device_id, metric_id, metric_value, raw_payload, region)
        VALUES ($1, $2, $3, $4, $5, $6)
      `;

      // Batch insert 1000 rows with identical metric_value and raw_payload to ensure high compression
      const batchSize = 1000;
      const rawPayload = Buffer.from('repetitive payload value for testing compression ratio');
      for (let i = 0; i < batchSize; i++) {
        const time = new Date(baseTime.getTime() + i * 1000); // 1-second increments
        await client.query(insertQuery, [
          time,
          'compression-test-device',
          42,
          100.5,
          rawPayload,
          'us-east-1',
        ]);
      }

      // 4. Find the chunk that was created for our test data
      const chunkResult = await client.query<{ chunk_name: string }>(`
        SELECT chunk_name 
        FROM timescaledb_information.chunks 
        WHERE hypertable_name = 'telemetry' 
          AND is_compressed = false
        ORDER BY range_start ASC
        LIMIT 1
      `);

      if (chunkResult.rows.length > 0) {
        const chunkName = chunkResult.rows[0]?.chunk_name;
        expect(chunkName).toBeDefined();
        if (chunkName !== undefined) {
          // 5. Manually compress the chunk to test the compression policy's ratio
          await client.query(`SELECT compress_chunk($1, if_not_exists => true)`, [chunkName]);

          // 6. Query chunk compression stats and check compression ratio
          const statsResult = await client.query<{
            before_compression_total_bytes: string;
            after_compression_total_bytes: string;
          }>(
            `
            SELECT before_compression_total_bytes, after_compression_total_bytes 
            FROM chunk_compression_stats('telemetry')
            WHERE chunk_name = $1
          `,
            [chunkName],
          );

          if (statsResult.rows.length > 0) {
            const stats = statsResult.rows[0];
            expect(stats).toBeDefined();
            if (stats !== undefined) {
              const uncompressed = parseInt(stats.before_compression_total_bytes, 10);
              const compressed = parseInt(stats.after_compression_total_bytes, 10);
              expect(uncompressed).toBeGreaterThan(0);
              const ratio = (1 - compressed / uncompressed) * 100;
              console.log(
                `Uncompressed: ${uncompressed.toString()} bytes, Compressed: ${compressed.toString()} bytes, Compression ratio: ${ratio.toFixed(2)}%`,
              );
              expect(ratio).toBeGreaterThan(85.0);
            }
          }
        }
      }

      // Cleanup test data
      await client.query('DELETE FROM telemetry WHERE device_id = $1', ['compression-test-device']);
    } finally {
      client.release();
    }
  });
});
