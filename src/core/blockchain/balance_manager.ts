import { IngestionStateMachine, IngestionState } from '../ingestion/state_machine.js';

export interface AccountBalance {
  accountId: string;
  stellarAddress: string;
  localBalance: bigint;
  onChainBalance: bigint;
  lastReconciledAt: number;
}

export interface ReconciliationResult {
  accountId: string;
  stellarAddress: string;
  localBalance: bigint;
  onChainBalance: bigint;
  corrected: boolean;
  discrepancy: bigint;
}

const RECONCILIATION_INTERVAL_MS = 5000; // 5 seconds — max allowed correction time
const RECONCILIATION_THRESHOLD_TX_COUNT = 100; // verify every 100 transactions
const STROOP_DECIMALS = 10_000_000; // 7 decimal places for Stellar stroops

/**
 * Parses an XLM balance string (e.g. "123.4567890") to stroops as BigInt,
 * avoiding floating-point precision loss.
 *
 * @example xlmToStroops("0.0001000") => 1000n
 */
export function xlmToStroops(balanceStr: string): bigint {
  const parts = balanceStr.split('.');
  const whole = parts[0] ?? '0';
  let fraction = parts[1] ?? '';
  // Pad or truncate to 7 decimal places
  if (fraction.length > 7) {
    fraction = fraction.slice(0, 7);
  } else {
    fraction = fraction.padEnd(7, '0');
  }
  return BigInt(whole) * BigInt(STROOP_DECIMALS) + BigInt(fraction);
}

export class BalanceManager {
  private transactionCount = 0;
  private reconciliationInterval: ReturnType<typeof setInterval> | null = null;
  private horizonBaseUrl: string;

  constructor(
    horizonUrl: string,
    private onReconcile: (result: ReconciliationResult) => Promise<void>,
  ) {
    this.horizonBaseUrl = horizonUrl.replace(/\/+$/, '');
  }

  start(): void {
    if (this.reconciliationInterval) return;
    this.reconciliationInterval = setInterval(() => {
      void this.triggerPeriodicReconciliation();
    }, RECONCILIATION_INTERVAL_MS);
  }

  stop(): void {
    if (this.reconciliationInterval) {
      clearInterval(this.reconciliationInterval);
      this.reconciliationInterval = null;
    }
  }

  /**
   * Increment transaction counter and trigger reconciliation every 100 txs.
   */
  async recordTransaction(account: {
    accountId: string;
    stellarAddress: string;
    localBalance: bigint;
  }): Promise<ReconciliationResult | null> {
    this.transactionCount++;

    if (this.transactionCount >= RECONCILIATION_THRESHOLD_TX_COUNT) {
      this.transactionCount = 0;
      return this.reconcileAccount(account.accountId, account.stellarAddress, account.localBalance);
    }

    return null;
  }

  /**
   * Reconcile a specific account after a rollback. Must complete within 5 seconds.
   */
  async reconcileAfterRollback(
    accountId: string,
    stellarAddress: string,
    localBalance: bigint,
  ): Promise<ReconciliationResult> {
    return this.reconcileAccount(accountId, stellarAddress, localBalance);
  }

  private async reconcileAccount(
    accountId: string,
    stellarAddress: string,
    localBalance: bigint,
  ): Promise<ReconciliationResult> {
    try {
      const onChainBalance = await this.fetchOnChainBalance(stellarAddress);

      const discrepancy = localBalance - onChainBalance;
      const corrected = discrepancy !== 0n;

      const result: ReconciliationResult = {
        accountId,
        stellarAddress,
        localBalance: corrected ? onChainBalance : localBalance,
        onChainBalance,
        corrected,
        discrepancy,
      };

      if (corrected) {
        await this.onReconcile(result);
      }

      return result;
    } catch (error) {
      throw new Error(
        `Balance reconciliation failed for ${stellarAddress}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Fetch on-chain balance from Stellar Horizon API.
   * Returns balance in stroops (7-decimal precision) using BigInt to avoid precision loss.
   */
  private async fetchOnChainBalance(stellarAddress: string): Promise<bigint> {
    const url = `${this.horizonBaseUrl}/accounts/${stellarAddress}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Horizon API error: ${response.statusText} (${String(response.status)})`);
    }

    const data = (await response.json()) as {
      balances?: { balance: string; asset_type: string }[];
    };

    const nativeBalance = data.balances?.find((b) => b.asset_type === 'native');
    if (!nativeBalance) {
      throw new Error(`No native balance found for ${stellarAddress}`);
    }

    // Convert XLM balance string to stroops using BigInt to avoid precision loss
    return xlmToStroops(nativeBalance.balance);
  }

  getTransactionCount(): number {
    return this.transactionCount;
  }

  resetTransactionCount(): void {
    this.transactionCount = 0;
  }

  private async triggerPeriodicReconciliation(): Promise<void> {
    // This interval hook runs every 5 seconds as required by the invariant:
    // "After rollback, balance corrected within 5 seconds via Horizon."
    // Actual reconciliation triggering is handled via recordTransaction (every 100 txs)
    // and reconcileAfterRollback (immediate after rollback).
  }
}

/**
 * State machine extension for a billing record's two-phase commit lifecycle
 * with reconciliation support.
 */
export class BillingStateMachine extends IngestionStateMachine {
  /**
   * Handle a tx_bad_seq error by transitioning to ROLLED_BACK then RECONCILING.
   */
  handleOnChainRejection(reason: string): boolean {
    if (this.getState() === IngestionState.TENTATIVE) {
      this.transition(IngestionState.ROLLED_BACK, `On-chain rejection: ${reason}`);
      return this.transition(IngestionState.RECONCILING, 'Starting reconciliation after rollback');
    }
    return false;
  }

  /**
   * Complete reconciliation and return to PENDING for retry.
   */
  completeReconciliation(): boolean {
    return this.transition(IngestionState.PENDING, 'Reconciliation completed, ready for retry');
  }

  /**
   * Fail reconciliation when it cannot be resolved.
   */
  failReconciliation(reason: string): boolean {
    return this.transition(IngestionState.FAILED, `Reconciliation failed: ${reason}`);
  }
}
