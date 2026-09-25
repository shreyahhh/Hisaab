// ClickHouse's JSON/JSONEachRow output formats return Int64/UInt64 (and wider) columns as quoted
// strings, not native JSON numbers — JS/JSON number precision can't safely represent the full
// 64-bit range, so the client leaves the choice of number vs bigint to the caller. Affected columns
// here: ad_spend_daily.spend_paise/platform_conversion_value_paise (Int64), impressions/clicks
// (UInt64), order_status.total_amount_paise/refunded_amount_paise (Int64). Smaller integer types
// (UInt8, UInt16, Int32, ...) are already native JSON numbers and don't need this.

/**
 * Parses a ClickHouse Int64/UInt64 value into a JS `number`. Throws if the value is outside
 * `Number.MAX_SAFE_INTEGER` — use {@link parseClickHouseBigInt} for values that can legitimately
 * exceed it (this codebase's paise/impression/click counts never do, at SPEC's target scale).
 */
export function parseClickHouseInt64(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(
        `ClickHouse Int64/UInt64 value ${value} exceeds Number.MAX_SAFE_INTEGER`,
      );
    }
    return value;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(
      `ClickHouse Int64/UInt64 value "${value}" exceeds Number.MAX_SAFE_INTEGER — use parseClickHouseBigInt`,
    );
  }
  return parsed;
}

/** Parses a ClickHouse Int64/UInt64 value into a `bigint`, with no range check needed. */
export function parseClickHouseBigInt(value: string | number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

/**
 * Returns a shallow copy of `row` with the given Int64/UInt64 fields parsed to `number` via
 * {@link parseClickHouseInt64}. Fields already numeric (e.g. re-parsing a cached row) pass through
 * unchanged.
 */
export function parseInt64Fields<T extends Record<string, unknown>, K extends keyof T>(
  row: T,
  fields: readonly K[],
): T {
  const result = { ...row };
  for (const field of fields) {
    result[field] = parseClickHouseInt64(row[field] as string | number) as T[K];
  }
  return result;
}
