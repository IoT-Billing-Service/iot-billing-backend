import type { Redis } from 'ioredis';
import { getRedis } from '../../database/redis.js';
import { recordRedisPubsubMessagesLost } from '../../api/metrics/prometheus.js';
import { LedgerGapDetector, type LedgerGap } from '../ingestion/backpressure.js';

/**
 * Durable cross-process ledger event bus (issue #48).
 *
 * The previous design published ledger events over Redis pub/sub. During a
 * sentinel failover the SUBSCRIBE channels are torn down and re-established on
 * the new leader ~500ms later; every event published in that 1-3s window is
 * delivered to a leader with no subscribers and is lost (100% loss in-window,
 * up to ~60 events at peak). Buffer-depth backpressure cannot see this because
 * the messages never enter any buffer.
 *
 * Redis Streams fix the root cause: `XADD` persists each event in the stream
 * regardless of whether a consumer is currently connected, and a consumer group
 * records a per-consumer pending entries list. After a failover the consumer
 * reconnects and drains its pending list (and the backlog) with `XREADGROUP`,
 * so no event is missed. A sequence-gap detector provides defence-in-depth: if
 * an event is ever genuinely missing it is surfaced as a `LedgerGapDetected`
 * event and counted, rather than silently corrupting the billing ledger.
 */

export const LEDGER_STREAM_KEY = 'billing:events';
export const LEDGER_CONSUMER_GROUP = 'billing_consumers';

/** Approximate cap on retained stream entries (`XADD ... MAXLEN ~ N`). */
const STREAM_MAXLEN = 100_000;

/** Default `XREADGROUP ... BLOCK <ms>` window. */
const DEFAULT_BLOCK_MS = 2000;

export interface LedgerEvent {
  /**
   * Monotonic ledger event sequence number. The continuity invariant is
   * `current_seq === last_seq + 1`; any forward jump is a detected gap.
   */
  sequence: number;
  /** Opaque event payload (e.g. ledger hash, tx set). */
  payload: Record<string, string>;
}

/** A single delivered event together with its Redis stream entry id. */
export interface DeliveredEvent {
  id: string;
  event: LedgerEvent;
}

export interface ConsumeOptions {
  /** Max events to fetch per `XREADGROUP` call. Default 64. */
  count?: number;
  /** `BLOCK` window in ms for the live read. Default {@link DEFAULT_BLOCK_MS}. */
  blockMs?: number;
}

export interface LedgerEventBusOptions {
  streamKey?: string;
  groupName?: string;
  maxLen?: number;
  /**
   * Invoked when a sequence gap is detected at consume time. Wire this to a
   * re-index of the missing range (e.g. via the RPC client) to self-heal the
   * ledger. The bus has already incremented the loss counter before calling.
   */
  onGap?: (gap: LedgerGap) => void;
}

interface StreamEntry {
  id: string;
  fields: Record<string, string>;
}

/**
 * Reads back a consumer's own pending-but-unacked entries (`XREADGROUP ... 0`)
 * before draining new ones, so a reconnect after failover replays in-flight
 * work rather than skipping it.
 */
export class LedgerEventBus {
  private readonly redis: Redis;
  private readonly streamKey: string;
  private readonly groupName: string;
  private readonly maxLen: number;
  private readonly gapDetector = new LedgerGapDetector();
  private groupReady = false;

  constructor(redis?: Redis, options: LedgerEventBusOptions = {}) {
    this.redis = redis ?? getRedis();
    this.streamKey = options.streamKey ?? LEDGER_STREAM_KEY;
    this.groupName = options.groupName ?? LEDGER_CONSUMER_GROUP;
    this.maxLen = options.maxLen ?? STREAM_MAXLEN;
    this.gapDetector.on('LedgerGapDetected', (gap: LedgerGap) => {
      recordRedisPubsubMessagesLost(this.streamKey, gap.missingCount);
      if (options.onGap) {
        options.onGap(gap);
      }
    });
  }

  /** Idempotently create the consumer group (and the stream via `MKSTREAM`). */
  async ensureGroup(): Promise<void> {
    if (this.groupReady) return;
    try {
      await this.redis.xgroup('CREATE', this.streamKey, this.groupName, '$', 'MKSTREAM');
    } catch (err) {
      // BUSYGROUP => the group already exists, which is the desired state.
      if (!(err instanceof Error && err.message.includes('BUSYGROUP'))) {
        throw err;
      }
    }
    this.groupReady = true;
  }

