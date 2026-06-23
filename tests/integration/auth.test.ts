import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Redis } from 'ioredis';
import { Keypair } from '@stellar/stellar-sdk';
import type { FastifyInstance } from 'fastify';
import { clearEnvCache } from '../../src/config/env.js';
import { buildApp } from '../../src/api/index.js';
import { closeRedis } from '../../src/database/redis.js';

const REQUIRED_ENV: Record<string, string> = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/iot_billing',
  TIMESCALEDB_URL: 'postgresql://postgres:postgres@localhost:5432/iot_billing',
  SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
  SOROBAN_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  JWT_SECRET: 'integration-test-secret-that-is-at-least-32-characters-long',
  REDIS_URL: 'redis://localhost:6379',
};

interface ChallengeBody {
  nonce: string;
  expiresAt: number;
  walletAddress: string;
}

interface VerifyBody {
  accessToken: string;
  refreshToken: string;
  walletAddress: string;
  expiresIn: string;
}

interface MeBody {
  wallet: string;
  sub: string;
  iat: number;
  exp: number;
}

let app: FastifyInstance | null = null;
let redisAvailable = false;
let redisUrl = '';

beforeAll(async () => {
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    process.env[key] ??= value;
  }
  clearEnvCache();
  redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

  const probe = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 1000,
  });
  try {
    await probe.connect();
    await probe.ping();
    redisAvailable = true;
  } catch {
    redisAvailable = false;
  } finally {
    probe.disconnect();
  }

  if (redisAvailable) {
    app = await buildApp();
    await app.ready();
  }
});

afterAll(async () => {
  try {
    if (app !== null) await app.close();
  } catch (e) {
    console.error(e);
  }
  try {
    await closeRedis();
  } catch (e) {
    console.error(e);
  }
});

async function flushAuthKeys(): Promise<void> {
  if (!redisAvailable) return;
  const client = new Redis(redisUrl, { lazyConnect: true });
  try {
    await client.connect();
    const keys = await client.keys('auth:challenge:*');
    if (keys.length > 0) {
      await client.del(...keys);
    }
  } finally {
    client.disconnect();
  }
}

