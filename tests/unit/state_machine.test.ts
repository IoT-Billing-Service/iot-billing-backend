import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IngestionStateMachine, IngestionState } from '../../src/core/ingestion/state_machine.js';
import { BalanceManager, BillingStateMachine } from '../../src/core/blockchain/balance_manager.js';
import { TransactionManager } from '../../src/core/blockchain/tx_manager.js';
import { NoncePool } from '../../src/core/blockchain/nonce_pool.js';
import { SorobanRpcClient } from '../../src/core/blockchain/rpc_client.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAdminRoutes } from '../../src/api/routes/admin.js';
import { clearEnvCache } from '../../src/config/env.js';

interface AdminResponse {
  success: boolean;
  recordId: string;
  action: string;
  previousState?: string;
  newState: string;
  reason: string;
  timestamp: number;
  error?: string;
  message?: string;
}

/**
 * Safely parse a Fastify inject response body into a typed object.
 * The body is guaranteed to be a string for JSON payloads.
 */
function parseAdminResponse(body: unknown): AdminResponse {
  return JSON.parse(body as string) as AdminResponse;
}

// ─── IngestionStateMachine Tests ───────────────────────────────────────────

describe('IngestionStateMachine with RECONCILING', () => {
  let sm: IngestionStateMachine;

  beforeEach(() => {
    sm = new IngestionStateMachine(IngestionState.PENDING);
  });

  it('should transition PENDING -> TENTATIVE -> SETTLED', () => {
    expect(sm.transition(IngestionState.TENTATIVE, 'starting processing')).toBe(true);
    expect(sm.getState()).toBe(IngestionState.TENTATIVE);
    expect(sm.transition(IngestionState.SETTLED, 'on-chain confirmed')).toBe(true);
    expect(sm.getState()).toBe(IngestionState.SETTLED);
  });

  it('should reject invalid transition from PENDING to SETTLED', () => {
    expect(sm.transition(IngestionState.SETTLED, 'skip tentative')).toBe(false);
    expect(sm.getState()).toBe(IngestionState.PENDING);
  });

  it('should allow rollback from tentative and then reconcile', () => {
    const sm2 = new IngestionStateMachine(IngestionState.TENTATIVE);
    expect(sm2.transition(IngestionState.ROLLED_BACK, 'tx rejected')).toBe(true);
    expect(sm2.getState()).toBe(IngestionState.ROLLED_BACK);

    expect(sm2.transition(IngestionState.RECONCILING, 'starting reconciliation')).toBe(true);
    expect(sm2.getState()).toBe(IngestionState.RECONCILING);

    expect(sm2.transition(IngestionState.PENDING, 'reconciliation complete')).toBe(true);
    expect(sm2.getState()).toBe(IngestionState.PENDING);
  });

  it('should reject transition from SETTLED to RECONCILING', () => {
    const sm2 = new IngestionStateMachine(IngestionState.SETTLED);
    expect(sm2.transition(IngestionState.RECONCILING, 'should not work')).toBe(false);
  });

  it('should allow RECONCILING -> FAILED when reconciliation fails', () => {
    const sm2 = new IngestionStateMachine(IngestionState.RECONCILING);
    expect(sm2.transition(IngestionState.FAILED, 'reconciliation failed')).toBe(true);
    expect(sm2.getState()).toBe(IngestionState.FAILED);
  });

  it('should track transition history correctly', () => {
    const sm2 = new IngestionStateMachine(IngestionState.PENDING);
    sm2.transition(IngestionState.TENTATIVE, 'start');
    sm2.transition(IngestionState.ROLLED_BACK, 'rejected');
    sm2.transition(IngestionState.RECONCILING, 'reconcile');

    const history = sm2.getHistory();
    expect(history).toHaveLength(3);
    expect(history[0]?.from).toBe(IngestionState.PENDING);
    expect(history[0]?.to).toBe(IngestionState.TENTATIVE);
    expect(history[1]?.to).toBe(IngestionState.ROLLED_BACK);
    expect(history[2]?.to).toBe(IngestionState.RECONCILING);
  });

  it('should report canTransitionTo correctly', () => {
    const sm2 = new IngestionStateMachine(IngestionState.ROLLED_BACK);
    expect(sm2.canTransitionTo(IngestionState.RECONCILING)).toBe(true);
    expect(sm2.canTransitionTo(IngestionState.SETTLED)).toBe(false);
    expect(sm2.canTransitionTo(IngestionState.TENTATIVE)).toBe(false);

    const sm3 = new IngestionStateMachine(IngestionState.RECONCILING);
    expect(sm3.canTransitionTo(IngestionState.PENDING)).toBe(true);
    expect(sm3.canTransitionTo(IngestionState.FAILED)).toBe(true);
  });
});

