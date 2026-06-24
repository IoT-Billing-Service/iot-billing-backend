import { describe, it, expect } from 'vitest';
import {
  checkAggregateFreshness,
  DEFAULT_AGGREGATE_MAX_STALENESS_MS,
} from '../../src/api/health.js';

const NOW = new Date('2026-03-25T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

describe('checkAggregateFreshness', () => {
  it('reports fresh when within the staleness threshold', () => {
    const lastRefresh = new Date(NOW.getTime() - 1 * HOUR);
    const res = checkAggregateFreshness(lastRefresh, NOW);
    expect(res.fresh).toBe(true);
    expect(res.ageMs).toBe(HOUR);
    expect(res.maxStalenessMs).toBe(DEFAULT_AGGREGATE_MAX_STALENESS_MS);
    expect(res.lastRefresh).toBe(lastRefresh.toISOString());
  });

  it('reports stale when past the threshold (default 2h)', () => {
    const res = checkAggregateFreshness(new Date(NOW.getTime() - 3 * HOUR), NOW);
    expect(res.fresh).toBe(false);
    expect(res.ageMs).toBe(3 * HOUR);
  });

  it('treats exactly the threshold as still fresh', () => {
    const res = checkAggregateFreshness(
      new Date(NOW.getTime() - DEFAULT_AGGREGATE_MAX_STALENESS_MS),
      NOW,
    );
    expect(res.fresh).toBe(true);
  });

  it('honors a custom staleness threshold', () => {
    const lastRefresh = new Date(NOW.getTime() - 30 * 60 * 1000); // 30 min
    expect(checkAggregateFreshness(lastRefresh, NOW, 15 * 60 * 1000).fresh).toBe(false);
    expect(checkAggregateFreshness(lastRefresh, NOW, 45 * 60 * 1000).fresh).toBe(true);
  });
});
