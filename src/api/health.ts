import type { FastifyInstance } from 'fastify';
import { circuitBreakerState, circuitBreakerQueueDepth } from './metrics/prometheus.js';
import { getLastAggregateRefreshTime } from '../database/pool_manager.js';

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
