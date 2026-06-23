import { EventEmitter } from 'node:events';

export enum BackpressureLevel {
  NORMAL = 0,
  WARNING = 1,
  CRITICAL = 2,
}

export interface BackpressureMetrics {
  taskQueueDepth: number;
  memoryUsageBytes: number;
  dbConnectionUtilization: number;
}

const MAX_QUEUE_DEPTH = 10_000;
const MAX_MEMORY_BYTES = 512 * 1024 * 1024;
const MAX_DB_UTILIZATION = 0.85;

export class BackpressureController extends EventEmitter {
  private level: BackpressureLevel = BackpressureLevel.NORMAL;
  private metrics: BackpressureMetrics = {
    taskQueueDepth: 0,
    memoryUsageBytes: 0,
    dbConnectionUtilization: 0,
  };

  evaluate(metrics: BackpressureMetrics): BackpressureLevel {
    this.metrics = metrics;

    if (
      metrics.taskQueueDepth > MAX_QUEUE_DEPTH ||
      metrics.memoryUsageBytes > MAX_MEMORY_BYTES ||
      metrics.dbConnectionUtilization > MAX_DB_UTILIZATION
    ) {
      this.level = BackpressureLevel.CRITICAL;
    } else if (
      metrics.taskQueueDepth > MAX_QUEUE_DEPTH * 0.7 ||
      metrics.memoryUsageBytes > MAX_MEMORY_BYTES * 0.7 ||
      metrics.dbConnectionUtilization > MAX_DB_UTILIZATION * 0.7
    ) {
      this.level = BackpressureLevel.WARNING;
    } else {
      this.level = BackpressureLevel.NORMAL;
    }

    this.emit('levelChanged', this.level);
    return this.level;
  }

  getLevel(): BackpressureLevel {
    return this.level;
  }

  shouldThrottle(): boolean {
    return this.level >= BackpressureLevel.WARNING;
  }

  shouldPause(): boolean {
    return this.level >= BackpressureLevel.CRITICAL;
  }
}

/**
 * Detail emitted with every `LedgerGapDetected` event (issue #48).
 *
 * The backpressure controller monitors buffer depth, but depth alone cannot
 * reveal a gap caused by lost ledger events during a Redis sentinel failover.
 * This detector tracks message continuity instead: it watches the monotonic
 * sequence numbers of consumed ledger events and flags any discontinuity in the
 * invariant `current_seq == last_seq + 1`.
 */
export interface LedgerGap {
  /** First sequence number that was expected but not observed. */
  expectedSeq: number;
  /** Sequence number actually observed, which is `> expectedSeq`. */
  observedSeq: number;
  /** Count of missing sequence numbers: `observedSeq - expectedSeq`. */
  missingCount: number;
}

/**
 * Tracks the continuity of consumed ledger event sequence numbers and emits a
 * `LedgerGapDetected` event whenever the contiguous-range invariant is broken.
 *
 * Out-of-order or duplicate deliveries (`seq <= lastSeq`) are ignored — they are
 * expected when a consumer group re-reads its pending entries list after a
 * reconnect and never represent loss. Only a forward jump signals a true gap.
 */
export class LedgerGapDetector extends EventEmitter {
  private lastSeq: number | null = null;

  /**
   * Record a consumed event's sequence number.
   *
   * @returns a {@link LedgerGap} when a discontinuity is detected, otherwise null.
   */
  record(seq: number): LedgerGap | null {
    const previous = this.lastSeq;
    if (previous === null) {
      this.lastSeq = seq;
      return null;
    }
    if (seq <= previous) {
      // Replay/duplicate from the pending entries list — not a gap.
      return null;
    }
    this.lastSeq = seq;
    if (seq === previous + 1) {
      return null;
    }
    const gap: LedgerGap = {
      expectedSeq: previous + 1,
      observedSeq: seq,
      missingCount: seq - (previous + 1),
    };
    this.emit('LedgerGapDetected', gap);
    return gap;
  }

  /** Most recent sequence number observed, or null if none yet. */
  getLastSeq(): number | null {
    return this.lastSeq;
  }

  /** Reset tracking, e.g. after a full re-index reconciles the ledger. */
  reset(): void {
    this.lastSeq = null;
  }
}