// ─── BillingStateMachine Tests ─────────────────────────────────────────────

describe('BillingStateMachine', () => {
  it('should handle on-chain rejection with reconciliation flow', () => {
    const bsm = new BillingStateMachine(IngestionState.TENTATIVE);
    const result = bsm.handleOnChainRejection('tx_bad_seq: sequence number mismatch');

    expect(result).toBe(true);
    expect(bsm.getState()).toBe(IngestionState.RECONCILING);

    const history = bsm.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0]?.to).toBe(IngestionState.ROLLED_BACK);
    expect(history[1]?.to).toBe(IngestionState.RECONCILING);
  });

  it('should reject on-chain handling when not in TENTATIVE', () => {
    const bsm = new BillingStateMachine(IngestionState.PENDING);
    const result = bsm.handleOnChainRejection('tx_bad_seq');
    expect(result).toBe(false);
    expect(bsm.getState()).toBe(IngestionState.PENDING);
  });

  it('should complete reconciliation back to PENDING', () => {
    const bsm = new BillingStateMachine(IngestionState.RECONCILING);
    expect(bsm.completeReconciliation()).toBe(true);
    expect(bsm.getState()).toBe(IngestionState.PENDING);
  });

  it('should fail reconciliation', () => {
    const bsm = new BillingStateMachine(IngestionState.RECONCILING);
    expect(bsm.failReconciliation('unrecoverable error')).toBe(true);
    expect(bsm.getState()).toBe(IngestionState.FAILED);
  });

  it('should not complete reconciliation from non-RECONCILING state', () => {
    const bsm = new BillingStateMachine(IngestionState.SETTLED);
    expect(bsm.completeReconciliation()).toBe(false);
  });
});

// ─── BalanceManager Tests ──────────────────────────────────────────────────

