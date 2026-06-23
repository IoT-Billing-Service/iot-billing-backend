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
