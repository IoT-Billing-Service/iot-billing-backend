import type { z } from 'zod';

/**
 * A single Zod validation failure rendered as a flat, log-friendly record.
 *
 * Every field a structured logger needs is present and complete: the
 * fully-qualified {@link path}, the human-readable {@link message}, the Zod
 * issue {@link code}, and (when the issue carries it) the {@link received}
 * value. Nothing here is ever truncated.
 */
export interface ZodIssueRecord {
  path: string;
  message: string;
  code: string;
  received?: unknown;
}

/**
 * Join a Zod issue path into a stable, readable string, rendering numeric
 * (array index) segments in bracket notation: `["a", 2, "b"]` -> `"a[2].b"`.
 *
 * Bracket notation is both shorter and less ambiguous than dot-joining indices
 * (`a.2.b`), and the whole point is that the result is *never* truncated — the
 * truncation-at-256-chars behaviour described in issue #69 is exactly what hid
 * the failing field. An empty path (a root-level error) renders as `"(root)"`.
 */
export function compactPath(path: readonly (string | number)[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${String(segment)}]`;
    } else {
      out += out === '' ? segment : `.${segment}`;
    }
  }
  return out === '' ? '(root)' : out;
}

/**
 * Convert a {@link z.ZodError} into one structured {@link ZodIssueRecord} per
 * issue.
 *
 * Unlike `error.flatten()`, this preserves the issue `code`, the `received`
 * value, and the full compacted path for *every* failure — so no failing field
 * is collapsed away, and callers can emit each record as its own structured log
 * entry instead of stuffing everything into one truncated string.
 */
export function formatZodIssues(error: z.ZodError): ZodIssueRecord[] {
  return error.issues.map((issue) => {
    const record: ZodIssueRecord = {
      path: compactPath(issue.path),
      message: issue.message,
      code: issue.code,
    };
    // `received` only exists on some issue variants (e.g. invalid_type).
    if ('received' in issue) {
      record.received = (issue as { received?: unknown }).received;
    }
    return record;
  });
}
