import type { FastifyReply } from 'fastify';
import { EventEmitter } from 'node:events';
import {
  incrementSseEventsDropped,
  incrementSseEventsSent,
  setSseConnectionsActive,
  setSseQueueDepth,
} from '../../api/metrics/prometheus.js';

/**
 * Server-Sent Events connection manager with backpressure (issue #68).
 *
 * Each admin SSE client gets a per-connection bounded queue. When the TCP send
 * buffer is full (`res.write()` returns false), the connection pauses writing
 * until the `drain` event fires. If the queue grows beyond MAX_QUEUE_DEPTH,
 * the oldest queued event is dropped and counted.
 *
 * A keepalive comment is sent every HEARTBEAT_INTERVAL_MS to prevent proxies
 * and load-balancers from timing out the long-lived connection.
 */

/** Max buffered events per SSE connection before dropping the oldest. */
const MAX_QUEUE_DEPTH = 50;

/** Keepalive interval in ms (15s as specified in issue #68). */
const HEARTBEAT_INTERVAL_MS = 15_000;

/** SSE comment that keeps the connection alive without triggering client events. */
const KEEPALIVE_COMMENT = ':keepalive\n\n';

/**
 * A single SSE client connection.
 *
 * Maintains a bounded queue and writes events via the Fastify reply stream,
 * respecting backpressure signals from the underlying writable.
 */
