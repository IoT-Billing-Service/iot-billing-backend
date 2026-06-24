import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  circuitBreakerState,
  circuitBreakerQueueDepth,
  eventLoopLag,
} from './metrics/prometheus.js';
import pg from 'pg';
import { Redis } from 'ioredis';
import { getEnv } from '../config/env.js';
import { reportHealthCheckCompleted } from './metrics/gc_monitor.js';
import { isMigrationInProgress, getLastAggregateRefreshTime } from '../database/pool_manager.js';

interface MetricEntry {
  labels: Partial<Record<string, string | number>>;
  value: number;
}

/** Default staleness threshold: alert if the aggregate refresh is > 2h old. */
export const DEFAULT_AGGREGATE_MAX_STALENESS_MS = 2 * 60 * 60 * 1000;

export interface AggregateFreshness {
  fresh: boolean;
  lastRefresh: string;
  ageMs: number;
  maxStalenessMs: number;
}

/**
 * Pure freshness check (issue #51): how stale is the last continuous-aggregate
 * refresh? If the adaptive refresh loop stalls (e.g. a clamp misconfiguration
 * or a DB outage), analytics data drifts stale unboundedly — this surfaces it.
 */
export function checkAggregateFreshness(
  lastRefresh: Date,
  now: Date,
  maxStalenessMs: number = DEFAULT_AGGREGATE_MAX_STALENESS_MS,
): AggregateFreshness {
  const ageMs = now.getTime() - lastRefresh.getTime();
  return {
    fresh: ageMs <= maxStalenessMs,
    lastRefresh: lastRefresh.toISOString(),
    ageMs,
    maxStalenessMs,
  };
}

/**
 * Register `GET /aggregate-health`. Returns the freshness payload and responds
 * 503 when the last refresh is older than `maxStalenessMs` so an orchestrator
 * or alerting probe can act on a stalled refresh loop.
 */
export function registerAggregateHealth(
  app: FastifyInstance,
  options: { maxStalenessMs?: number } = {},
): void {
  const maxStalenessMs = options.maxStalenessMs ?? DEFAULT_AGGREGATE_MAX_STALENESS_MS;
  app.get('/aggregate-health', async (_request, reply) => {
    const freshness = checkAggregateFreshness(
      getLastAggregateRefreshTime(),
      new Date(),
      maxStalenessMs,
    );
    if (!freshness.fresh) {
      void reply.status(503);
    }
    return freshness;
  });
}

export function registerCircuitHealth(app: FastifyInstance): void {
  app.get('/circuit-health', async () => {
    const stateMetric = (await circuitBreakerState.get()).values.find(
      (v: MetricEntry) => v.labels['client'] === 'soroban',
    );
    const queueMetric = (await circuitBreakerQueueDepth.get()).values.find(
      (v: MetricEntry) => v.labels['client'] === 'soroban',
    );
    return {
      state: stateMetric ? stateMetric.value : 0,
      queueDepth: queueMetric ? queueMetric.value : 0,
    };
  });
}

let healthDbPool: pg.Pool | null = null;
let healthRedisClient: Redis | null = null;
let healthCache: { status: 'ok' | 'error'; timestamp: number } | null = null;

export function registerReadinessHealthCheck(app: FastifyInstance): void {
  app.get('/health', async (req: FastifyRequest, reply: FastifyReply) => {
    reportHealthCheckCompleted();

    if (isMigrationInProgress()) {
      void reply.header('Retry-After', '10');
      return reply.status(503).send({ status: 'error', reason: 'migration_in_progress' });
    }

    const maxLag = 1000;
    const lagMetric = await eventLoopLag.get();
    const currentLag = lagMetric.values[0]?.value ?? 0;
    if (currentLag > maxLag) {
      void reply.header('X-Health-Degraded', 'gc-pause');
      return reply.status(503).send({ status: 'error', reason: 'event_loop_lag_exceeded' });
    }

    if (healthCache && Date.now() - healthCache.timestamp < 2000) {
      if (healthCache.status === 'ok') {
        return reply.send({ status: 'ok', cached: true });
      } else {
        return reply.status(503).send({ status: 'error', cached: true });
      }
    }

    if (!healthDbPool) {
      const env = getEnv();
      healthDbPool = new pg.Pool({
        connectionString: env.TIMESCALEDB_URL,
        max: 1,
        options: '-c statement_timeout=500',
      });
    }

    if (!healthRedisClient) {
      const env = getEnv();
      healthRedisClient = new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: 1,
        commandTimeout: 500,
        enableReadyCheck: true,
        lazyConnect: false,
      });
    }

    try {
      await healthDbPool.query('SELECT 1');
      await healthRedisClient.ping();
      healthCache = { status: 'ok', timestamp: Date.now() };
      return await reply.send({ status: 'ok' });
    } catch {
      healthCache = { status: 'error', timestamp: Date.now() };
      return await reply.status(503).send({ status: 'error' });
    }
  });
}
