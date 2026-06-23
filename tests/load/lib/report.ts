/**
 * Load-test regression report (issue #66, blueprint item 5).
 *
 * Compares a run's metrics against a committed baseline
 * (`tests/load/baseline.json`) and fails CI if any tracked metric regresses
 * by more than a threshold (default 20%). "Regression" is direction-aware:
 * for latency/error metrics, higher is worse; for throughput/accepted,
 * lower is worse.
 *
 * CLI:
 *   tsx tests/load/lib/report.ts <results.json> [baseline.json] [--max-regression 0.2]
 *
 * The results file is the shape cli_smoke.ts writes: `{ metrics: LoadMetrics, ... }`.
 * Exit code is non-zero when a regression breaches the threshold.
 */

export interface BaselineMetrics {
  throughputPerSec: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  errorRate: number;
  accepted: number;
}

/** A metric whose value increasing (`higher-worse`) or decreasing (`lower-worse`) is a regression. */
type Direction = 'higher-worse' | 'lower-worse';

const METRICS: { key: keyof BaselineMetrics; label: string; direction: Direction }[] = [
  { key: 'throughputPerSec', label: 'throughput/sec', direction: 'lower-worse' },
  { key: 'accepted', label: 'accepted', direction: 'lower-worse' },
  { key: 'p95LatencyMs', label: 'P95 latency (ms)', direction: 'higher-worse' },
  { key: 'p99LatencyMs', label: 'P99 latency (ms)', direction: 'higher-worse' },
  { key: 'errorRate', label: 'error rate', direction: 'higher-worse' },
];

export interface MetricComparison {
  key: keyof BaselineMetrics;
  label: string;
  baseline: number;
  current: number;
  /** Signed fractional change in the *worse* direction (positive == regressed). */
  regressionPct: number;
  regressed: boolean;
}

export interface ReportResult {
  comparisons: MetricComparison[];
  regressions: MetricComparison[];
  maxRegressionPct: number;
  passed: boolean;
}

/**
 * Compute the regression fraction for one metric. Positive means "worse than
 * baseline" in the metric's bad direction; negative means an improvement.
 *
 * Baseline of 0 is handled so we never divide by zero: any positive current
 * value against a 0 baseline for a higher-worse metric is treated as a full
 * (1.0) regression; a lower-worse metric going from 0 can only improve.
 */
function regressionFraction(baseline: number, current: number, direction: Direction): number {
  const delta = direction === 'higher-worse' ? current - baseline : baseline - current;
  if (baseline === 0) {
    return delta > 0 ? 1 : 0;
  }
  return delta / Math.abs(baseline);
}

export function compareToBaseline(
  current: BaselineMetrics,
  baseline: BaselineMetrics,
  maxRegressionPct = 0.2,
): ReportResult {
  const comparisons: MetricComparison[] = METRICS.map(({ key, label, direction }) => {
    const regressionPct = regressionFraction(baseline[key], current[key], direction);
    return {
      key,
      label,
      baseline: baseline[key],
      current: current[key],
      regressionPct,
      regressed: regressionPct > maxRegressionPct,
    };
  });
  const regressions = comparisons.filter((c) => c.regressed);
  return {
    comparisons,
    regressions,
    maxRegressionPct,
    passed: regressions.length === 0,
  };
}

/** Pull the {@link BaselineMetrics} subset out of a full LoadMetrics object. */
export function extractBaselineMetrics(metrics: {
  throughputPerSec: number;
  errorRate: number;
  accepted: number;
  latency: { p95Ms: number; p99Ms: number };
}): BaselineMetrics {
  return {
    throughputPerSec: metrics.throughputPerSec,
    p95LatencyMs: metrics.latency.p95Ms,
    p99LatencyMs: metrics.latency.p99Ms,
    errorRate: metrics.errorRate,
    accepted: metrics.accepted,
  };
}

/** Render a human-readable Markdown report. */
export function renderReport(result: ReportResult): string {
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const lines: string[] = [
    `### Load-test regression report`,
    ``,
    `Threshold: regression must stay within **${pct(result.maxRegressionPct)}**.`,
    ``,
    `| Metric | Baseline | Current | Change (worse-direction) | Status |`,
    `| --- | ---: | ---: | ---: | :---: |`,
  ];
  for (const c of result.comparisons) {
    const arrow = c.regressionPct > 0 ? '▲' : c.regressionPct < 0 ? '▼' : '–';
    lines.push(
      `| ${c.label} | ${c.baseline.toFixed(3)} | ${c.current.toFixed(3)} | ` +
        `${arrow} ${pct(c.regressionPct)} | ${c.regressed ? '❌ regressed' : '✅'} |`,
    );
  }
  lines.push('');
  lines.push(
    result.passed
      ? `**PASS** — no metric regressed beyond threshold.`
      : `**FAIL** — ${String(result.regressions.length)} metric(s) regressed.`,
  );
  return lines.join('\n');
}

async function main(): Promise<void> {
  const { fileURLToPath } = await import('node:url');
  const argv = process.argv.slice(2);

  const maxIdx = argv.indexOf('--max-regression');
  const maxRegressionPct = maxIdx >= 0 ? Number.parseFloat(argv[maxIdx + 1] ?? '0.2') : 0.2;

  // Positional args, excluding any `--flag` and the value that follows it.
  const positional = argv.filter((arg, i) => {
    if (arg.startsWith('--')) return false;
    if (i > 0 && (argv[i - 1] ?? '').startsWith('--')) return false;
    return true;
  });
  const resultsPath = positional[0] ?? `${process.cwd()}/load-test-results.json`;
  const baselinePath = positional[1] ?? fileURLToPath(new URL('../baseline.json', import.meta.url));

  const fs = await import('node:fs');
  const resultsRaw = JSON.parse(await fs.promises.readFile(resultsPath, 'utf-8')) as {
    metrics: Parameters<typeof extractBaselineMetrics>[0];
  };
  const baseline = JSON.parse(await fs.promises.readFile(baselinePath, 'utf-8')) as BaselineMetrics;

  const current = extractBaselineMetrics(resultsRaw.metrics);
  const report = compareToBaseline(current, baseline, maxRegressionPct);

  console.log(renderReport(report));

  if (!report.passed) {
    console.error(
      `[report] FAIL: ${String(report.regressions.length)} metric(s) regressed beyond ` +
        `${(maxRegressionPct * 100).toFixed(0)}%: ${report.regressions.map((r) => r.label).join(', ')}`,
    );
    process.exit(1);
  }
  console.log('[report] OK: no regressions beyond threshold.');
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('report.ts')) {
  main().catch((err: unknown) => {
    console.error('[report] failed:', err);
    process.exit(1);
  });
}
