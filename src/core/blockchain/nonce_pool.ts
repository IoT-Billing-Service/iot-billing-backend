import { setInterval, clearInterval } from 'node:timers';

interface NonceEntry {
  sequenceNumber: number;
  reserved: boolean;
  acquiredAt: number;
}

export interface HorizonClient {
  fetchAccountSequence(address: string): Promise<bigint>;
}

export class NoncePool {
  private nonces = new Map<string, NonceEntry>();
  private seqCounter = 0n;
  private queue: {
    resolve: (seq: number) => void;
    reject: (err: unknown) => void;
    workerId: string;
  }[] = [];
  private processing = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(
    private address?: string,
    private horizonClient?: HorizonClient,
  ) {
    if (this.address !== undefined && this.horizonClient !== undefined) {
      // Seed counter from on-ledger value on construction
      this.initPromise = this.synchronize().catch((err: unknown) => {
        globalThis.console.error('Failed to initialize sequence number from ledger:', err);
      });

      // Periodic reconciliation with 30s background interval
      this.intervalId = setInterval(() => {
        void this.synchronize().catch((err: unknown) => {
          globalThis.console.error('Failed to run periodic sync:', err);
        });
      }, 30_000);
    }
  }

  async acquire(workerId: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      this.queue.push({ resolve, reject, workerId });
      void this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      if (this.initPromise) {
        try {
          await this.initPromise;
        } catch {
          // Ignore initialization error and fallback to whatever sequence we have
        }
      }

      while (this.queue.length > 0) {
        const item = this.queue.shift();
        if (!item) continue;

        try {
          this.seqCounter += 1n;
          const seq = Number(this.seqCounter);
          this.nonces.set(item.workerId, {
            sequenceNumber: seq,
            reserved: true,
            acquiredAt: Date.now(),
          });
          item.resolve(seq);
        } catch (err) {
          item.reject(err);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  release(workerId: string): Promise<void> {
    this.nonces.delete(workerId);
    return Promise.resolve();
  }

  resetCounter(newSeq: number): Promise<void> {
    this.seqCounter = BigInt(newSeq);
    return Promise.resolve();
  }

  getCurrentSequence(): number {
    return Number(this.seqCounter);
  }

  getActiveCount(): number {
    return this.nonces.size;
  }

  async synchronize(): Promise<void> {
    if (this.address === undefined || this.horizonClient === undefined) return;
    try {
      const ledgerSeq = await this.horizonClient.fetchAccountSequence(this.address);
      const diff = this.seqCounter - ledgerSeq;
      // Drift tolerance: 1 sequence number before sync
      if (ledgerSeq > this.seqCounter || diff > 1n || diff < -1n) {
        this.seqCounter = ledgerSeq;
      }
    } catch (err) {
      globalThis.console.error('Failed to synchronize NoncePool with ledger:', err);
      throw err;
    }
  }

  cleanup(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