  /**
   * Publish a ledger event. The entry is durably appended with an approximate
   * length cap; it survives even if no consumer is currently connected.
   *
   * @returns the generated stream entry id.
   */
  async publish(event: LedgerEvent): Promise<string> {
    const fields: string[] = ['seq', String(event.sequence)];
    for (const [k, v] of Object.entries(event.payload)) {
      fields.push(k, v);
    }
    const id = await this.redis.xadd(
      this.streamKey,
      'MAXLEN',
      '~',
      String(this.maxLen),
      '*',
      ...fields,
    );
    return id ?? '';
  }

  /**
   * Drain available events for a consumer: first its own pending entries (id
   * `0`, recovering anything in flight across a failover), then newly arrived
   * entries (id `>`, blocking briefly). Each returned event has already been
   * run through the gap detector. Callers should {@link ack} after durable
   * processing.
   */
  async consume(consumerName: string, options: ConsumeOptions = {}): Promise<DeliveredEvent[]> {
    await this.ensureGroup();
    const count = options.count ?? 64;
    const blockMs = options.blockMs ?? DEFAULT_BLOCK_MS;

    // Recover this consumer's in-flight (pending, unacked) entries first.
    const pending = await this.readGroup(consumerName, '0', count, null);
    if (pending.length > 0) {
      return this.toDelivered(pending);
    }

    // Otherwise block for new entries delivered to the group.
    const fresh = await this.readGroup(consumerName, '>', count, blockMs);
    return this.toDelivered(fresh);
  }

  /** Acknowledge processed entries so they leave the pending entries list. */
  async ack(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return this.redis.xack(this.streamKey, this.groupName, ...ids);
  }

  /** Number of unacked entries across the consumer group (`XPENDING` summary). */
  async pendingCount(): Promise<number> {
    await this.ensureGroup();
    const summary = await this.redis.xpending(this.streamKey, this.groupName);
    // XPENDING summary form: [count, minId, maxId, [[consumer, count], ...]]
    const total = summary[0];
    return typeof total === 'number' ? total : Number(total ?? 0);
  }

  /** Last sequence number observed by the gap detector, or null if none yet. */
  getLastSeq(): number | null {
    return this.gapDetector.getLastSeq();
  }

  /** Subscribe to detected sequence gaps. */
  onGap(listener: (gap: LedgerGap) => void): void {
    this.gapDetector.on('LedgerGapDetected', listener);
  }

  private async readGroup(
    consumerName: string,
    cursor: string,
    count: number,
    blockMs: number | null,
  ): Promise<StreamEntry[]> {
    const args: (string | number)[] = [
      'GROUP',
      this.groupName,
      consumerName,
      'COUNT',
      String(count),
    ];
    if (blockMs !== null) {
      args.push('BLOCK', String(blockMs));
    }
    args.push('STREAMS', this.streamKey, cursor);
    const xreadgroup = this.redis.xreadgroup.bind(this.redis) as (
      ...callArgs: (string | number)[]
    ) => Promise<unknown>;
    const raw = (await xreadgroup(...args)) as [string, [string, string[]][]][] | null;
    return parseStreamReply(raw, this.streamKey);
  }

  private toDelivered(entries: StreamEntry[]): DeliveredEvent[] {
    return entries.map((entry) => {
      const sequence = Number(entry.fields['seq']);
      if (Number.isFinite(sequence)) {
        this.gapDetector.record(sequence);
      }
      const payload = { ...entry.fields };
      delete payload['seq'];
      return { id: entry.id, event: { sequence, payload } };
    });
  }
}

/**
 * Parse the nested `XREADGROUP` reply into flat stream entries for our stream.
 * Reply shape: `[[streamKey, [[id, [f1, v1, f2, v2, ...]], ...]], ...]`.
 */
function parseStreamReply(
  raw: [string, [string, string[]][]][] | null,
  streamKey: string,
): StreamEntry[] {
  if (raw === null) return [];
  const out: StreamEntry[] = [];
  for (const [key, entries] of raw) {
    if (key !== streamKey) continue;
    for (const [id, flatFields] of entries) {
      const fields: Record<string, string> = {};
      for (let i = 0; i + 1 < flatFields.length; i += 2) {
        const key = flatFields[i];
        const value = flatFields[i + 1];
        if (key !== undefined && value !== undefined) {
          fields[key] = value;
        }
      }
      out.push({ id, fields });
    }
  }
  return out;
}
