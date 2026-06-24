/**
 * Refresh-window safety clamping for continuous aggregates (issue #51).
 *
 * `refreshAggregatesAdaptively()` calls `refresh_continuous_aggregate(view,
 * start, end)` with a window derived from the data's MIN/MAX time. If that
 * window reaches older than the hypertable's retention boundary, the refresh
 * can race a retention chunk-drop and fail (or silently re-materialize buckets
 * whose raw data has been dropped), invalidating the aggregate.
 *
 * The invariant we enforce: a refresh window never starts older than
 * `now - (retentionDays - marginDays)`. Anything in the margin band next to the
 * retention boundary is left to the aggregate's own background policy, which is
 * coordinated with retention by TimescaleDB. This module is pure (no DB) so the
 * boundary maths is unit-testable without a live TimescaleDB.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ClampedWindow {
  start: Date;
  end: Date;
  /** True when the whole [min, max] window lies in the unsafe zone (skip refresh). */
  skipped: boolean;
}

/**
 * The oldest instant a refresh is allowed to touch: `now - (retentionDays -
 * marginDays)` days. Throws if the effective safe window is non-positive
 * (misconfiguration: margin >= retention).
 */
export function retentionSafeBoundary(now: Date, retentionDays: number, marginDays: number): Date {
  const safeDays = retentionDays - marginDays;
  if (safeDays <= 0) {
    throw new Error(
      `RETENTION_SAFETY_MARGIN_DAYS (${String(marginDays)}) must be less than ` +
        `TELEMETRY_RETENTION_DAYS (${String(retentionDays)})`,
    );
  }
  return new Date(now.getTime() - safeDays * MS_PER_DAY);
}

/**
 * Clamp a desired [min, max] refresh window to the retention-safe region.
 *
 * - Window entirely newer than the boundary -> returned unchanged.
 * - Window straddling the boundary -> start is pulled forward to the boundary.
 * - Window entirely older than the boundary, or empty (min >= max) -> skipped.
 */
export function clampRefreshWindow(
  min: Date,
  max: Date,
  now: Date,
  retentionDays: number,
  marginDays: number,
): ClampedWindow {
  const boundary = retentionSafeBoundary(now, retentionDays, marginDays);
  const start = min.getTime() < boundary.getTime() ? boundary : min;

  // Nothing left to refresh once the safe start meets/passes the window end.
  if (start.getTime() >= max.getTime()) {
    return { start, end: max, skipped: true };
  }
  return { start, end: max, skipped: false };
}
