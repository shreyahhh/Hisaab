// Decimal-string money → integer paise, with half-up rounding beyond 2 decimal places (HLD "Money in
// paise": "rounding, not truncation, avoids systematic under-reporting" — this is the rounding sibling of
// shopify/mapper.ts's `parseMoneyToPaise`, which trusts Shopify's own already-2-decimal strings and
// truncates any excess instead. An ad platform's spend figures may carry more precision than 2 decimals,
// and truncating would systematically under-count spend).

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * "1234.567" → 123457 (rounds 0.567 → 0.57), "1234.565" → 123457 (a tie rounds up), "1234.564" → 123456,
 * "1234" → 123400, "-1.005" → -101. Throws on anything that isn't a plain decimal number, or whose
 * rounded paise value would exceed `Number.MAX_SAFE_INTEGER`.
 */
export function roundDecimalToPaise(value: string): number {
  const match = DECIMAL.exec(value.trim());
  if (!match) {
    throw new Error(`roundDecimalToPaise: not a decimal money string: ${JSON.stringify(value)}`);
  }
  const [, sign, whole = '0', fracRaw = ''] = match;
  // Padded to at least 3 digits: the first two become paise, the third decides the round.
  const frac = `${fracRaw}000`.slice(0, 3);
  let paise = BigInt(whole) * 100n + BigInt(frac.slice(0, 2));
  if (frac[2]! >= '5') paise += 1n;

  const magnitude = Number(paise);
  if (!Number.isSafeInteger(magnitude)) {
    throw new Error(`roundDecimalToPaise: value out of safe integer range: ${value}`);
  }
  // Avoid a signed zero ("-0.004" must be 0, not -0): only negate a genuinely nonzero magnitude.
  return sign === '-' && magnitude !== 0 ? -magnitude : magnitude;
}
