export class PrecisionOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrecisionOverflowError';
  }
}

export const SafeMath = {
  SOROBAN_DECIMALS: 7,
  MAX_SOROBAN_VALUE: 2n ** 63n - 1n,
  MIN_SOROBAN_VALUE: -(2n ** 63n),
  HIGH_WATERMARK_RATIO: 80n,

  toSorobanPrecision(rawValue: bigint, sourceDecimals: number): bigint {
    let result: bigint;
    if (sourceDecimals === this.SOROBAN_DECIMALS) {
      result = rawValue;
    } else if (sourceDecimals > this.SOROBAN_DECIMALS) {
      result = rawValue / 10n ** BigInt(sourceDecimals - this.SOROBAN_DECIMALS);
    } else {
      result = rawValue * 10n ** BigInt(this.SOROBAN_DECIMALS - sourceDecimals);
    }
    if (this.checkOverflow(result)) {
      throw new PrecisionOverflowError(
        `Conversion from ${sourceDecimals} to ${this.SOROBAN_DECIMALS} decimals overflows: rawValue=${rawValue.toString()}, result=${result.toString()}`,
      );
    }
    return result;
  },

  multiplyWithPrecision(a: bigint, b: bigint, precisionDecimals: number): bigint {
    const product = a * b;
    const divisor = 10n ** BigInt(precisionDecimals);
    return product / divisor;
  },

  checkOverflow(value: bigint): boolean {
    if (value > this.MAX_SOROBAN_VALUE || value < this.MIN_SOROBAN_VALUE) {
      return true;
    }
    return false;
  },

  safeAdd(a: bigint, b: bigint): bigint {
    const result = a + b;
    if (this.checkOverflow(result)) {
      throw new RangeError(`Integer overflow in addition: ${String(a)} + ${String(b)}`);
    }
    return result;
  },

  safeMultiply(a: bigint, b: bigint): bigint {
    const result = a * b;
    if (this.checkOverflow(result)) {
      throw new RangeError(`Integer overflow in multiplication: ${String(a)} * ${String(b)}`);
    }
    return result;
  },

  checkedAdd(a: bigint, b: bigint): bigint {
    return this.safeAdd(a, b);
  },

  checkedMultiply(a: bigint, b: bigint): bigint {
    return this.safeMultiply(a, b);
  },

  roundUpDiv(dividend: bigint, divisor: bigint): bigint {
    if (divisor === 0n) {
      throw new RangeError('Division by zero');
    }
    const isNegative = dividend < 0n !== divisor < 0n;
    const absDividend = dividend < 0n ? -dividend : dividend;
    const absDivisor = divisor < 0n ? -divisor : divisor;
    const quotient = absDividend / absDivisor;
    const remainder = absDividend % absDivisor;
    if (remainder === 0n) {
      return isNegative ? -quotient : quotient;
    }
    const rounded = quotient + 1n;
    return isNegative ? -rounded : rounded;
  },

  validatePriceMetricProduct(price: bigint, units: bigint): bigint {
    const product = this.checkedMultiply(price, units);
    const watermark = (this.MAX_SOROBAN_VALUE * this.HIGH_WATERMARK_RATIO) / 100n;
    if (product > watermark) {
      console.warn(
        `Price-metric product ${product.toString()} exceeds 80% of MAX_SOROBAN_VALUE (${this.MAX_SOROBAN_VALUE.toString()})`,
      );
    }
    return product;
  },
} as const;
