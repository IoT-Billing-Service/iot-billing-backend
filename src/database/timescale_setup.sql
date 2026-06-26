-- TimescaleDB Installation and Partition Configuration
-- Run: psql -d iot_billing -f timescale_setup.sql

CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- Main telemetry hypertable
CREATE TABLE IF NOT EXISTS telemetry (
    time TIMESTAMPTZ NOT NULL,
    device_id TEXT NOT NULL,
    metric_id INTEGER NOT NULL,
    metric_value DOUBLE PRECISION NOT NULL,
    raw_payload BYTEA,
    ingested_at TIMESTAMPTZ DEFAULT NOW(),
    region TEXT NOT NULL DEFAULT 'default'
);

SELECT create_hypertable(
    'telemetry',
    'time',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);

-- Partition by device geographical space via space partitioning on region
SELECT add_dimension(
    'telemetry',
    'region',
    number_partitions => 8,
    if_not_exists => TRUE
);

-- Compression policy: compress chunks older than 7 days
ALTER TABLE telemetry SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'device_id, region',
    timescaledb.compress_orderby = 'time DESC'
);

SELECT add_compression_policy('telemetry', INTERVAL '7 days', if_not_exists => TRUE);

-- Dynamic chunk interval calculation based on target size and ingestion rate
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

-- Try to enable pg_cron and schedule the job
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
        EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_cron';
    END IF;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'pg_cron extension could not be created: %', SQLERRM;
END;
$$;

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

-- Retention policy: drop data older than 365 days.
--
-- Invariant (issue #51): retention MUST exceed the largest continuous-aggregate
-- start_offset (currently 180 days, monthly_device_usage) with room to spare.
-- App-side adaptive refresh (refreshAggregatesAdaptively) additionally clamps
-- every refresh window to `now - (365 - RETENTION_SAFETY_MARGIN_DAYS)` days, so
-- a refresh can never race this retention job over a chunk it is dropping. Keep
-- TELEMETRY_RETENTION_DAYS in src/config/env.ts in sync with the value below.
SELECT add_retention_policy('telemetry', INTERVAL '365 days', if_not_exists => TRUE);

-- Billing records hypertable
CREATE TABLE IF NOT EXISTS billing_records (
    time TIMESTAMPTZ NOT NULL,
    device_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    usage_amount BIGINT NOT NULL,
    tx_hash TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
);

SELECT create_hypertable(
    'billing_records',
    'time',
    chunk_time_interval => INTERVAL '7 days',
    if_not_exists => TRUE
);

SELECT add_compression_policy('billing_records', INTERVAL '30 days', if_not_exists => TRUE);

-- Indexes for query performance
CREATE INDEX IF NOT EXISTS idx_telemetry_device_time ON telemetry (device_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_billing_account ON billing_records (account_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_billing_status ON billing_records (status) WHERE status = 'pending';
