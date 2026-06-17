import { describe, it, expect, vi } from 'vitest';
import { SafeMath, PrecisionOverflowError } from '../../src/core/utils/math.js';

describe('SafeMath', () => {
  describe('toSorobanPrecision', () => {
    it('should return rawValue when sourceDecimals equals SOROBAN_DECIMALS', () => {
      const raw = 1234567n;
      expect(SafeMath.toSorobanPrecision(raw, 7)).toBe(raw);
    });

    it('should scale down when sourceDecimals > SOROBAN_DECIMALS', () => {
      const raw = 123456789n;
      expect(SafeMath.toSorobanPrecision(raw, 9)).toBe(1234567n);
    });

    it('should scale up when sourceDecimals < SOROBAN_DECIMALS', () => {
      const raw = 123n;
      expect(SafeMath.toSorobanPrecision(raw, 5)).toBe(12300n);
    });

    it('should throw PrecisionOverflowError on positive overflow', () => {
      const raw = SafeMath.MAX_SOROBAN_VALUE + 1n;
      expect(() => SafeMath.toSorobanPrecision(raw, 6)).toThrow(PrecisionOverflowError);
    });

    it('should throw PrecisionOverflowError on negative overflow', () => {
      const raw = SafeMath.MIN_SOROBAN_VALUE - 1n;
      expect(() => SafeMath.toSorobanPrecision(raw, 6)).toThrow(PrecisionOverflowError);
    });

    it('should not throw when conversion stays within bounds', () => {
      const raw = 1000000n;
      expect(SafeMath.toSorobanPrecision(raw, 5)).toBe(100000000n);
    });
  });

  describe('checkOverflow', () => {
    it('should return false for values within range', () => {
      expect(SafeMath.checkOverflow(0n)).toBe(false);
      expect(SafeMath.checkOverflow(SafeMath.MAX_SOROBAN_VALUE)).toBe(false);
      expect(SafeMath.checkOverflow(SafeMath.MIN_SOROBAN_VALUE)).toBe(false);
    });

    it('should return true for values outside range', () => {
      expect(SafeMath.checkOverflow(SafeMath.MAX_SOROBAN_VALUE + 1n)).toBe(true);
      expect(SafeMath.checkOverflow(SafeMath.MIN_SOROBAN_VALUE - 1n)).toBe(true);
    });
  });

  describe('safeAdd', () => {
    it('should return correct sum', () => {
      expect(SafeMath.safeAdd(2n, 3n)).toBe(5n);
      expect(SafeMath.safeAdd(-1n, 1n)).toBe(0n);
    });

    it('should throw RangeError on overflow', () => {
      expect(() => SafeMath.safeAdd(SafeMath.MAX_SOROBAN_VALUE, 1n)).toThrow(RangeError);
    });

    it('should throw RangeError on negative overflow', () => {
      expect(() => SafeMath.safeAdd(SafeMath.MIN_SOROBAN_VALUE, -1n)).toThrow(RangeError);
    });
  });

  describe('safeMultiply', () => {
    it('should return correct product', () => {
      expect(SafeMath.safeMultiply(3n, 4n)).toBe(12n);
      expect(SafeMath.safeMultiply(-2n, 5n)).toBe(-10n);
    });

    it('should throw RangeError on overflow', () => {
      expect(() => SafeMath.safeMultiply(SafeMath.MAX_SOROBAN_VALUE, 2n)).toThrow(RangeError);
    });
  });

  describe('checkedAdd', () => {
    it('should behave identically to safeAdd', () => {
      expect(SafeMath.checkedAdd(10n, 20n)).toBe(30n);
      expect(() => SafeMath.checkedAdd(SafeMath.MAX_SOROBAN_VALUE, 1n)).toThrow(RangeError);
    });
  });

  describe('checkedMultiply', () => {
    it('should behave identically to safeMultiply', () => {
      expect(SafeMath.checkedMultiply(5n, 6n)).toBe(30n);
      expect(() => SafeMath.checkedMultiply(SafeMath.MAX_SOROBAN_VALUE, 2n)).toThrow(RangeError);
    });
  });

  describe('roundUpDiv', () => {
    it('should round up for positive division with remainder', () => {
      expect(SafeMath.roundUpDiv(7n, 3n)).toBe(3n);
      expect(SafeMath.roundUpDiv(10n, 3n)).toBe(4n);
    });

    it('should return exact quotient when divisible', () => {
      expect(SafeMath.roundUpDiv(9n, 3n)).toBe(3n);
      expect(SafeMath.roundUpDiv(0n, 5n)).toBe(0n);
    });

    it('should throw on division by zero', () => {
      expect(() => SafeMath.roundUpDiv(1n, 0n)).toThrow(RangeError);
    });

    it('should handle negative dividend (round toward negative infinity)', () => {
      expect(SafeMath.roundUpDiv(-7n, 3n)).toBe(-3n);
    });

    it('should handle negative divisor (round toward negative infinity)', () => {
      expect(SafeMath.roundUpDiv(7n, -3n)).toBe(-3n);
    });

    it('should handle both negative', () => {
      expect(SafeMath.roundUpDiv(-7n, -3n)).toBe(3n);
    });

    it('should round up correctly for protocol-favorable debit rounding', () => {
      expect(SafeMath.roundUpDiv(100n, 3n)).toBe(34n);
      expect(SafeMath.roundUpDiv(1n, 7n)).toBe(1n);
    });
  });

  describe('validatePriceMetricProduct', () => {
    it('should return the product of price and units', () => {
      expect(SafeMath.validatePriceMetricProduct(100n, 50n)).toBe(5000n);
    });

    it('should warn when product exceeds 80% of MAX_SOROBAN_VALUE', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const highPrice = SafeMath.MAX_SOROBAN_VALUE / 2n;
      const highUnits = 2n;
      SafeMath.validatePriceMetricProduct(highPrice, highUnits);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should not warn when product is below 80% of MAX_SOROBAN_VALUE', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      SafeMath.validatePriceMetricProduct(100n, 100n);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should throw on overflow from price * units', () => {
      expect(() => SafeMath.validatePriceMetricProduct(SafeMath.MAX_SOROBAN_VALUE, 2n)).toThrow(
        RangeError,
      );
    });
  });

  describe('fuzz: price-metric product overflow safety', () => {
    it('should never produce overflow for bounded random inputs', () => {
      const maxPrice = 10n ** 10n;
      const maxUnits = 10n ** 6n;
      for (let i = 0; i < 1000; i++) {
        const price = BigInt(Math.floor(Math.random() * Number(maxPrice)));
        const units = BigInt(Math.floor(Math.random() * Number(maxUnits)));
        const result = SafeMath.checkedMultiply(price, units);
        expect(result).toBeGreaterThanOrEqual(0n);
        expect(SafeMath.checkOverflow(result)).toBe(false);
      }
    });
  });
});
