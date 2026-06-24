import { describe, it, expect } from 'vitest';
import {
  clampRefreshWindow,
  retentionSafeBoundary,
} from '../../src/database/aggregate_refresh_window.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-03-25T00:00:00.000Z');
const RETENTION_DAYS = 365;
const MARGIN_DAYS = 5;

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * DAY);
}

describe('retentionSafeBoundary', () => {
  it('is now - (retention - margin) days', () => {
    const boundary = retentionSafeBoundary(NOW, RETENTION_DAYS, MARGIN_DAYS);
    expect(boundary.getTime()).toBe(NOW.getTime() - (RETENTION_DAYS - MARGIN_DAYS) * DAY);
  });

  it('throws when the margin is not smaller than retention', () => {
    expect(() => retentionSafeBoundary(NOW, 5, 5)).toThrow(/must be less than/);
    expect(() => retentionSafeBoundary(NOW, 5, 10)).toThrow();
  });
});

describe('clampRefreshWindow', () => {
  it('leaves a fully-recent window unchanged', () => {
    const min = daysAgo(2);
    const max = daysAgo(0);
    const w = clampRefreshWindow(min, max, NOW, RETENTION_DAYS, MARGIN_DAYS);
    expect(w.skipped).toBe(false);
    expect(w.start).toBe(min);
    expect(w.end).toBe(max);
  });

  it('pulls the start forward to the boundary when the window straddles it', () => {
    // min is 364 days back (inside retention but past the 360-day safe boundary).
    const min = daysAgo(364);
    const max = daysAgo(0);
    const w = clampRefreshWindow(min, max, NOW, RETENTION_DAYS, MARGIN_DAYS);
    expect(w.skipped).toBe(false);
    const boundary = retentionSafeBoundary(NOW, RETENTION_DAYS, MARGIN_DAYS);
    expect(w.start.getTime()).toBe(boundary.getTime());
    expect(w.start.getTime()).toBeGreaterThan(min.getTime());
    expect(w.end).toBe(max);
  });

  it('never starts a refresh older than the retention-safe boundary (the invariant)', () => {
    const boundary = retentionSafeBoundary(NOW, RETENTION_DAYS, MARGIN_DAYS);
    for (const startDaysBack of [0, 10, 200, 359, 360, 361, 364]) {
      const w = clampRefreshWindow(
        daysAgo(startDaysBack),
        daysAgo(0),
        NOW,
        RETENTION_DAYS,
        MARGIN_DAYS,
      );
      if (!w.skipped) {
        expect(w.start.getTime()).toBeGreaterThanOrEqual(boundary.getTime());
      }
    }
  });

  it('skips a window lying entirely in the unsafe zone (would race a chunk drop)', () => {
    // Both ends older than the boundary -> nothing safe to refresh.
    const w = clampRefreshWindow(daysAgo(365), daysAgo(362), NOW, RETENTION_DAYS, MARGIN_DAYS);
    expect(w.skipped).toBe(true);
  });

  it('skips an empty/degenerate window', () => {
    const t = daysAgo(1);
    const w = clampRefreshWindow(t, t, NOW, RETENTION_DAYS, MARGIN_DAYS);
    expect(w.skipped).toBe(true);
  });
});
