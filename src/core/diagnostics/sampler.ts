import type { Context, Link, SpanKind, Attributes } from '@opentelemetry/api';
import {
  SamplingDecision,
  type SamplingResult,
  type Sampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';

export const TELEMETRY_DOMAIN_ATTR = 'telemetry.domain';
export const DOMAIN_BLOCKCHAIN = 'blockchain';
export const DOMAIN_TELEMETRY = 'telemetry';
export const SAMPLING_PRIORITY_ATTR = 'sampling.priority';
export const OPERATION_ATTR = 'operation';
export const BILLING_FINALIZE_OP = 'billing_finalize';
export const HIGH_SAMPLING_PRIORITY = 2;

const BASELINE_SAMPLE_RATIO = 0.1;
const baselineSampler = new TraceIdRatioBasedSampler(BASELINE_SAMPLE_RATIO);

function getDomain(attributes: Attributes): string | undefined {
  const value = attributes[TELEMETRY_DOMAIN_ATTR];
  return typeof value === 'string' ? value : undefined;
}

function getSamplingPriority(attributes: Attributes): number | undefined {
  const value = attributes[SAMPLING_PRIORITY_ATTR];
  return typeof value === 'number' ? value : undefined;
}

function isBillingFinalize(attributes: Attributes): boolean {
  const value = attributes[OPERATION_ATTR];
  return typeof value === 'string' && value === BILLING_FINALIZE_OP;
}

export class DomainAwareSampler implements Sampler {
  shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    _links: Link[],
  ): SamplingResult {
    const domain = getDomain(attributes);

    if (domain === DOMAIN_BLOCKCHAIN) {
      return { decision: SamplingDecision.RECORD_AND_SAMPLED };
    }

    const samplingPriority = getSamplingPriority(attributes);
    if (samplingPriority === HIGH_SAMPLING_PRIORITY || isBillingFinalize(attributes)) {
      return { decision: SamplingDecision.RECORD_AND_SAMPLED };
    }

    return baselineSampler.shouldSample(context, traceId);
  }

  toString(): string {
    return `DomainAwareSampler{blockchain=100%, billing_finalize=100%, baseline=${String(BASELINE_SAMPLE_RATIO * 100)}%}`;
  }
}
