import type { FastifyReply, FastifyRequest } from 'fastify';
import { PoolContentionError, getTenantPoolProxy } from '../../database/pool_manager.js';
import { enterTenantContext, setCurrentTenantRequest } from '../../config/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenantId?: string;
  }
}

/**
 * Extracts and validates the x-tenant-id header for multi-tenant routing.
 */
export async function extractTenantId(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const raw = request.headers['x-tenant-id'];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    await reply.status(400).send({
      error: 'Bad Request',
      message: 'Missing or empty x-tenant-id header',
    });
    return;
  }

  request.tenantId = raw.trim();
  setCurrentTenantRequest(request);
  enterTenantContext(request.tenantId, request);
}

/**
 * Maps pool contention timeouts to HTTP 429 responses.
 */
export function isPoolContentionError(error: unknown): error is PoolContentionError {
  return error instanceof PoolContentionError;
}

export async function sendPoolContentionResponse(
  reply: FastifyReply,
  error: PoolContentionError,
): Promise<void> {
  await reply.status(429).send({
    error: 'Too Many Requests',
    message: 'Database connection pool contention timeout exceeded',
    tenantId: error.tenantId,
    waitMs: error.waitMs,
  });
}

export { getTenantPoolProxy };
