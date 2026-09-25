import { describe, expect, it } from 'vitest';
import { parseClickHouseBigInt, parseClickHouseInt64, parseInt64Fields } from './parseInt64.js';

describe('parseClickHouseInt64', () => {
  it('parses a quoted Int64/UInt64 string, as returned by JSON/JSONEachRow', () => {
    expect(parseClickHouseInt64('123456789')).toBe(123456789);
  });

  it('passes an already-numeric value through unchanged', () => {
    expect(parseClickHouseInt64(42)).toBe(42);
  });

  it('accepts values at the edge of Number.MAX_SAFE_INTEGER', () => {
    expect(parseClickHouseInt64(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('throws for a string value beyond Number.MAX_SAFE_INTEGER', () => {
    const tooBig = '9223372036854775807'; // Int64 max
    expect(() => parseClickHouseInt64(tooBig)).toThrow(RangeError);
  });

  it('throws for a numeric value beyond Number.MAX_SAFE_INTEGER (defensive — should never happen upstream)', () => {
    expect(() => parseClickHouseInt64(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
  });
});

describe('parseClickHouseBigInt', () => {
  it('parses a quoted Int64/UInt64 string with no range limit', () => {
    expect(parseClickHouseBigInt('9223372036854775807')).toBe(9223372036854775807n);
  });

  it('accepts an already-bigint value unchanged', () => {
    expect(parseClickHouseBigInt(10n)).toBe(10n);
  });

  it('accepts a plain number', () => {
    expect(parseClickHouseBigInt(10)).toBe(10n);
  });
});

describe('parseInt64Fields', () => {
  it('parses only the named fields, leaving the rest of the row untouched', () => {
    const row = {
      store_id: 'abc',
      spend_paise: '150000',
      impressions: '98765',
      platform: 'meta',
    };
    const parsed = parseInt64Fields(row, ['spend_paise', 'impressions']);
    expect(parsed).toEqual({
      store_id: 'abc',
      spend_paise: 150000,
      impressions: 98765,
      platform: 'meta',
    });
  });

  it('does not mutate the original row', () => {
    const row = { spend_paise: '150000' };
    const parsed = parseInt64Fields(row, ['spend_paise']);
    expect(row.spend_paise).toBe('150000');
    expect(parsed.spend_paise).toBe(150000);
  });
});
