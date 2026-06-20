import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NoncePool } from '../../src/core/blockchain/nonce_pool.js';
import { SorobanRpcClient, CircuitState } from '../../src/core/blockchain/rpc_client.js';
import { IngestionStateMachine, IngestionState } from '../../src/core/ingestion/state_machine.js';
import { TransactionManager } from '../../src/core/blockchain/tx_manager.js';

describe('NoncePool', () => {
  let pool: NoncePool;

  beforeEach(() => {
    pool = new NoncePool();
  });

  it('should acquire sequential nonces', async () => {
    const a = await pool.acquire('worker-a');
    const b = await pool.acquire('worker-b');
    expect(b).toBe(a + 1);
  });

  it('should release nonce', async () => {
    await pool.acquire('worker-a');
    await pool.release('worker-a');
    expect(pool.getActiveCount()).toBe(0);
  });

  it('should support stress testing with 50 concurrent acquire calls and verify contiguous sequences', async () => {
    const promises = Array.from({ length: 50 }, (_, i) => pool.acquire(`worker-${String(i)}`));
    const results = await Promise.all(promises);

    expect(results).toHaveLength(50);
    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1];
      expect(prev).toBeDefined();
      if (typeof prev === 'number') {
        expect(results[i]).toBe(prev + 1);
      }
    }
  });

  it('should seed counter from on-ledger value on construction and synchronize', async () => {
    const mockHorizonClient = {
      fetchAccountSequence: (address: string): Promise<bigint> => {
        globalThis.console.log(`fetching account sequence for ${address}`);
        return Promise.resolve(42n);
      },
    };
    const syncPool = new NoncePool('GABCDEF', mockHorizonClient);
    const seq = await syncPool.acquire('worker-a');
    expect(seq).toBe(43); // 42 + 1
    syncPool.cleanup();
  });

  it('should synchronize only if drift is > 1', async () => {
    const ledgerSeq = 100n;
    const mockHorizonClient = {
      fetchAccountSequence: (address: string): Promise<bigint> => {
        globalThis.console.log(`fetching account sequence for ${address}`);
        return Promise.resolve(ledgerSeq);
      },
    };
    const syncPool = new NoncePool('GABCDEF', mockHorizonClient);
    await syncPool.acquire('worker-init');

    // Drift = 1, should not sync
    await syncPool.resetCounter(101);
    await syncPool.synchronize();
    expect(syncPool.getCurrentSequence()).toBe(101);

    // Drift = 2, should sync
    await syncPool.resetCounter(102);
    await syncPool.synchronize();
    expect(syncPool.getCurrentSequence()).toBe(100);

    // Ledger ahead, should sync
    await syncPool.resetCounter(98);
    await syncPool.synchronize();
    expect(syncPool.getCurrentSequence()).toBe(100);

    syncPool.cleanup();
  });

  it('should retry once on tx_bad_seq and succeed if the second attempt succeeds', async () => {
    const rpcClient = new SorobanRpcClient('https://rpc.example.com');
    let calls = 0;
    vi.spyOn(rpcClient, 'submitTransaction').mockImplementation(() => {
      calls++;
      if (calls === 1) {
        return Promise.reject(new Error('tx_bad_seq: sequence number mismatch'));
      }
      return Promise.resolve({ hash: 'tx-hash', status: 'success' });
    });

    const mockHorizonClient = {
      fetchAccountSequence: (address: string): Promise<bigint> => {
        globalThis.console.log(`fetching account sequence for ${address}`);
        return Promise.resolve(100n);
      },
    };
    const syncPool = new NoncePool('GABCDEF', mockHorizonClient);
    const txManager = new TransactionManager(rpcClient, syncPool);

    const record = await txManager.submitChargeUsage('worker-1', 'dev-001', 100n, 'contract-1');
    expect(calls).toBe(2);
    expect(record.status).toBe('submitted');
    syncPool.cleanup();
  });
});

describe('SorobanRpcClient', () => {
  it('should initialize with CLOSED circuit', () => {
    const client = new SorobanRpcClient('https://rpc.example.com');
    expect(client.getState()).toBe(CircuitState.CLOSED);
  });
});

describe('IngestionStateMachine', () => {
  it('should transition PENDING -> TENTATIVE -> SETTLED', () => {
    const sm = new IngestionStateMachine(IngestionState.PENDING);
    expect(sm.transition(IngestionState.TENTATIVE, 'starting processing')).toBe(true);
    expect(sm.getState()).toBe(IngestionState.TENTATIVE);
    expect(sm.transition(IngestionState.SETTLED, 'on-chain confirmed')).toBe(true);
    expect(sm.getState()).toBe(IngestionState.SETTLED);
  });

  it('should reject invalid transition', () => {
    const sm = new IngestionStateMachine(IngestionState.PENDING);
    expect(sm.transition(IngestionState.SETTLED, 'skip tentative')).toBe(false);
  });

  it('should allow rollback from tentative', () => {
    const sm = new IngestionStateMachine(IngestionState.TENTATIVE);
    expect(sm.transition(IngestionState.ROLLED_BACK, 'tx rejected')).toBe(true);
  });
});
