import { describe, it, expect } from 'vitest';
import {
  compareToBaseline,
  extractBaselineMetrics,
  renderReport,
  type BaselineMetrics,
} from '../../load/lib/report.js';

const baseline: BaselineMetrics = {
  throughputPerSec: 100,
  p95LatencyMs: 50,
  p99LatencyMs: 150,
  errorRate: 0.05,
  accepted: 1000,
};

describe('compareToBaseline', () => {
  it('passes when metrics match the baseline exactly', () => {
    const result = compareToBaseline({ ...baseline }, baseline);
    expect(result.passed).toBe(true);
    expect(result.regressions).toHaveLength(0);
  });

  it('flags a latency regression beyond 20% (higher is worse)', () => {
    const result = compareToBaseline({ ...baseline, p99LatencyMs: 190 }, baseline); // +26.7%
    expect(result.passed).toBe(false);
    expect(result.regressions.map((r) => r.key)).toContain('p99LatencyMs');
  });

  it('does not flag a latency increase within 20%', () => {
    const result = compareToBaseline({ ...baseline, p99LatencyMs: 175 }, baseline); // +16.7%
    expect(result.passed).toBe(true);
  });

  it('flags a throughput regression beyond 20% (lower is worse)', () => {
    const result = compareToBaseline({ ...baseline, throughputPerSec: 70 }, baseline); // -30%
    expect(result.passed).toBe(false);
    expect(result.regressions.map((r) => r.key)).toContain('throughputPerSec');
  });

  it('treats improvements as non-regressions (negative regressionPct)', () => {
    const result = compareToBaseline(
      { ...baseline, throughputPerSec: 200, p99LatencyMs: 50, errorRate: 0 },
      baseline,
    );
    expect(result.passed).toBe(true);
    const throughput = result.comparisons.find((c) => c.key === 'throughputPerSec');
    expect(throughput?.regressionPct).toBeLessThan(0);
  });

  it('handles a zero baseline for an error rate without dividing by zero', () => {
    const zeroErr: BaselineMetrics = { ...baseline, errorRate: 0 };
    const result = compareToBaseline({ ...baseline, errorRate: 0.1 }, zeroErr);
    expect(result.passed).toBe(false);
    expect(result.regressions.map((r) => r.key)).toContain('errorRate');
  });

  it('respects a custom threshold', () => {
    const result = compareToBaseline({ ...baseline, p99LatencyMs: 165 }, baseline, 0.05); // +10% > 5%
    expect(result.passed).toBe(false);
  });
});

describe('extractBaselineMetrics', () => {
  it('pulls the tracked subset out of a full LoadMetrics object', () => {
    const extracted = extractBaselineMetrics({
      throughputPerSec: 42,
      errorRate: 0.01,
      accepted: 500,
      latency: { p95Ms: 30, p99Ms: 99 },
    });
    expect(extracted).toEqual({
      throughputPerSec: 42,
      p95LatencyMs: 30,
      p99LatencyMs: 99,
      errorRate: 0.01,
      accepted: 500,
    });
  });
});

describe('renderReport', () => {
  it('renders a Markdown table and a PASS/FAIL line', () => {
    const md = renderReport(compareToBaseline({ ...baseline, p99LatencyMs: 300 }, baseline));
    expect(md).toContain('| Metric |');
    expect(md).toContain('P99 latency (ms)');
    expect(md).toContain('FAIL');
  });
});
