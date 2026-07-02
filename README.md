# IoT Billing Backend

Enterprise-grade Web3/IoT billing backend integrating Soroban smart contracts for hardware telemetry metering and payment processing.

**Stack:** TypeScript, Fastify, PostgreSQL + TimescaleDB, Redis, Soroban RPC, OpenTelemetry

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [Available Scripts](#available-scripts)
- [Environment Variables](#environment-variables)
- [Project Structure](#project-structure)
- [API Endpoints](#api-endpoints)
- [Key Technical Decisions](#key-technical-decisions)
- [Load Testing Suite](#load-testing-suite)
- [Testing](#testing)
- [CI/CD](#cicd)
- [Contributing](#contributing)
- [Security](#security)

---

## Features

- **Hardware Telemetry Ingestion** — Ed25519-signature-verified IoT device payloads with nonce replay protection
- **Soroban Smart Contract Integration** — Transaction submission with nonce pool, circuit breaker, fee optimizer, and tx manager
- **Zero-Knowledge Range Proofs** — Bulletproof-style cryptographic verification of private sensor data
- **mTLS Ingestion Gateway** — X.509 certificate validation with OCSP stapling, Redis caching, and hot-reload revocation
- **TimescaleDB Storage** — Hypertables for time-series telemetry with continuous aggregates and automatic partitioning
- **Web3 Authentication** — Challenge-response auth with JWT, rate limiting, and WebSocket support
- **Observability** — OpenTelemetry tracing with Prometheus metrics export

---

## Architecture

```
src/
├── config/                   # Zod-validated environment configuration, metric range maps
├── core/
│   ├── ingestion/            # Telemetry validation, parsing, locking, backpressure, state machine
│   ├── blockchain/           # Soroban RPC, nonce pool, circuit breaker, fee optimizer, tx manager
│   ├── crypto/               # ZK range proof verification (Bulletproof-style, 64-byte proofs)
│   ├── utils/                # SafeMath (7-decimal precision, overflow protection)
│   └── diagnostics/          # OpenTelemetry tracing and metrics
├── database/                 # Elastic pool manager, TimescaleDB migrations, continuous aggregates
├── api/                      # Fastify server routes, Web3 auth, rate limiter, mTLS gateway, Prometheus
├── tests/
│   ├── unit/                 # Crypto, blockchain, ingestion, config, state machine tests
│   ├── integration/          # Full-pipeline integration tests (TimescaleDB + mTLS)
│   └── load/                 # 50k concurrent client simulation suite
└── metrics/                  # Prometheus instrumentation setup
```

---

## Prerequisites

- **Node.js** >= 20
- **PostgreSQL** 16+ with **TimescaleDB** extension
- **Redis** (for nonce cache, rate limiter persistence, mTLS certificate cache)
- **npm** (or pnpm)

---

## Getting Started

```bash
# Clone
git clone https://github.com/IoT-Billing-Service/iot-billing-backend.git
cd iot-billing-backend

# Configure environment
cp .env.example .env
# Edit .env with your database and RPC credentials

# Install dependencies
npm install

# Generate Prisma client
npm run db:generate

# Run database migrations
npm run db:migrate

# Seed development data
npm run db:seed

# Start development server
npm run dev
```

The server starts at `http://localhost:3000`.

---

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server with hot reload (tsx watch) |
| `npm run build` | Compile TypeScript to JavaScript |
| `npm start` | Run compiled production server |
| `npm test` | Run unit tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:integration` | Run integration tests (requires TimescaleDB) |
| `npm run test:load` | Execute load simulation |
| `npm run test:load:unit` | Run load suite unit tests |
| `npm run typecheck` | TypeScript type checking |
| `npm run lint` | ESLint check |
| `npm run format` | Prettier formatting check |
| `npm run db:generate` | Generate Prisma client |
| `npm run db:migrate` | Run Prisma migrations |
| `npm run db:push` | Push Prisma schema to database |
| `npm run db:seed` | Seed database with test data |
| `npm run db:studio` | Open Prisma Studio |

### Load Testing Scripts

| Command | Description |
|---------|-------------|
| `npm run load:smoke` | Quick smoke test (verifies load suite works) |
| `npm run load:steady` | Sustained load: 1 payload/sec/device |
| `npm run load:burst` | Burst load: 8 payloads/sec/device peak |
| `npm run load:recovery` | Idle/peak cycles |
| `npm run k6:bundle` | Build k6 test snapshots |
| `npm run k6:steady` | Run k6 steady-state profile |
| `npm run k6:burst` | Run k6 burst profile |
| `npm run k6:recovery` | Run k6 recovery profile |
| `npm run k6:diurnal` | Run k6 diurnal pattern profile |

---

## Environment Variables

See `.env.example` for all required configuration.

| Variable | Description |
|----------|-------------|
| `NODE_ENV` | Environment (`development`, `production`, `test`) |
| `HOST` | Server host (default: `0.0.0.0`) |
| `PORT` | Server port (default: `3000`) |
| `DATABASE_URL` | PostgreSQL connection string |
| `TIMESCALEDB_URL` | TimescaleDB connection string |
| `REDIS_URL` | Redis connection string |
| `SOROBAN_RPC_URL` | Stellar Soroban RPC endpoint |
| `SOROBAN_NETWORK_PASSPHRASE` | Stellar network passphrase |
| `CONTRACT_ID` | Deployed smart contract ID |
| `ADMIN_SECRET_KEY` | Stellar admin secret key |
| `JWT_SECRET` | 32+ character signing secret |
| `JWT_EXPIRES_IN` | JWT expiration (default: `15m`) |
| `CHALLENGE_TTL_SECONDS` | Web3 challenge TTL (default: `300`) |
| `MAX_PAYLOAD_SIZE_BYTES` | Max telemetry payload size (default: `65536`) |
| `NONCE_WINDOW_MS` | Nonce replay protection window (default: `5000`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OpenTelemetry collector endpoint |
| `OTEL_SERVICE_NAME` | OpenTelemetry service name |

---

## Project Structure

```
iot-billing-backend/
├── src/
│   ├── api/              # Fastify server, routes, middleware
│   │   ├── index.ts      # Server entry point
│   │   ├── routes/       # Route handlers
│   │   ├── middleware/    # Auth, rate limiting, mTLS
│   │   └── plugins/      # Fastify plugins
│   ├── config/           # Environment validation (zod), metric ranges
│   ├── core/
│   │   ├── ingestion/    # Telemetry ingestion pipeline
│   │   ├── blockchain/   # Soroban integration
│   │   ├── crypto/       # ZK proof verification
│   │   ├── diagnostics/  # OpenTelemetry tracing
│   │   └── utils/        # SafeMath, helpers
│   ├── database/         # Prisma schema, migrations, seeding
│   └── metrics/          # Prometheus metrics
├── contracts/            # Soroban contract bindings and ABIs
├── tests/
│   ├── unit/             # Unit tests
│   ├── integration/      # Integration tests
│   └── load/             # Load testing suite
├── docs/                 # Planning and technical documentation
├── prisma/               # Prisma schema and migrations
├── .env.example          # Environment template
├── vitest.config.ts      # Unit test configuration
└── vitest.integration.config.ts  # Integration test configuration
```

---

## API Endpoints

### Telemetry Ingestion

```
POST /ingest
Content-Type: application/json

{
  "payload": { ... signed telemetry data },
  "publicKey": "GXXX..."
}
```

### Health

```
GET /health
GET /_stats
```

### Web3 Auth

```
POST /auth/challenge    # Request signing challenge
POST /auth/verify       # Verify signed challenge, receive JWT
```

### Admin

```
PATCH /api/admin/certificates/:serial/revoke  # Revoke mTLS certificate
```

---

## Key Technical Decisions

- **Fastify** over Express: 2-3x throughput, schema-based serialization, native async
- **Ed25519 signatures** for hardware payloads: stateless, high-performance, Stellar-native
- **TimescaleDB** hypertables: automatic partitioning, compression (85%+ ratio), continuous aggregates
- **PostgreSQL advisory locks**: distributed mutual exclusion without external dependencies
- **Circuit breaker pattern**: protects Soroban RPC from cascading failures
- **Two-phase commit state machine**: PENDING → TENTATIVE → SETTLED/ROLLED_BACK with reconciliation

### ZK Range Proof Verification

Bulletproof-style 64-byte proof structure: `[16-byte commitment][16-byte challenge][32-byte response]`

- Challenge generation uses Fiat-Shamir heuristic binding device identity and target bounds
- Verified against `MetricRangeMap` in `src/config/metric_ranges.ts`
- Synchronous verification, <10ms, <1KB per proof

### mTLS Ingestion Gateway

- PostgreSQL-backed `HardwareCertificate` table replaces in-memory whitelist
- O(1) Redis cache for active/revoked certificate statuses
- Postgres `LISTEN/NOTIFY` for instant cache invalidation on revocation
- OCSP stapling verification against X.509 certificate's Subject Information Access extension

---

## Load Testing Suite

The load testing suite simulates high-density concurrent device telemetry ingestion.

### Architecture

```
tests/load/
├── mock_server.ts              # Fastify standalone mock ingestion gateway
├── lib/
│   ├── run_load.ts             # HTTP driver with concurrency-controlled workers
│   └── report.ts               # Metrics reporting
├── k6_scripts/                 # k6 staging profiles
│   ├── steady_state.ts
│   ├── burst.ts
│   ├── recovery.ts
│   └── diurnal_pattern.ts
├── simulation_runner.ts        # Legacy profile runner
└── cli_smoke.ts                # Quick smoke test
```

### Profiles

| Profile | Rate | Description |
|---------|------|-------------|
| `steady_state` | 1 payload/sec/device | Sustained normal load |
| `burst` | 8 payloads/sec/device | Peak load spike (0 to 50k VU ramp) |
| `recovery` | 0.25 payloads/sec/device | Idle/peak cycles |
| `diurnal` | Variable | Day/night usage pattern |

### Metrics

- p50/p90/p95/p99 latency
- Throughput (requests/sec)
- Error rate
- Rejections by reason
- Target gates (pass/fail)

### Running Load Tests

```bash
# Start mock server
npm run load:mock

# Run smoke test
SMOKE_PORT=0 npm run load:smoke

# Run steady-state profile
npm run load:steady -- --http http://localhost:3001

# k6 profiles (requires k6 installed)
npm run k6:bundle
npm run k6:steady
```

---

## Testing

### Unit Tests

```bash
npm test
```

Covers: crypto verification, blockchain nonce pool, ingestion validation, state machine, configuration, load suite utilities.

### Integration Tests

```bash
npm run test:integration
```

Requires TimescaleDB. Tests full pipeline: mTLS → ingestion → database → blockchain submission.

### Load Tests

```bash
npm run test:load:unit        # Load suite unit tests
npm run load:smoke            # Quick smoke test
```

---

## CI/CD

GitHub Actions runs on every push/PR to `main`:

1. **Lint & Format** — ESLint + Prettier
2. **Type Check** — `tsc --noEmit`
3. **Unit Tests** — Vitest (includes load suite unit tests)
4. **Integration Tests** — TimescaleDB container + Prisma generate
5. **Build** — TypeScript compilation

### Load Test CI Gate

A separate workflow (`.github/workflows/load-test.yml`) runs:
- ESLint on load test files
- Prettier check
- Load suite unit tests
- CLI smoke test

---

## Contributing

### Principles

- Correctness over speed
- Security over convenience
- Readability over cleverness
- Explicit assumptions over hidden behavior
- Small, reviewable changes over broad rewrites

### Guidelines

1. Read relevant source files, tests, and config before making changes
2. Validate all external input — treat RPC responses as unreliable until checked
3. Handle chain reorganizations where relevant
4. Make indexing idempotent
5. Add tests for any behavioral change
6. Never commit secrets or real credentials

### Running Checks

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

---

## Security

- **Ed25519 signature verification** for all hardware telemetry payloads
- **Nonce replay protection** with configurable time window (default: 5s)
- **ZK range proof verification** prevents sensor data tampering
- **mTLS certificate validation** with OCSP real-time checks
- **Circuit breaker pattern** prevents cascading Soroban RPC failures
- **Rate limiting** on all API endpoints
- **Web3 challenge-response auth** with JWT

### Hardware Certificate Management

- Certificates stored in PostgreSQL with active/revoked status
- Redis cache for O(1) lookup
- Real-time revocation via Postgres `LISTEN/NOTIFY`
- Admin revocation endpoint: `PATCH /api/admin/certificates/:serial/revoke`

---

## License

By contributing, you agree that your contributions will be licensed under the same license as the project.
