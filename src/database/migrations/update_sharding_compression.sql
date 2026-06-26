-- Migration DDL: TimescaleDB Dynamic Partition Sharding and Compression Policies
-- Applies updates to an existing database setup safely.

-- 1. Add region column if not exists
ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT 'default';

-- 2. Add region-based space dimension if not exists
SELECT add_dimension(
    'telemetry',
    'region',
    number_partitions => 8,
    if_not_exists => TRUE
);

-- 3. Update compression parameters to include region segmentby
ALTER TABLE telemetry SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'device_id, region',
    timescaledb.compress_orderby = 'time DESC'
);

-- 4. Dynamic chunk interval calculation based on target size and ingestion rate
CREATE OR REPLACE FUNCTION calculate_chunk_interval()
RETURNS INTERVAL AS $$
DECLARE
    target_size_gb DOUBLE PRECISION := 5.0; -- Default target size is 5 GB
    target_size_bytes BIGINT;
    default_interval INTERVAL := INTERVAL '1 day';
    recent_chunk_record RECORD;
    calculated_secs DOUBLE PRECISION;
    recent_span_secs DOUBLE PRECISION;
    calculated_interval INTERVAL;
BEGIN
    -- Try to fetch target chunk size from GUC settings, falling back to 5.0 GB if not set
    BEGIN
        target_size_gb := current_setting('app.telemetry_target_chunk_size_gb')::double precision;
    EXCEPTION WHEN OTHERS THEN
        target_size_gb := 5.0;
    END;

    target_size_bytes := (target_size_gb * 1024 * 1024 * 1024)::bigint;

    -- Query the latest uncompressed, closed chunk for the telemetry hypertable
    SELECT 
        c.chunk_name,
        c.chunk_schema,
        (c.range_end - c.range_start) AS chunk_time_span,
        pg_total_relation_size(quote_ident(c.chunk_schema) || '.' || quote_ident(c.chunk_name)) AS total_bytes
    INTO recent_chunk_record
    FROM timescaledb_information.chunks c
    WHERE c.hypertable_name = 'telemetry'
      AND c.is_compressed = false
      AND c.range_end <= now()
    ORDER BY c.range_end DESC
    LIMIT 1;

    -- If no chunks exist or size is 0, return default 1-day interval
    IF NOT FOUND OR recent_chunk_record.total_bytes = 0 OR recent_chunk_record.chunk_time_span IS NULL OR recent_chunk_record.chunk_time_span = INTERVAL '0' THEN
        RETURN default_interval;
    END IF;

    recent_span_secs := EXTRACT(EPOCH FROM recent_chunk_record.chunk_time_span);
    IF recent_span_secs <= 0 THEN
        RETURN default_interval;
    END IF;

    -- Compute dynamic interval: (target_size / recent_size) * recent_span
    calculated_secs := (target_size_bytes::double precision / recent_chunk_record.total_bytes::double precision) * recent_span_secs;

    -- Bound the interval strictly between 1 hour and 7 days
    IF calculated_secs < 3600 THEN
        calculated_secs := 3600; -- 1 hour minimum
    ELSIF calculated_secs > 604800 THEN
        calculated_secs := 604800; -- 7 days maximum
    END IF;

    calculated_interval := (calculated_secs || ' seconds')::INTERVAL;
    RETURN calculated_interval;
END;
$$ LANGUAGE plpgsql;

-- 5. Try to enable pg_cron and schedule the job
CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        -- Unschedule existing job if any
        PERFORM cron.unschedule('adjust_telemetry_chunk_interval')
        FROM cron.job
        WHERE jobname = 'adjust_telemetry_chunk_interval';

        -- Schedule new job
        PERFORM cron.schedule(
            'adjust_telemetry_chunk_interval',
            '0 * * * *', -- Run every hour
            'SELECT set_chunk_time_interval(''telemetry'', calculate_chunk_interval())'
        );
    END IF;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Failed to schedule pg_cron job: %', SQLERRM;
END;
$$;