describe('BalanceManager', () => {
  let balanceManager: BalanceManager;
  let reconciliationCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    reconciliationCallback = vi.fn();
    balanceManager = new BalanceManager(
      'https://horizon-testnet.stellar.org',
      reconciliationCallback,
    );
  });

  afterEach(() => {
    balanceManager.stop();
  });

  it('should start and stop cleanly', () => {
    expect(() => {
      balanceManager.start();
    }).not.toThrow();
    expect(() => {
      balanceManager.stop();
    }).not.toThrow();
  });

  it('should start only once', () => {
    balanceManager.start();
    expect(() => {
      balanceManager.start();
    }).not.toThrow();
    balanceManager.stop();
  });

  it('should track transaction count', () => {
    expect(balanceManager.getTransactionCount()).toBe(0);
  });

  it('should reset transaction count', () => {
    for (let i = 0; i < 5; i++) {
      void balanceManager.recordTransaction({
        accountId: 'acc-1',
        stellarAddress: 'GABCDEF123',
        localBalance: 1000n,
      });
    }
    expect(balanceManager.getTransactionCount()).toBe(5);
    balanceManager.resetTransactionCount();
    expect(balanceManager.getTransactionCount()).toBe(0);
  });

  it('should trigger reconciliation at threshold', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => ({
        balances: [{ asset_type: 'native', balance: '0.0001000' }],
      }),
    });

    for (let i = 0; i < 99; i++) {
      await balanceManager.recordTransaction({
        accountId: 'acc-1',
        stellarAddress: 'GABCDEF123',
        localBalance: 1000n,
      });
    }
    expect(balanceManager.getTransactionCount()).toBe(99);

    const result = await balanceManager.recordTransaction({
      accountId: 'acc-1',
      stellarAddress: 'GABCDEF123',
      localBalance: 1000n,
    });

    expect(result).not.toBeNull();
    if (result == null) throw new Error('result should not be null');
    expect(result.accountId).toBe('acc-1');
    expect(result.stellarAddress).toBe('GABCDEF123');
    expect(result.onChainBalance).toBe(1000n);
    expect(balanceManager.getTransactionCount()).toBe(0);

    globalThis.fetch = originalFetch;
  });

  it('should reconcile after rollback', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => ({
        balances: [{ asset_type: 'native', balance: '0.0002000' }],
      }),
    });

    const result = await balanceManager.reconcileAfterRollback('acc-1', 'GABCDEF123', 500n);

    expect(result.accountId).toBe('acc-1');
    expect(result.onChainBalance).toBe(2000n);
    expect(result.localBalance).toBe(2000n);
    expect(result.corrected).toBe(true);
    expect(result.discrepancy).toBe(500n - 2000n);
    expect(reconciliationCallback).toHaveBeenCalledTimes(1);

    globalThis.fetch = originalFetch;
  });

  it('should handle Horizon API errors', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      statusText: 'Not Found',
      status: 404,
    });

    await expect(balanceManager.reconcileAfterRollback('acc-1', 'GINVALID', 500n)).rejects.toThrow(
      'Horizon API error',
    );

    globalThis.fetch = originalFetch;
  });

  it('should handle no native balance found', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => ({
        balances: [{ asset_type: 'credit_alphanum4', balance: '100.0' }],
      }),
    });

    await expect(balanceManager.reconcileAfterRollback('acc-1', 'GABCDEF', 500n)).rejects.toThrow(
      'No native balance found',
    );

    globalThis.fetch = originalFetch;
  });

  it('should handle large XLM balance conversion without precision loss', async () => {
    const originalFetch = globalThis.fetch;
    // 1,234,567.8901234 XLM should convert exactly
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => ({
        balances: [{ asset_type: 'native', balance: '1234567.8901234' }],
      }),
    });

    const result = await balanceManager.reconcileAfterRollback(
      'acc-1',
      'GABCDEF123',
      12345678901234n,
    );

    expect(result.onChainBalance).toBe(12345678901234n); // 1234567.8901234 * 10_000_000
    expect(result.corrected).toBe(false); // local matches on-chain
    expect(result.discrepancy).toBe(0n);

    globalThis.fetch = originalFetch;
  });

  it('should handle very small XLM balances', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => ({
        balances: [{ asset_type: 'native', balance: '0.0000001' }],
      }),
    });

    const result = await balanceManager.reconcileAfterRollback('acc-1', 'GABCDEF123', 0n);

    expect(result.onChainBalance).toBe(1n); // 0.0000001 * 10_000_000 = 1 stroop
    expect(result.corrected).toBe(true);

    globalThis.fetch = originalFetch;
  });

  it('should handle zero XLM balance', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => ({
        balances: [{ asset_type: 'native', balance: '0.0000000' }],
      }),
    });

    const result = await balanceManager.reconcileAfterRollback('acc-1', 'GABCDEF123', 100n);

    expect(result.onChainBalance).toBe(0n);

    globalThis.fetch = originalFetch;
  });
});

// ─── TransactionManager tx_bad_seq Error Handling Tests ────────────────────

describe('TransactionManager tx_bad_seq handling', () => {
  let rpcClient: SorobanRpcClient;
  let noncePool: NoncePool;
  let txManager: TransactionManager;

  beforeEach(() => {
    rpcClient = new SorobanRpcClient('https://rpc.example.com');
    noncePool = new NoncePool();
    txManager = new TransactionManager(rpcClient, noncePool);
  });

  it('should prefix tx_bad_seq error with ERR:', async () => {
    vi.spyOn(rpcClient, 'submitTransaction').mockRejectedValue(
      new Error('tx_bad_seq: sequence number mismatch, expected 42 got 7'),
    );

    const record = await txManager.submitChargeUsage('worker-1', 'dev-001', 100n, 'contract-1');

    expect(record.status).toBe('failed');
    expect(record.error).toBe('ERR:tx_bad_seq: sequence number mismatch, expected 42 got 7');
  });

  it('should not prefix non tx_bad_seq errors', async () => {
    vi.spyOn(rpcClient, 'submitTransaction').mockRejectedValue(new Error('insufficient funds'));

    const record = await txManager.submitChargeUsage('worker-1', 'dev-001', 100n, 'contract-1');

    expect(record.status).toBe('failed');
    expect(record.error).toBe('insufficient funds');
    expect(record.error).not.toContain('ERR:');
  });

  it('should handle case insensitive tx_bad_seq matching', async () => {
    vi.spyOn(rpcClient, 'submitTransaction').mockRejectedValue(new Error('TX_BAD_SEQ occurred'));

    const record = await txManager.submitChargeUsage('worker-1', 'dev-001', 100n, 'contract-1');

    expect(record.status).toBe('failed');
    expect(record.error).toBe('ERR:TX_BAD_SEQ occurred');
  });
});

