import { applyAuthRateLimiting } from '../middleware/rate_limiter.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getEnv } from '../../config/env.js';
import {
  generateChallenge,
  verifyChallenge,
  issueSessionTokens,
  isValidStellarAddress,
  refreshSession,
} from '../auth/session.js';
import { verifyJwt } from '../middleware/auth.js';

interface ChallengeBody {
  walletAddress: string;
}

interface VerifyBody {
  walletAddress: string;
  signature: string;
  deviceId?: string;
}

const STELLAR_ADDRESS_PATTERN = '^G[A-Z2-7]{55}$';
const SIGNATURE_HEX_PATTERN = '^[0-9a-fA-F]{128}$';

export function registerAuthRoutes(app: FastifyInstance): void {
  /**
   * POST /api/auth/challenge
   */
  app.post<{ Body: ChallengeBody }>(
    '/api/auth/challenge',
    {
      schema: {
        body: {
          type: 'object',
          required: ['walletAddress'],
          properties: {
            walletAddress: { type: 'string', pattern: STELLAR_ADDRESS_PATTERN },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: ChallengeBody }>,
      reply: FastifyReply,
    ): Promise<FastifyReply> => {
      const { walletAddress } = request.body;

      if (!isValidStellarAddress(walletAddress)) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Invalid Stellar public key (checksum mismatch)',
        });
      }

      const challenge = await generateChallenge(walletAddress);
      if (challenge === null) {
        return reply.status(409).send({
          error: 'Conflict',
          message: 'A challenge is already pending for this wallet',
        });
      }

      return reply.send({
        walletAddress,
        nonce: challenge.nonce,
        expiresAt: challenge.expiresAt,
      });
    },
  );

  /**
   * POST /api/auth/verify
   * Secure constant-time dual-token challenge verification
   */
  app.post<{ Body: VerifyBody }>(
    '/api/auth/verify',
    {
      preHandler: applyAuthRateLimiting,
      schema: {
        body: {
          type: 'object',
          required: ['walletAddress', 'signature'],
          properties: {
            walletAddress: { type: 'string', pattern: STELLAR_ADDRESS_PATTERN },
            signature: { type: 'string', pattern: SIGNATURE_HEX_PATTERN },
            deviceId: { type: 'string' },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: VerifyBody }>,
      reply: FastifyReply,
    ): Promise<FastifyReply> => {
      const { walletAddress, signature } = request.body;

      if (!isValidStellarAddress(walletAddress)) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Invalid Stellar public key (checksum mismatch)',
        });
      }

      const startExecution = performance.now();
      const valid = await verifyChallenge(walletAddress, signature);

      const env = getEnv();
      const deviceId: string =
        typeof request.body.deviceId === 'string' ? request.body.deviceId : '';

      const realTokens = await issueSessionTokens(walletAddress, deviceId);
      const dummyTokens = await issueSessionTokens(
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        deviceId,
      );

      const tokens = valid ? realTokens : dummyTokens;

      const executionElapsed = performance.now() - startExecution;
      const TARGET_PADDING_MS = 3.0;
      if (executionElapsed < TARGET_PADDING_MS) {
        const delayPadding = TARGET_PADDING_MS - executionElapsed;
        await new Promise((resolve) => setTimeout(resolve, delayPadding));
      }

      if (!valid) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Invalid signature or challenge',
        });
      }

      return reply.send({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        walletAddress,
        expiresIn: env.JWT_EXPIRES_IN,
      });
    },
  );

  /**
   * GET /api/auth/me
   */
  app.get(
    '/api/auth/me',
    { preHandler: verifyJwt },
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      if (request.session === undefined) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'No session attached',
        });
      }
      return reply.send({
        wallet: request.session.wallet,
        sub: request.session.sub,
        iat: request.session.iat,
        exp: request.session.exp,
      });
    },
  );

  /**
   * POST /api/auth/refresh
   */
  app.post<{ Body: { refreshToken: string; deviceId: string } }>(
    '/api/auth/refresh',
    { preHandler: applyAuthRateLimiting },
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      const body = request.body as { refreshToken?: unknown; deviceId?: unknown };
      const refreshToken = typeof body.refreshToken === 'string' ? body.refreshToken : null;
      const deviceId = typeof body.deviceId === 'string' ? body.deviceId : null;
      if (refreshToken === null || deviceId === null) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'refreshToken and deviceId are required',
        });
      }
      const tokens = await refreshSession(refreshToken, deviceId);
      if (!tokens) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Invalid or expired refresh token',
        });
      }
      return reply.send({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });
    },
  );
}
