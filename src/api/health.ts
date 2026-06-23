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

interface MetricEntry {
  labels: Partial<Record<string, string | number>>;
  value: number;
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

    const maxLag = 1000;
    const lagMetric = await eventLoopLag.get();
    const currentLag = lagMetric.values[0]?.value || 0;
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
      return reply.send({ status: 'ok' });
    } catch (err) {
      healthCache = { status: 'error', timestamp: Date.now() };
      return reply.status(503).send({ status: 'error' });
    }
  });
}
