import crypto from 'node:crypto';
import jwt, { SignOptions } from 'jsonwebtoken';
import nacl from 'tweetnacl';
import { StrKey } from '@stellar/stellar-sdk';
import type { Redis } from 'ioredis';
import { getEnv } from '../../config/env.js';
import { getRedis } from '../../database/redis.js';

export interface SessionPayload {
  sub: string;
  wallet: string;
  session_id: string;
  version: number;
  iat: number;
  exp: number;
}

export interface RefreshTokenPayload {
  sub: string;
  wallet: string;
  session_id: string;
  device_id: string;
  version: number;
  iat: number;
  exp: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface ChallengeResult {
  nonce: string;
  expiresAt: number;
}

const CHALLENGE_KEY_PREFIX = 'auth:challenge:';

/**
 * Generate a 32-byte cryptographically random nonce, hex-encoded (64 chars).
 */
export function generateNonce(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Validate a Stellar Ed25519 public key string (G...).
 */
export function isValidStellarAddress(address: string): boolean {
  if (typeof address !== 'string' || address.length === 0) {
    return false;
  }
  try {
    const decoded = StrKey.decodeEd25519PublicKey(address);
    return decoded.length === 32;
  } catch {
    return false;
  }
}

/**
 * Decode a Stellar Ed25519 public key string to 32 raw bytes.
 */
export function decodeStellarPublicKey(address: string): Uint8Array {
  const decoded = StrKey.decodeEd25519PublicKey(address);
  if (decoded.length !== 32) {
    throw new Error('Decoded Stellar public key is not 32 bytes');
  }
  return new Uint8Array(decoded);
}

/**
 * Verify an Ed25519 detached signature over the raw 32 bytes of a hex nonce.
 * Returns false on any malformed input rather than throwing.
 */
export function verifyEd25519Signature(
  nonceHex: string,
  signatureHex: string,
  publicKey: Uint8Array,
): boolean {
  if (typeof nonceHex !== 'string' || typeof signatureHex !== 'string') {
    return false;
  }
  if (!/^[0-9a-fA-F]+$/.test(nonceHex) || nonceHex.length !== 64) {
    return false;
  }
  if (!/^[0-9a-fA-F]+$/.test(signatureHex) || signatureHex.length !== 128) {
    return false;
  }
  if (publicKey.length !== 32) {
    return false;
  }
  try {
    const message = Buffer.from(nonceHex, 'hex');
    const signature = Buffer.from(signatureHex, 'hex');
    return nacl.sign.detached.verify(message, signature, publicKey);
  } catch {
    return false;
  }
}

export class ChallengeStore {
  private readonly redis: Redis;
  private readonly ttlSeconds: number;

  constructor(redis: Redis, ttlSeconds: number) {
    this.redis = redis;
    this.ttlSeconds = ttlSeconds;
  }

  private key(walletAddress: string): string {
    return `${CHALLENGE_KEY_PREFIX}${walletAddress}`;
  }

  /**
   * Create a new challenge for a wallet. Uses SET EX NX so a second
   * unexpired challenge for the same wallet returns null (single-use +
   * anti-flood). The returned nonce is hex-encoded (64 chars).
   */
  async create(walletAddress: string): Promise<ChallengeResult | null> {
    const nonce = generateNonce();
    const key = this.key(walletAddress);
    const result = await this.redis.set(key, nonce, 'EX', this.ttlSeconds, 'NX');
    if (result !== 'OK') {
      return null;
    }
    return { nonce, expiresAt: Date.now() + this.ttlSeconds * 1000 };
  }

  /**
   * Atomically read-and-delete the pending challenge for a wallet.
   * Returns the stored nonce hex string, or null if absent.
   */
  async consume(walletAddress: string): Promise<string | null> {
    const key = this.key(walletAddress);
    const results = await this.redis.multi().get(key).del(key).exec();
    if (!results || results.length === 0) return null;
    const firstResult = results[0];
    if (!firstResult) return null;
    const [getErr, getVal] = firstResult;
    if (getErr) return null;
    return getVal as string | null;
  }

  getTtlSeconds(): number {
    return this.ttlSeconds;
  }
}

let defaultStore: ChallengeStore | null = null;

function getDefaultStore(): ChallengeStore {
  if (defaultStore === null) {
    const env = getEnv();
    defaultStore = new ChallengeStore(getRedis(), env.CHALLENGE_TTL_SECONDS);
  }
  return defaultStore;
}

/**
 * Generate a challenge nonce for a wallet address.
 * Returns null if a challenge is already pending for this wallet
 * (the caller should treat this as a 409 Conflict).
 */
export async function generateChallenge(walletAddress: string): Promise<ChallengeResult | null> {
  return getDefaultStore().create(walletAddress);
}

/**
 * Verify a challenge response. Validates the Stellar public key,
 * atomically consumes the pending nonce (single-use), and verifies
 * the Ed25519 detached signature over the raw 32 nonce bytes.
 */
export async function verifyChallenge(
  walletAddress: string,
  signatureHex: string,
): Promise<boolean> {
  if (!isValidStellarAddress(walletAddress)) {
    return false;
  }
  let publicKey: Uint8Array;
  try {
    publicKey = decodeStellarPublicKey(walletAddress);
  } catch {
    return false;
  }
  const nonce = await getDefaultStore().consume(walletAddress);
  if (nonce === null) {
    return false;
  }
  return verifyEd25519Signature(nonce, signatureHex, publicKey);
}

export async function issueSessionTokens(
  walletAddress: string,
  deviceId: string,
): Promise<TokenPair> {
  const env = getEnv();
  const redis = getRedis();
  const sessionId = crypto.randomUUID();
  const version = 1;

  const sessionKey = `auth:session:${sessionId}`;
  await redis.hset(sessionKey, {
    wallet: walletAddress,
    device_id: deviceId,
    token_version: version.toString(),
  });
  await redis.expire(sessionKey, 7 * 24 * 60 * 60);

  const payload: Omit<SessionPayload, 'iat' | 'exp'> = {
    sub: walletAddress,
    wallet: walletAddress,
    session_id: sessionId,
    version,
  };
  const accessOpts: SignOptions = {
    expiresIn: env.JWT_EXPIRES_IN as string & SignOptions['expiresIn'],
  };
  const accessToken = jwt.sign(payload, env.JWT_SECRET, accessOpts);

  const refreshPayload: Omit<RefreshTokenPayload, 'iat' | 'exp'> = {
    ...payload,
    device_id: deviceId,
  };
  const refreshOpts: SignOptions = {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN as string & SignOptions['expiresIn'],
  };
  const refreshToken = jwt.sign(refreshPayload, env.JWT_SECRET, refreshOpts);

  return { accessToken, refreshToken };
}

export async function refreshSession(
  refreshToken: string,
  deviceId: string,
): Promise<TokenPair | null> {
  const env = getEnv();
  const redis = getRedis();

  let decoded: RefreshTokenPayload;
  try {
    decoded = jwt.verify(refreshToken, env.JWT_SECRET) as RefreshTokenPayload;
  } catch {
    return null;
  }

  if (decoded.device_id !== deviceId) {
    return null;
  }

  const sessionId = decoded.session_id;
  const version = decoded.version;

  const lockKey = `refresh_lock:${sessionId}`;
  await redis.set(lockKey, '1', 'EX', 10);

  let resultTokens: TokenPair | null = null;

  try {
    const cooldownKey = `auth:session:${sessionId}:cooldown`;
    const cachedTokens = await redis.get(cooldownKey);
    if (cachedTokens !== null) {
      resultTokens = JSON.parse(cachedTokens) as TokenPair;
      return resultTokens;
    }

    const sessionKey = `auth:session:${sessionId}`;
    const sessionData = await redis.hgetall(sessionKey);
    if (Object.keys(sessionData).length === 0) {
      return null;
    }

    const storedVersion = parseInt(sessionData['token_version'] ?? '1', 10);
    if (version < storedVersion - 1) {
      return null;
    }

    const newVersion = storedVersion + 1;
    await redis.hset(sessionKey, { token_version: newVersion.toString() });

    const payload: Omit<SessionPayload, 'iat' | 'exp'> = {
      sub: decoded.wallet,
      wallet: decoded.wallet,
      session_id: sessionId,
      version: newVersion,
    };
    const accessOpts: SignOptions = {
      expiresIn: env.JWT_EXPIRES_IN as string & SignOptions['expiresIn'],
    };
    const accessToken = jwt.sign(payload, env.JWT_SECRET, accessOpts);

    const refreshPayload: Omit<RefreshTokenPayload, 'iat' | 'exp'> = {
      ...payload,
      device_id: deviceId,
    };
    const refreshOpts: SignOptions = {
      expiresIn: env.JWT_REFRESH_EXPIRES_IN as string & SignOptions['expiresIn'],
    };
    const newRefreshToken = jwt.sign(refreshPayload, env.JWT_SECRET, refreshOpts);

    const tokens = { accessToken, refreshToken: newRefreshToken };
    await redis.set(cooldownKey, JSON.stringify(tokens), 'EX', 5);

    resultTokens = tokens;
    return resultTokens;
  } finally {
    await redis.del(lockKey);
  }
}

export function verifySessionToken(token: string, ignoreExpiration = false): SessionPayload | null {
  const env = getEnv();
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, { ignoreExpiration }) as SessionPayload;
    return decoded;
  } catch {
    return null;
  }
}
