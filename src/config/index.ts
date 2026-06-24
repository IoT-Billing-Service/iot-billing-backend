import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyRequest } from 'fastify';

export { loadEnv, getEnv } from './env.js';
export type { Env } from './env.js';

export interface TenantContextStore {
  tenantId: string;
  request?: FastifyRequest;
}

export const asyncLocalStorage = new AsyncLocalStorage<TenantContextStore>();

let currentRequest: FastifyRequest | undefined;

export function setCurrentTenantRequest(request: FastifyRequest | undefined): void {
  currentRequest = request;
}

export function clearCurrentTenantRequest(request?: FastifyRequest): void {
  if (request === undefined || currentRequest === request) {
    currentRequest = undefined;
  }
}

function tenantIdFromRequest(request: FastifyRequest | undefined): string | undefined {
  const requestTenantId = request?.tenantId;
  if (requestTenantId !== undefined) {
    return requestTenantId;
  }

  const rawHeader = request?.headers['x-tenant-id'];
  if (typeof rawHeader === 'string' && rawHeader.trim().length > 0) {
    return rawHeader.trim();
  }

  return undefined;
}

export function tenantContext(): string | undefined {
  return asyncLocalStorage.getStore()?.tenantId ?? tenantIdFromRequest(currentRequest);
}

export function assertTenantContextAvailable(): void {
  if (process.env['NODE_ENV'] === 'development') {
    assert.notEqual(tenantContext(), undefined, 'ALS context lost');
  }
}

export function runWithTenantContext<T>(
  tenantId: string,
  fn: () => T,
  request?: FastifyRequest,
): T {
  return asyncLocalStorage.run({ tenantId, request }, fn);
}

export function enterTenantContext(tenantId: string, request?: FastifyRequest): void {
  asyncLocalStorage.enterWith({ tenantId, request });
}

// --- Versioned configuration registry, two-phase commit, and Redis watcher ---
import crypto from 'node:crypto';
import type { Redis } from 'ioredis';

let lastTimestamp = 0;
let sequence = 0;

export function generateMonotonicUUID(): string {
  const now = Date.now();
  if (now === lastTimestamp) {
    sequence++;
  } else {
    lastTimestamp = now;
    sequence = 0;
  }

  const timeHex = now.toString(16).padStart(12, '0');
  const seqHex = (sequence & 0xfff).toString(16).padStart(3, '0');
  const randHex = crypto.randomBytes(8).toString('hex');

  const part1 = timeHex.slice(0, 8);
  const part2 = timeHex.slice(8, 12);
  const part3 = '7' + seqHex;
  const part4 = '8' + randHex.slice(0, 3);
  const part5 = randHex.slice(3, 15);
  return `${part1}-${part2}-${part3}-${part4}-${part5}`;
}

export interface BillingTier {
  min: number;
  max: number;
}

export interface MetricRangesConfig {
  version_id: string;
  tiers: Record<string, BillingTier>;
}

const configRegistry = new Map<string, MetricRangesConfig>();
let currentConfigVersionId = '';

const fallbackVersionId = '00000000-0000-7000-8000-000000000000';
const fallbackConfig: MetricRangesConfig = {
  version_id: fallbackVersionId,
  tiers: {
    TIER_1: { min: 0, max: 1000 },
    TIER_2: { min: 1001, max: 10000 },
    TIER_3: { min: 10001, max: Infinity },
  },
};
configRegistry.set(fallbackVersionId, fallbackConfig);
currentConfigVersionId = fallbackVersionId;

interface SerializedBillingTier {
  min: number;
  max: number | null;
}

interface SerializedConfig {
  version_id: string;
  tiers: Record<string, SerializedBillingTier>;
}

export function getConfig(versionId?: string): MetricRangesConfig {
  if (versionId !== undefined) {
    const cached = configRegistry.get(versionId);
    if (cached !== undefined) {
      return cached;
    }
  }
  const current = configRegistry.get(currentConfigVersionId);
  return current ?? fallbackConfig;
}

export function setConfig(config: MetricRangesConfig): void {
  configRegistry.set(config.version_id, config);
  currentConfigVersionId = config.version_id;
}

export async function commitConfig(
  redis: Redis,
  tiers: Record<string, BillingTier>,
  commitDelayMs = 1000,
): Promise<string> {
  const version_id = generateMonotonicUUID();
  const configJson = JSON.stringify({ version_id, tiers });

  // Phase 1: SET config:staging
  await redis.set('config:staging', configJson);

  // Wait COMMIT_DELAY_MS
  if (commitDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, commitDelayMs));
  }

  // Phase 2: RENAME config:staging config:active
  await redis.rename('config:staging', 'config:active');

  return version_id;
}

let activeWatcherInterval: ReturnType<typeof setInterval> | null = null;

export async function initializeConfigWatcher(redis: Redis, intervalMs = 50): Promise<void> {
  // Check if active key exists
  const activeExists = await redis.exists('config:active');
  if (activeExists === 0) {
    // Write the fallback/default config to Redis
    const defaultTiers = {
      TIER_1: { min: 0, max: 1000 },
      TIER_2: { min: 1001, max: 10000 },
      TIER_3: { min: 10001, max: Infinity },
    };
    const version_id = generateMonotonicUUID();
    const config: MetricRangesConfig = { version_id, tiers: defaultTiers };
    await redis.set('config:active', JSON.stringify(config));
    setConfig(config);
  } else {
    const activeVal = await redis.get('config:active');
    if (activeVal !== null) {
      const parsed = JSON.parse(activeVal) as SerializedConfig;
      const config: MetricRangesConfig = {
        version_id: parsed.version_id,
        tiers: {},
      };
      for (const [key, tier] of Object.entries(parsed.tiers)) {
        config.tiers[key] = {
          min: tier.min,
          max: tier.max ?? Infinity,
        };
      }
      setConfig(config);
    }
  }

  // Clear any existing watcher first
  if (activeWatcherInterval !== null) {
    clearInterval(activeWatcherInterval);
  }

  // Start polling Redis every intervalMs
  activeWatcherInterval = setInterval((): void => {
    void (async (): Promise<void> => {
      try {
        const activeVal = await redis.get('config:active');
        if (activeVal !== null) {
          const parsed = JSON.parse(activeVal) as SerializedConfig;
          const config: MetricRangesConfig = {
            version_id: parsed.version_id,
            tiers: {},
          };
          for (const [key, tier] of Object.entries(parsed.tiers)) {
            config.tiers[key] = {
              min: tier.min,
              max: tier.max ?? Infinity,
            };
          }
          if (config.version_id !== currentConfigVersionId) {
            setConfig(config);
          }
        }
      } catch (err) {
        console.error('Error polling Redis config:', err);
      }
    })();
  }, intervalMs);

  activeWatcherInterval.unref();
}

export function stopConfigWatcher(): void {
  if (activeWatcherInterval !== null) {
    clearInterval(activeWatcherInterval);
    activeWatcherInterval = null;
  }
}