// ─── Admin Route Tests ─────────────────────────────────────────────────────

describe('Admin Routes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    // Set admin secret key for testing
    process.env['ADMIN_SECRET_KEY'] = 'test-admin-secret-key';
    process.env['JWT_SECRET'] = 'a'.repeat(32);
    process.env['DATABASE_URL'] = 'postgresql://localhost:5432/test';
    process.env['TIMESCALEDB_URL'] = 'postgresql://localhost:5432/test';
    process.env['SOROBAN_RPC_URL'] = 'https://rpc.test';
    process.env['SOROBAN_NETWORK_PASSPHRASE'] = 'Test';

    app = Fastify();
    registerAdminRoutes(app);
  });

  afterEach(async () => {
    await app.close();
    delete process.env['ADMIN_SECRET_KEY'];
  });

  it('should reject force-settle without auth header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/force-settle',
      payload: { recordId: 'test-123' },
    });

    expect(response.statusCode).toBe(401);
    const body1 = parseAdminResponse(response.body);
    expect(body1.error).toBe('Unauthorized');
  });

  it('should reject force-settle with wrong auth header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/force-settle',
      headers: { 'x-admin-key': 'wrong-key' },
      payload: { recordId: 'test-123' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('should force-settle a record with valid auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/force-settle',
      headers: { 'x-admin-key': 'test-admin-secret-key' },
      payload: { recordId: 'rec-001', reason: 'Manual override' },
    });

    expect(response.statusCode).toBe(200);
    const body2 = parseAdminResponse(response.body);
    expect(body2.success).toBe(true);
    expect(body2.recordId).toBe('rec-001');
    expect(body2.action).toBe('force-settle');
    expect(body2.newState).toBe('SETTLED');
    expect(body2.reason).toBe('Manual override');
    expect(typeof body2.timestamp).toBe('number');
  });

  it('should force-settle with default reason', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/force-settle',
      headers: { 'x-admin-key': 'test-admin-secret-key' },
      payload: { recordId: 'rec-002' },
    });

    expect(response.statusCode).toBe(200);
    const body3 = parseAdminResponse(response.body);
    expect(body3.success).toBe(true);
    expect(body3.reason).toBe('Admin force settle');
  });

  it('should force-rollback a record with valid auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/force-rollback',
      headers: { 'x-admin-key': 'test-admin-secret-key' },
      payload: { recordId: 'rec-003', reason: 'Emergency rollback' },
    });

    expect(response.statusCode).toBe(200);
    const body4 = parseAdminResponse(response.body);
    expect(body4.success).toBe(true);
    expect(body4.recordId).toBe('rec-003');
    expect(body4.action).toBe('force-rollback');
    // After rollback, transitions to RECONCILING
    expect(body4.newState).toBe('RECONCILING');
    expect(body4.reason).toBe('Emergency rollback');
  });

  it('should reject force-rollback without auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/force-rollback',
      payload: { recordId: 'rec-004' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('should return 503 when ADMIN_SECRET_KEY is not configured', async () => {
    const app2 = Fastify();
    delete process.env['ADMIN_SECRET_KEY'];
    clearEnvCache();
    registerAdminRoutes(app2);

    const response = await app2.inject({
      method: 'POST',
      url: '/api/admin/force-settle',
      payload: { recordId: 'rec-005' },
    });

    expect(response.statusCode).toBe(503);
    const body5 = parseAdminResponse(response.body);
    expect(body5.error).toBe('Admin secret key not configured');

    await app2.close();
  });
});
