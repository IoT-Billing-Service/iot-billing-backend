import { Buffer } from 'node:buffer';
import type { Span } from '@opentelemetry/api';
import { getDiagnosticsTracer } from '../diagnostics/tracer.js';
import { DOMAIN_TELEMETRY, TELEMETRY_DOMAIN_ATTR } from '../diagnostics/sampler.js';
import { compactPath, formatZodIssues, type ZodIssueRecord } from '../utils/zod_path.js';
import { TelemetryBatchSchema, type TelemetryBatch } from './telemetry_schema.js';

/**
 * Telemetry-batch validation backed by {@link TelemetryBatchSchema}.
 *
 * This module is the fix for issue #69: a deeply nested validation failure must
 * be logged with a *complete* path so the failing field can be identified
 * without a repro-and-add-logging round trip. To that end it never truncates a
 * path — instead it:
 *
 *   1. emits one structured log record per {@link ZodIssueRecord};
 *   2. records the full set of failing paths on the active OpenTelemetry span;
 *   3. rate-limits a verbose full-dump so high failure volume cannot flood logs.
 */

/** Result of validating an unknown payload against the telemetry schema. */
export type TelemetryValidationResult =
  | { valid: true; data: TelemetryBatch }
  | { valid: false; issues: ZodIssueRecord[] };

/** OpenTelemetry attribute byte budget per attribute value (see issue #69). */
const SPAN_ATTRIBUTE_MAX_BYTES = 4096;

/** Window for the verbose full-error log (blueprint item 4). */
const FULL_LOG_WINDOW_MS = 60_000;

// -Infinity so the first failure always emits a full dump, independent of the
// wall clock (a literal 0 would collide with a clock pinned to the epoch).
let lastFullLogAt = -Infinity;

/** Reset the rate-limit window. Intended for tests. */
export function resetValidationLogState(): void {
  lastFullLogAt = -Infinity;
}

/**
 * Format a {@link import('zod').ZodError} into complete, structured records.
 * Re-exported shape from {@link formatZodIssues} so callers can format without
 * also running validation.
 */
export function formatValidationError(
  error: Parameters<typeof formatZodIssues>[0],
): ZodIssueRecord[] {
  return formatZodIssues(error);
}

/**
 * Attach the failing paths to the span. OTel caps each attribute value at
 * {@link SPAN_ATTRIBUTE_MAX_BYTES}; rather than let OTel silently chop the JSON
 * mid-path (re-introducing the issue #69 bug at the span layer), we drop whole
 * paths from the tail and flag that we did so. The complete, untruncated set is
 * always available in the structured logs.
 */
function recordErrorPathsOnSpan(span: Span, paths: string[]): void {
  span.setAttribute('validation.error.count', paths.length);

  const full = JSON.stringify(paths);
  if (Buffer.byteLength(full, 'utf-8') <= SPAN_ATTRIBUTE_MAX_BYTES) {
    span.setAttribute('validation.error.paths', full);
    return;
  }

  const included: string[] = [];
  for (const path of paths) {
    if (
      Buffer.byteLength(JSON.stringify([...included, path]), 'utf-8') > SPAN_ATTRIBUTE_MAX_BYTES
    ) {
      break;
    }
    included.push(path);
  }
  span.setAttribute('validation.error.paths', JSON.stringify(included));
  span.setAttribute('validation.error.paths.truncated', true);
}

/** Emit one structured (single-line JSON) log record per failing field. */
function logIssues(issues: ZodIssueRecord[]): void {
  for (const issue of issues) {
    console.warn(
      JSON.stringify({
        event: 'telemetry.validation.issue',
        path: issue.path,
        message: issue.message,
        code: issue.code,
        received: issue.received,
      }),
    );
  }

  // Verbose dump: full path list once per window, an abbreviated summary
  // otherwise. Keeps a complete record available without flooding logs.
  const now = Date.now();
  if (now - lastFullLogAt >= FULL_LOG_WINDOW_MS) {
    lastFullLogAt = now;
    console.debug(
      JSON.stringify({
        event: 'telemetry.validation.failed',
        mode: 'full',
        count: issues.length,
        paths: issues.map((i) => i.path),
      }),
    );
  } else {
    console.debug(
      JSON.stringify({
        event: 'telemetry.validation.failed',
        mode: 'abbreviated',
        count: issues.length,
        firstPath: issues[0]?.path,
      }),
    );
  }
}

/**
 * Validate an unknown payload against {@link TelemetryBatchSchema}.
 *
 * On success returns the parsed, typed batch. On failure returns the complete
 * set of structured issues *and* logs them / records them on the span as a side
 * effect, so the caller can reject the batch while diagnostics retain the full
 * detail.
 */
export function validateTelemetryBatch(payload: unknown): TelemetryValidationResult {
  const tracer = getDiagnosticsTracer();

  return tracer.traceSync(
    'ingestion.validateTelemetryBatch',
    (span): TelemetryValidationResult => {
      const parsed = TelemetryBatchSchema.safeParse(payload);
      if (parsed.success) {
        span.setAttribute('validation.result', 'valid');
        return { valid: true, data: parsed.data };
      }

      const issues = formatZodIssues(parsed.error);
      span.setAttribute('validation.result', 'invalid');
      recordErrorPathsOnSpan(
        span,
        issues.map((i) => i.path),
      );
      logIssues(issues);

      return { valid: false, issues };
    },
    { [TELEMETRY_DOMAIN_ATTR]: DOMAIN_TELEMETRY },
  );
}

/** Re-exported so callers needing only the path helper don't reach into utils. */
export { compactPath };
