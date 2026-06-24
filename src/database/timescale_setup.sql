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
    ingested_at TIMESTAMPTZ DEFAULT NOW()
);

SELECT create_hypertable(
    'telemetry',
    'time',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);

-- Partition by device geographical space via space partitioning
SELECT add_dimension(
    'telemetry',
    'device_id',
    number_partitions => 16,
    if_not_exists => TRUE
);

-- Compression policy: compress chunks older than 7 days
ALTER TABLE telemetry SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'device_id',
    timescaledb.compress_orderby = 'time DESC'
);

SELECT add_compression_policy('telemetry', INTERVAL '7 days', if_not_exists => TRUE);

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