export class SseConnection {
  readonly clientId: string;
  private reply: FastifyReply;
  private queue: string[] = [];
  private draining = false;
  private closed = false;
  private droppedCount = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(clientId: string, reply: FastifyReply) {
    this.clientId = clientId;
    this.reply = reply;

    // Listen for the drain event on the underlying Node.js writable stream to
    // resume writing queued events when backpressure clears.
    reply.raw.on('drain', () => {
      this.draining = false;
      this.flushQueue();
    });

    // Clean up on connection close.
    reply.raw.on('close', () => {
      this.close();
    });

    reply.raw.on('error', () => {
      this.close();
    });

    // Start keepalive heartbeat.
    this.heartbeatTimer = setInterval(() => {
      this.sendKeepalive();
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Enqueue an SSE-formatted event string.
   *
   * @returns true if the event was enqueued, false if it was dropped due to
   * full queue or closed connection.
   */
  enqueue(event: string): boolean {
    if (this.closed) {
      this.droppedCount++;
      incrementSseEventsDropped('connection_closed');
      return false;
    }

    if (this.queue.length >= MAX_QUEUE_DEPTH) {
      // Drop the oldest event to make room.
      this.queue.shift();
      this.droppedCount++;
      incrementSseEventsDropped('queue_full');
    }

    this.queue.push(event);
    setSseQueueDepth(this.clientId, this.queue.length);

    if (!this.draining) {
      this.flushQueue();
    }

    return true;
  }

  /** Number of events dropped for this connection (queue-full + closed drops). */
  getDroppedCount(): number {
    return this.droppedCount;
  }

  /** Current queue depth. */
  getQueueDepth(): number {
    return this.queue.length;
  }

  /** Whether the connection is closed. */
  isClosed(): boolean {
    return this.closed;
  }

  /**
   * Cleanly close the connection. Stops the heartbeat and ends the response
   * stream if it is still writable.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.queue.length = 0;
    setSseQueueDepth(this.clientId, 0);

    if (!this.reply.raw.writableEnded) {
      try {
        this.reply.raw.end();
      } catch {
        // Stream may already be ending; ignore.
      }
    }
  }

  /**
   * Send the keepalive SSE comment. If the comment is dropped (queue full),
   * it is silently ignored — keepalive loss is not an error.
   */
  private sendKeepalive(): void {
    if (this.closed) return;

    const wrote = this.reply.raw.write(KEEPALIVE_COMMENT);
    if (!wrote) {
      this.draining = true;
    }
  }

  /**
   * Flush queued events to the underlying writable stream.
   * Respects backpressure: stops writing when `write()` returns false.
   */
  private flushQueue(): void {
    if (this.closed) return;

    while (this.queue.length > 0 && !this.draining) {
      const event = this.queue.shift();
      // queue is non-empty in this loop, so shift() is always defined.
      if (event === undefined) break;
      const wrote = this.reply.raw.write(event);

      if (!wrote) {
        this.draining = true;
        // The event was already dequeued; re-queue at the front to avoid
        // losing events on backpressure. Don't count it as sent.
        this.queue.unshift(event);
        break;
      }

      incrementSseEventsSent();
    }

    setSseQueueDepth(this.clientId, this.queue.length);
  }
}

/**
 * Manages all active SSE client connections.
 *
 * Registered as a singleton per process so the admin SSE endpoint can
 * broadcast ledger events to every connected dashboard.
 */
export class SseManager extends EventEmitter {
  private connections = new Map<string, SseConnection>();
  private counter = 0;

  /**
   * Register a new SSE client connection.
   *
   * Call this from the route handler that establishes the SSE stream. The
   * reply must already have the appropriate SSE headers set.
   *
   * @returns the allocated client id.
   */
  addClient(reply: FastifyReply): string {
    const clientId = `sse-${(++this.counter).toString()}`;
    const conn = new SseConnection(clientId, reply);

    // SseConnection already registers its own close/error listeners for
    // per-connection cleanup (timer, queue). We only need to react to
    // stream close so the manager can evict the connection and update
    // metrics. The removeClient guard handles re-entrant calls from
    // SseConnection.close() → end() → 'close'.
    reply.raw.on('close', () => {
      this.removeClient(clientId);
    });

    this.connections.set(clientId, conn);
    setSseConnectionsActive(this.connections.size);
    this.emit('clientConnected', clientId);
    return clientId;
  }

  /**
   * Send an SSE-formatted event to a specific client by id.
   *
   * @returns true if the event was enqueued, false if the client is not
   * found or the event was dropped.
   */
  sendToClient(clientId: string, eventName: string, data: unknown): boolean {
    const conn = this.connections.get(clientId);
    if (conn === undefined) return false;
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    return conn.enqueue(`event: ${eventName}\ndata: ${payload}\n\n`);
  }

  /**
   * Remove a client connection by id.
   *
   * Deletes from the map BEFORE calling conn.close() so that any re-entrant
   * call (e.g. conn.close() → end() → 'close' → removeClient) is a no-op.
   */
  removeClient(clientId: string): void {
    const conn = this.connections.get(clientId);
    if (conn === undefined) return;

    // Delete first to guard against re-entry from conn.close() → 'close' event.
    this.connections.delete(clientId);
    conn.close();

    setSseConnectionsActive(this.connections.size);
    this.emit('clientDisconnected', clientId);
  }

  /**
   * Broadcast an SSE-formatted event to all connected clients.
   *
   * @param eventName - the SSE event type (e.g. "ledger", "sync_status").
   * @param data - JSON-serializable payload.
   * @returns the number of clients that received the event.
   */
  broadcast(eventName: string, data: unknown): number {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    const formatted = `event: ${eventName}\ndata: ${payload}\n\n`;

    let delivered = 0;
    for (const conn of this.connections.values()) {
      if (conn.enqueue(formatted)) {
        delivered++;
      }
    }
    return delivered;
  }

  /** Number of active SSE connections. */
  getConnectionCount(): number {
    return this.connections.size;
  }

  /** Close all connections and clear state. */
  shutdown(): void {
    for (const conn of this.connections.values()) {
      conn.close();
    }
    this.connections.clear();
    setSseConnectionsActive(0);
  }
}

/** Singleton SSE manager instance for the process. */
let sseManagerInstance: SseManager | null = null;

/**
 * Get (or create) the process-level SSE manager singleton.
 */
export function getSseManager(): SseManager {
  sseManagerInstance ??= new SseManager();
  return sseManagerInstance;
}
