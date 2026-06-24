export const MetricRangeMap: Record<string, { lowerBound: bigint; upperBound: bigint }> = {
  temperature: { lowerBound: -50n, upperBound: 150n },
  humidity: { lowerBound: 0n, upperBound: 100n },
  voltage: { lowerBound: 0n, upperBound: 500n },
  energy_kwh: { lowerBound: 0n, upperBound: 1000000n },
};

export interface BillingTier {
  min: number;
  max: number;
}

export const DEFAULT_BILLING_TIERS: Record<string, BillingTier> = {
  TIER_1: { min: 0, max: 1000 },
  TIER_2: { min: 1001, max: 10000 },
  TIER_3: { min: 10001, max: Infinity },
};
