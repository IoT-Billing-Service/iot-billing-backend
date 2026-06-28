import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Writable } from 'node:stream';
import {
  SseConnection,
  getSseManager,
} from '../../src/core/ingestion/sse_manager.js';
import type { FastifyReply } from 'fastify';

interface MockRaw extends Writable {
  setWriteResult: (v: boolean) => void;
}

interface MockReply { raw: MockRaw; header: ReturnType<typeof vi.fn>; hijack: ReturnType<typeof vi.fn> }

function mockFastifyReply(): { reply: MockReply; raw: MockRaw } {
  let writeShouldReturnTrue = true;
  const raw = new Writable({
    write(_chunk, _encoding, callback): void {
      callback();
    },
  }) as unknown as MockRaw;

  // By default, write() returns true (no backpressure).
  const origWrite = raw.write.bind(raw);
  raw.write = function (chunk, encoding, cb) {
    const result = origWrite(chunk, encoding, cb);
    return writeShouldReturnTrue ? result : false;
  } as typeof raw.write;

  raw.setWriteResult = (v: boolean): void => {
    writeShouldReturnTrue = v;
  };

  const reply = {
    raw,
    header: vi.fn(),
    hijack: vi.fn(),
  };

  return {
    reply: reply,
    raw,
  };
}

describe('SseConnection', () => {
  it('should enqueue and write events', () => {
    const { reply } = mockFastifyReply();
    const conn = new SseConnection('test-1', reply as unknown as FastifyReply);

    const writeSpy = vi.spyOn(reply.raw, 'write');
    const accepted = conn.enqueue('event: test\ndata: hello\n\n');
    
    expect(accepted).toBe(true);
    expect(writeSpy).toHaveBeenCalled();
    expect(conn.getQueueDepth()).toBe(0);
    expect(conn.getDroppedCount()).toBe(0);
    conn.close();
  });

  it('should drop events when queue is full (MAX_QUEUE_DEPTH = 50)', () => {
    const { reply } = mockFastifyReply();
    // Simulate backpressure so events queue up
    reply.raw.setWriteResult(false);
    const conn = new SseConnection('test-2', reply as unknown as FastifyReply);

    // Fill the queue
    for (let i = 0; i < 50; i++) {
      const accepted = conn.enqueue(`event: test\ndata: ${String(i)}\n\n`);
      expect(accepted).toBe(true);
    }

    expect(conn.getQueueDepth()).toBe(50);

    // The 51st event should cause the oldest to be dropped
    const accepted = conn.enqueue('event: test\ndata: overflow\n\n');
    expect(accepted).toBe(true);
    expect(conn.getDroppedCount()).toBe(1);
    expect(conn.getQueueDepth()).toBe(50);

    conn.close();
  });

  it('should drop events when connection is closed', () => {
    const { reply } = mockFastifyReply();
    const conn = new SseConnection('test-3', reply as unknown as FastifyReply);
    conn.close();

    expect(conn.isClosed()).toBe(true);

    const accepted = conn.enqueue('event: test\ndata: after_close\n\n');
    expect(accepted).toBe(false);
    expect(conn.getDroppedCount()).toBe(1);
    expect(conn.getQueueDepth()).toBe(0);
  });

  it('should resume writing after drain event', () => new Promise<void>((done) => {
    const { reply } = mockFastifyReply();
    reply.raw.setWriteResult(false);
    const conn = new SseConnection('test-4', reply as unknown as FastifyReply);

    // Enqueue while backpressured
    conn.enqueue('event: test\ndata: first\n\n');
    expect(conn.getQueueDepth()).toBe(1);

    // Now clear backpressure
    reply.raw.setWriteResult(true);
    reply.raw.emit('drain');

    // Allow microtask flush
    setImmediate(() => {
      expect(conn.getQueueDepth()).toBe(0);
      conn.close();
      done();
    });
  }));

  it('should stop heartbeat on close', () => {
    const { reply } = mockFastifyReply();
    const conn = new SseConnection('test-5', reply as unknown as FastifyReply);

    expect(conn.isClosed()).toBe(false);
    // Heartbeat timer should be active
    conn.close();
    expect(conn.isClosed()).toBe(true);
  });
});

describe('SseManager', () => {
  beforeEach(() => {
    // Reset singleton between tests.
    const sse = getSseManager();
    sse.shutdown();
  });

  it('should add and remove clients', () => {
    const sse = getSseManager();
    const { reply } = mockFastifyReply();

    const clientId = sse.addClient(reply as unknown as FastifyReply);
    expect(sse.getConnectionCount()).toBe(1);
    expect(clientId).toMatch(/^sse-/);

    sse.removeClient(clientId);
    expect(sse.getConnectionCount()).toBe(0);
  });

  it('should broadcast events to all clients', () => {
    const sse = getSseManager();
    const { reply: r1 } = mockFastifyReply();
    const { reply: r2 } = mockFastifyReply();

    sse.addClient(r1 as unknown as FastifyReply);
    sse.addClient(r2 as unknown as FastifyReply);

    const writeSpy1 = vi.spyOn(r1.raw, 'write');
    const writeSpy2 = vi.spyOn(r2.raw, 'write');

    const delivered = sse.broadcast('ledger', { sequence: 42 });
    expect(delivered).toBe(2);
    expect(writeSpy1).toHaveBeenCalled();
    expect(writeSpy2).toHaveBeenCalled();

    sse.shutdown();
  });

  it('should send event to specific client', () => {
    const sse = getSseManager();
    const { reply: r1 } = mockFastifyReply();
    const { reply: r2 } = mockFastifyReply();

    const id1 = sse.addClient(r1 as unknown as FastifyReply);
    sse.addClient(r2 as unknown as FastifyReply);

    const writeSpy1 = vi.spyOn(r1.raw, 'write');
    const writeSpy2 = vi.spyOn(r2.raw, 'write');

    const sent = sse.sendToClient(id1, 'private', { msg: 'hello' });
    expect(sent).toBe(true);
    expect(writeSpy1).toHaveBeenCalled();
    // Second client should NOT receive the private event
    const callsForPrivate = writeSpy2.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0]).includes('private'),
    );
    expect(callsForPrivate.length).toBe(0);

    sse.shutdown();
  });

  it('should return false for sendToClient on unknown id', () => {
    const sse = getSseManager();
    const sent = sse.sendToClient('nonexistent', 'event', {});
    expect(sent).toBe(false);
  });

  it('should emit clientConnected and clientDisconnected events', () => {
    const sse = getSseManager();
    const { reply } = mockFastifyReply();

    const connectHandler = vi.fn();
    const disconnectHandler = vi.fn();

    sse.on('clientConnected', connectHandler);
    sse.on('clientDisconnected', disconnectHandler);

    const clientId = sse.addClient(reply as unknown as FastifyReply);
    expect(connectHandler).toHaveBeenCalledWith(clientId);

    sse.removeClient(clientId);
    expect(disconnectHandler).toHaveBeenCalledWith(clientId);

    sse.removeAllListeners();
  });

  it('should shut down all connections', () => {
    const sse = getSseManager();
    const { reply: r1 } = mockFastifyReply();
    const { reply: r2 } = mockFastifyReply();

    sse.addClient(r1 as unknown as FastifyReply);
    sse.addClient(r2 as unknown as FastifyReply);
    expect(sse.getConnectionCount()).toBe(2);

    sse.shutdown();
    expect(sse.getConnectionCount()).toBe(0);
  });
});