describe('POST /api/auth/challenge', () => {
  it('should issue a 64-char hex nonce for a valid Stellar address', async () => {
    if (!redisAvailable || app === null) return;
    await flushAuthKeys();
    const kp = Keypair.random();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      payload: { walletAddress: kp.publicKey() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ChallengeBody>();
    expect(body.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(body.walletAddress).toBe(kp.publicKey());
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it('should return 400 for an address with a bad checksum', async () => {
    if (!redisAvailable || app === null) return;
    const kp = Keypair.random();
    const tampered = kp.publicKey().startsWith('G')
      ? 'H' + kp.publicKey().slice(1)
      : 'G' + kp.publicKey().slice(1);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      payload: { walletAddress: tampered },
    });
    expect(res.statusCode).toBe(400);
  });

  it('should return 400 for a non-Stellar string', async () => {
    if (!redisAvailable || app === null) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      payload: { walletAddress: 'not-a-stellar-address' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('should return 409 when a challenge is already pending for the wallet', async () => {
    if (!redisAvailable || app === null) return;
    await flushAuthKeys();
    const kp = Keypair.random();
    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      payload: { walletAddress: kp.publicKey() },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      payload: { walletAddress: kp.publicKey() },
    });
    expect(second.statusCode).toBe(409);
  });
});

describe('POST /api/auth/verify', () => {
  it('should issue a JWT for a valid signature over the challenge', async () => {
    if (!redisAvailable || app === null) return;
    await flushAuthKeys();
    const kp = Keypair.random();
    const challengeRes = await app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      payload: { walletAddress: kp.publicKey() },
    });
    const { nonce } = challengeRes.json<ChallengeBody>();
    const sig = kp.sign(Buffer.from(nonce, 'hex'));
    const verifyRes = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      payload: {
        walletAddress: kp.publicKey(),
        signature: sig.toString('hex'),
        deviceId: 'test-device-1',
      },
    });
    expect(verifyRes.statusCode).toBe(200);
    const body = verifyRes.json<VerifyBody>();
    expect(body.accessToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(body.refreshToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(body.walletAddress).toBe(kp.publicKey());
    expect(typeof body.expiresIn).toBe('string');
  });

  it('should return 401 for a signature from a different keypair', async () => {
    if (!redisAvailable || app === null) return;
    await flushAuthKeys();
    const real = Keypair.random();
    const attacker = Keypair.random();
    const challengeRes = await app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      payload: { walletAddress: real.publicKey() },
    });
    const { nonce } = challengeRes.json<ChallengeBody>();
    const sig = attacker.sign(Buffer.from(nonce, 'hex'));
    const verifyRes = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      payload: {
        walletAddress: real.publicKey(),
        signature: sig.toString('hex'),
        deviceId: 'test-device-1',
      },
    });
    expect(verifyRes.statusCode).toBe(401);
  });

  it('should return 401 when no challenge is pending (never issued)', async () => {
    if (!redisAvailable || app === null) return;
    await flushAuthKeys();
    const kp = Keypair.random();
    const sig = kp.sign(Buffer.alloc(32));
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      payload: {
        walletAddress: kp.publicKey(),
        signature: sig.toString('hex'),
        deviceId: 'test-device-1',
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('should make the nonce single-use (replay returns 401)', async () => {
    if (!redisAvailable || app === null) return;
    await flushAuthKeys();
    const kp = Keypair.random();
    const challengeRes = await app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      payload: { walletAddress: kp.publicKey() },
    });
    const { nonce } = challengeRes.json<ChallengeBody>();
    const sig = kp.sign(Buffer.from(nonce, 'hex'));
    const payload = {
      walletAddress: kp.publicKey(),
      signature: sig.toString('hex'),
      deviceId: 'test-device-1',
    };

    const first = await app.inject({ method: 'POST', url: '/api/auth/verify', payload });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: 'POST', url: '/api/auth/verify', payload });
    expect(second.statusCode).toBe(401);
  });

  it('should return 400 for a non-hex signature', async () => {
    if (!redisAvailable || app === null) return;
    const kp = Keypair.random();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      payload: { walletAddress: kp.publicKey(), signature: 'not-hex', deviceId: 'test-device-1' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/auth/me', () => {
  it('should return 401 without a Bearer token', async () => {
    if (!redisAvailable || app === null) return;
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('should return 401 for a malformed Authorization header', async () => {
    if (!redisAvailable || app === null) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: 'Basic xyz' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('should return 401 for an invalid token', async () => {
    if (!redisAvailable || app === null) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: 'Bearer not.a.real.jwt' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('should return the session payload for a valid token from the full challenge flow', async () => {
    if (!redisAvailable || app === null) return;
    await flushAuthKeys();
    const kp = Keypair.random();
    const challengeRes = await app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      payload: { walletAddress: kp.publicKey() },
    });
    const { nonce } = challengeRes.json<ChallengeBody>();
    const sig = kp.sign(Buffer.from(nonce, 'hex'));
    const verifyRes = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      payload: {
        walletAddress: kp.publicKey(),
        signature: sig.toString('hex'),
        deviceId: 'test-device-1',
      },
    });
    const { accessToken } = verifyRes.json<VerifyBody>();

    const meRes = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(meRes.statusCode).toBe(200);
    const body = meRes.json<MeBody>();
    expect(body.wallet).toBe(kp.publicKey());
    expect(body.sub).toBe(kp.publicKey());
    expect(typeof body.iat).toBe('number');
    expect(typeof body.exp).toBe('number');
    expect(body.exp).toBeGreaterThan(body.iat);
  });
});

describe('POST /api/auth/refresh', () => {
  it('should refresh tokens and handle 5 concurrent refresh requests for the same session', async () => {
    if (!redisAvailable || app === null) return;
    const testApp = app;
    await flushAuthKeys();

    // 1. Initial Auth
    const kp = Keypair.random();
    const challengeRes = await testApp.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      payload: { walletAddress: kp.publicKey() },
    });
    const { nonce } = challengeRes.json<ChallengeBody>();
    const sig = kp.sign(Buffer.from(nonce, 'hex'));

    const verifyRes = await testApp.inject({
      method: 'POST',
      url: '/api/auth/verify',
      payload: {
        walletAddress: kp.publicKey(),
        signature: sig.toString('hex'),
        deviceId: 'test-device-concurrent',
      },
    });

    expect(verifyRes.statusCode).toBe(200);
    const { refreshToken } = verifyRes.json<VerifyBody>();

    // 2. Fire 5 concurrent refresh requests
    const refreshPayload = {
      refreshToken,
      deviceId: 'test-device-concurrent',
    };

    const refreshPromises = Array.from({ length: 5 }).map(() =>
      testApp.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        payload: refreshPayload,
      }),
    );

    const responses = await Promise.all(refreshPromises);

    // All should succeed (1 actual rotation, 4 cached responses)
    for (const res of responses) {
      expect(res.statusCode).toBe(200);
    }

    const jsonResponses = responses.map((res) =>
      res.json<{ accessToken: string; refreshToken: string }>(),
    );

    // They should all return the exact same new token pair because of the 5s cooldown
    const firstRefresh = jsonResponses[0];
    if (!firstRefresh) {
      throw new Error('No refresh response received');
    }

    for (const jr of jsonResponses) {
      expect(jr.accessToken).toBe(firstRefresh.accessToken);
      expect(jr.refreshToken).toBe(firstRefresh.refreshToken);
    }

    // Ensure the new access token works
    const meRes = await testApp.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${firstRefresh.accessToken}` },
    });
    expect(meRes.statusCode).toBe(200);

    // 3. Late refresh: Using the original refresh token outside of cooldown window.
    // The version is 1, stored version is 2. Since 1 >= 2 - 1, it allows it (window of 1) and increments to 3.
    const redis = new Redis(redisUrl);
    try {
      const keys = await redis.keys('auth:session:*:cooldown');
      if (keys.length > 0) {
        await redis.del(...keys);
      }

      const lateRefresh = await testApp.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        payload: refreshPayload, // the original refresh token
      });
      // Window of 1 allows this, returning 200
      expect(lateRefresh.statusCode).toBe(200);

      // 4. Too late refresh: Using the original refresh token AGAIN.
      // The version is 1, stored version is now 3. Since 1 >= 3 - 1 (1 >= 2) is false, it rejects.
      if (keys.length > 0) {
        await redis.del(...keys);
      }
      const tooLateRefresh = await testApp.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        payload: refreshPayload,
      });
      expect(tooLateRefresh.statusCode).toBe(401);
    } finally {
      redis.disconnect();
    }
  });
});










// TIMING ATTACK RESISTANCE STATISTICAL VALIDATION SUITE
describe('Authentication Timing Attack Side-Channel Resistance', () => {
  it('should exhibit a negligible statistical distribution variance between valid and invalid signature attempts', async () => {
    if (!redisAvailable || app === null) return;
    await flushAuthKeys();

    const kp = Keypair.random();
    const challengeRes = await app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      payload: { walletAddress: kp.publicKey() },
    });
    const { nonce } = challengeRes.json<any>();
    
    const validSig = kp.sign(Buffer.from(nonce, 'hex')).toString('hex');
    const invalidSig = Buffer.alloc(64).toString('hex');

    const validRuntimes: number[] = [];
    const invalidRuntimes: number[] = [];

    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      await app.inject({
        method: 'POST',
        url: '/api/auth/verify',
        headers: { 'x-test-bypass': 'true' },
        payload: { walletAddress: kp.publicKey(), signature: validSig },
      });
      validRuntimes.push(performance.now() - t0);

      const t1 = performance.now();
      await app.inject({
        method: 'POST',
        url: '/api/auth/verify',
        headers: { 'x-test-bypass': 'true' },
        payload: { walletAddress: kp.publicKey(), signature: invalidSig },
      });
      invalidRuntimes.push(performance.now() - t1);
    }

    const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = (arr: number[], m: number) => arr.reduce((a, b) => a + Math.pow(b - m, 2), 0) / (arr.length - 1);

    const mValid = mean(validRuntimes);
    const mInvalid = mean(invalidRuntimes);
    const vValid = variance(validRuntimes, mValid);
    const vInvalid = variance(invalidRuntimes, mInvalid);

    const tScore = (mValid - mInvalid) / Math.sqrt((vValid / 100) + (vInvalid / 100));
    expect(Math.abs(tScore)).toBeLessThan(2.58);
  });
});
