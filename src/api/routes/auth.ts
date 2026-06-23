import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getEnv } from '../../config/env.js';
import {
  generateChallenge,
  verifyChallenge,
  issueSessionTokens,
  refreshSession,
  isValidStellarAddress,
} from '../auth/session.js';
import { verifyJwt } from '../middleware/auth.js';

interface ChallengeBody {
  walletAddress: string;
}

interface VerifyBody {
  walletAddress: string;
  signature: string;
  deviceId: string;
}

interface RefreshBody {
  refreshToken: string;
  deviceId: string;
}

const STELLAR_ADDRESS_PATTERN = '^G[A-Z2-7]{55}$';
const SIGNATURE_HEX_PATTERN = '^[0-9a-fA-F]{128}$';

export function registerAuthRoutes(app: FastifyInstance): void {
  /**
   * POST /api/auth/challenge
   * Issue a single-use 32-byte challenge nonce for a Stellar wallet.
   * Returns 409 if a challenge is already pending for that wallet.
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
   * Verify an Ed25519 signature over the challenge nonce and issue a JWT.
   */
  app.post<{ Body: VerifyBody }>(
    '/api/auth/verify',
    {
      schema: {
        body: {
          type: 'object',
          required: ['walletAddress', 'signature'],
          properties: {
            walletAddress: { type: 'string', pattern: STELLAR_ADDRESS_PATTERN },
            signature: { type: 'string', pattern: SIGNATURE_HEX_PATTERN },
            deviceId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: VerifyBody }>,
      reply: FastifyReply,
    ): Promise<FastifyReply> => {
      const { walletAddress, signature, deviceId } = request.body;

      if (!isValidStellarAddress(walletAddress)) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Invalid Stellar public key (checksum mismatch)',
        });
      }

      const valid = await verifyChallenge(walletAddress, signature);
      if (!valid) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Invalid signature or challenge',
        });
      }

      const env = getEnv();
      const tokens = await issueSessionTokens(walletAddress, deviceId);
      return reply.send({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        walletAddress,
        expiresIn: env.JWT_EXPIRES_IN,
      });
    },
  );

  /**
   * POST /api/auth/refresh
   * Rotate the session tokens using a valid refresh token.
   */
  app.post<{ Body: RefreshBody }>(
    '/api/auth/refresh',
    {
      schema: {
        body: {
          type: 'object',
          required: ['refreshToken', 'deviceId'],
          properties: {
            refreshToken: { type: 'string', minLength: 1 },
            deviceId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: RefreshBody }>,
      reply: FastifyReply,
    ): Promise<FastifyReply> => {
      const { refreshToken, deviceId } = request.body;

      const tokens = await refreshSession(refreshToken, deviceId);
      if (!tokens) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Invalid or expired refresh token',
        });
      }

      const env = getEnv();
      return reply.send({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: env.JWT_EXPIRES_IN,
      });
    },
  );

  /**
   * GET /api/auth/me
   * Return the session payload of the authenticated wallet.
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
}
