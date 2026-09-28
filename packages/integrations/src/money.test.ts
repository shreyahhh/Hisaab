import { describe, expect, it } from 'vitest';
import { roundDecimalToPaise } from './money.js';

describe('roundDecimalToPaise', () => {
  it.each([
    ['0', 0],
    ['0.00', 0],
    ['1234', 123400],
    ['1234.5', 123450],
    ['1234.56', 123456],
    ['1234.560', 123456],
    ['1234.561', 123456], // rounds down: 0.561 → 0.56
    ['1234.564', 123456],
    ['1234.565', 123457], // an exact tie rounds up (half-up)
    ['1234.5650001', 123457],
    ['1234.567', 123457], // rounds up: 0.567 → 0.57
    ['1234.5699999', 123457],
    ['0.004', 0],
    ['0.005', 1],
    ['0.009', 1],
    ['0.01', 1],
    ['-1.005', -101],
    ['-1234.567', -123457],
    ['-0.004', 0],
    ['-0.005', -1],
    ['100000000.00', 10000000000],
  ])('%s → %d paise', (input, expected) => {
    expect(roundDecimalToPaise(input)).toBe(expected);
  });

  it.each(['', 'abc', '1.2.3', '1,234.56', 'NaN', 'Infinity', '  ', '1.', '.5', '1 234'])(
    'rejects %j',
    (input) => {
      expect(() => roundDecimalToPaise(input)).toThrow();
    },
  );

  it('accepts a bare decimal point-less integer and a value with no fractional part after the dot is invalid', () => {
    expect(roundDecimalToPaise('42')).toBe(4200);
    expect(() => roundDecimalToPaise('42.')).toThrow();
  });

  it('throws rather than silently overflow', () => {
    expect(() => roundDecimalToPaise('999999999999999999999')).toThrow(/safe integer range/);
  });

  it('never truncates the way the Shopify (non-rounding) parser would — the whole point of this helper', () => {
    // Shopify's parseMoneyToPaise slices the fraction: "1234.567" → paise "56" (truncated), 123456.
    // This one must round instead: 123457.
    expect(roundDecimalToPaise('1234.567')).toBe(123457);
  });
});
