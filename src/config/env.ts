import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  TIMESCALEDB_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  SOROBAN_RPC_URL: z.string().url(),
  SOROBAN_NETWORK_PASSPHRASE: z.string(),
  CONTRACT_ID: z.string().optional(),
  ADMIN_SECRET_KEY: z.string().optional(),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('15m'),
  CHALLENGE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().default('iot-billing-backend'),
  MAX_PAYLOAD_SIZE_BYTES: z.coerce.number().int().positive().default(65536),
  NONCE_WINDOW_MS: z.coerce.number().int().positive().default(5000),
  LEDGER_START: z.coerce.number().int().nonnegative().default(0),
  LEDGER_SYNC_CONCURRENCY: z.coerce.number().int().positive().default(10),
  // Telemetry hypertable retention (must match add_retention_policy in
  // timescale_setup.sql) and a safety margin kept clear of the retention
  // boundary. Continuous-aggregate refreshes never touch data older than
  // (retention - margin) days, so a refresh can't race a chunk drop (issue #51).
  TELEMETRY_RETENTION_DAYS: z.coerce.number().int().positive().default(365),
  RETENTION_SAFETY_MARGIN_DAYS: z.coerce.number().int().nonnegative().default(5),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

export function loadEnv(): Env {
  if (cachedEnv) return cachedEnv;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Environment validation failed: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`,
    );
  }
  cachedEnv = parsed.data;
  return cachedEnv;
}

export function getEnv(): Env {
  if (!cachedEnv) return loadEnv();
  return cachedEnv;
}

export function clearEnvCache(): void {
  cachedEnv = null;
}
