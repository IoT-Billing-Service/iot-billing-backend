import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseTrace, replayTrace } from '../../load/lib/replay_trace.js';
import { buildMockServer, type StartedMockServer } from '../../load/mock_server.js';

describe('parseTrace', () => {
  it('parses rows and computes offsets relative to the first event', () => {
    const events = parseTrace('1000,dev-a\n1005,dev-b\n1020,dev-a\n');
    expect(events).toHaveLength(3);
    expect(events[0]?.offsetMs).toBe(0);
    expect(events[1]?.offsetMs).toBe(5);
    expect(events[2]?.offsetMs).toBe(20);
    expect(events[0]?.deviceId).toBe('dev-a');
  });

  it('detects and skips a header row', () => {
    const events = parseTrace('timestampMs,deviceId\n2000,dev-x\n2010,dev-y\n');
    expect(events).toHaveLength(2);
    expect(events[0]?.offsetMs).toBe(0);
    expect(events[1]?.offsetMs).toBe(10);
  });

  it('synthesizes a deviceId when the column is absent', () => {
    const events = parseTrace('500\n510\n');
    expect(events[0]?.deviceId).toMatch(/^trace-device-/);
  });

  it('sorts out-of-order rows by offset', () => {
    const events = parseTrace('100\n50\n200\n');
    expect(events.map((e) => e.offsetMs)).toEqual([0, 50, 150]);
  });

  it('ignores blank lines and returns empty for empty input', () => {
    expect(parseTrace('\n\n')).toEqual([]);
    expect(parseTrace('')).toEqual([]);
  });

  it('throws on a non-numeric timestamp in a data row', () => {
    expect(() => parseTrace('1000,dev-a\nNOPE,dev-b')).toThrow(/non-numeric timestamp/);
  });
});

describe('replayTrace (against mock gateway)', () => {
  let server: StartedMockServer;

  beforeAll(async () => {
    server = await buildMockServer({
      port: 0,
      host: '127.0.0.1',
      latencyMs: 1,
      latencyJitter: 0.1,
    });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('replays a small trace, accepts events, and reports the invariants', async () => {
    const trace = parseTrace('0,dev-1\n5,dev-2\n10,dev-3\n15,dev-1\n');
    // timeScale 0 fires immediately so the test does not wait out real timing.
    const result = await replayTrace({ targetUrl: server.url, trace, timeScale: 0 });

    expect(result.totalEvents).toBe(4);
    expect(result.accepted).toBeGreaterThan(0);
    expect(result.dropped).toBe(0);
    expect(result.zeroDropped).toBe(true);
    // Generous ceiling: this asserts the invariant plumbing, not staging perf.
    expect(typeof result.p99Met).toBe('boolean');
    expect(result.accepted + result.rejected + result.dropped).toBe(result.totalEvents);
  }, 30_000);
});
