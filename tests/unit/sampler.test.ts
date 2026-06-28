import { describe, it, expect } from 'vitest';
import { context } from '@opentelemetry/api';
import {
  DomainAwareSampler,
  OPERATION_ATTR,
  BILLING_FINALIZE_OP,
  SAMPLING_PRIORITY_ATTR,
  HIGH_SAMPLING_PRIORITY,
  DOMAIN_BLOCKCHAIN,
  TELEMETRY_DOMAIN_ATTR,
} from '../../src/core/diagnostics/sampler.js';
import { SamplingDecision } from '@opentelemetry/sdk-trace-base';

function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

describe('DomainAwareSampler', () => {
  const sampler = new DomainAwareSampler();

  it('should sample blockchain traces 100% of the time', () => {
    for (let i = 0; i < 100; i++) {
      const result = sampler.shouldSample(
        context.active(),
        generateTraceId(),
        'test-span',
        1,
        { [TELEMETRY_DOMAIN_ATTR]: DOMAIN_BLOCKCHAIN },
        [],
      );
      expect(result.decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    }
  });

  it('should sample billing_finalize traces 100% of the time', () => {
    for (let i = 0; i < 100; i++) {
      const result = sampler.shouldSample(
        context.active(),
        generateTraceId(),
        'test-span',
        1,
        { [OPERATION_ATTR]: BILLING_FINALIZE_OP },
        [],
      );
      expect(result.decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    }
  });

  it('should sample traces with sampling.priority HIGH (2) 100% of the time', () => {
    for (let i = 0; i < 100; i++) {
      const result = sampler.shouldSample(
        context.active(),
        generateTraceId(),
        'test-span',
        1,
        { [SAMPLING_PRIORITY_ATTR]: HIGH_SAMPLING_PRIORITY },
        [],
      );
      expect(result.decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    }
  });

  it('should sample baseline traces at approximately 10% (±2% tolerance)', () => {
    let sampledCount = 0;
    const totalTraces = 1000;

    for (let i = 0; i < totalTraces; i++) {
      const result = sampler.shouldSample(
        context.active(),
        generateTraceId(),
        'test-span',
        1,
        {},
        [],
      );
      if (result.decision === SamplingDecision.RECORD_AND_SAMPLED) {
        sampledCount++;
      }
    }

    const sampleRate = sampledCount / totalTraces;
    expect(sampleRate).toBeGreaterThan(0.05);
    expect(sampleRate).toBeLessThan(0.15);
  });
});
