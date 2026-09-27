// Log/URL redaction (privacy-dpdp.md §6). No shopper identifier, and no key material, may reach
// application logs or the error tracker: `redactLogValue` is the hook for both the logger and
// Sentry's beforeSend, and `findPii` is the scanner the log-scan tests (SPEC §5.10 test 4) use.

export const REDACTED = '[redacted]';

// Indian mobile (also written 98123 45678 or 98123-45678, with or without +91/91).
const INDIAN_MOBILE = String.raw`(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)`;
const E164 = String.raw`\+\d{8,15}(?!\d)`;
const EMAIL = String.raw`[^\s@"'<>()\[\],;:]+@[^\s@"'<>()\[\],;:]+\.[^\s@"'<>()\[\],;:]+`;
const HEX_64 = String.raw`(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])`;
// `IDENTITY_MASTER_K1=abc…` or `IDENTITY_MASTER_K1: abc…` as it would appear in a dumped env.
const MASTER_KEY_ASSIGNMENT = String.raw`IDENTITY_MASTER_\w*["']?\s*[=:]\s*["']?[^\s"',;]+`;

export type PiiKind = 'email' | 'phone' | 'hash' | 'secret';

const PATTERNS: readonly { readonly kind: PiiKind; readonly source: string }[] = [
  { kind: 'secret', source: MASTER_KEY_ASSIGNMENT },
  { kind: 'email', source: EMAIL },
  { kind: 'hash', source: HEX_64 },
  { kind: 'phone', source: INDIAN_MOBILE },
  { kind: 'phone', source: E164 },
];

/**
 * Object keys whose values are never logged, whatever they contain. `IDENTITY_MASTER_*` is here so
 * an env dump can't leak the master secrets; the rest are the usual credential/identifier names.
 */
export const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /^identity_master_/i,
  /pass(word|wd)/i,
  /secret/i,
  /token/i,
  /authorization/i,
  /cookie/i,
  /api[-_]?key/i,
  /private[-_]?key/i,
  /e-?mail/i,
  /phone|mobile/i,
  /(^|[-_.])ip($|[-_.]|address)/i,
  /client[-_]?ip|x-forwarded-for/i,
  /user[-_]?agent/i,
  /visitor[-_]?id/i,
];

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function redactString(value: string): string {
  let out = value;
  for (const { source } of PATTERNS) out = out.replace(new RegExp(source, 'g'), REDACTED);
  return out;
}

export interface PiiFinding {
  readonly kind: PiiKind;
  readonly index: number;
}

/** Where `text` contains something redaction would remove. Reports kinds and offsets, never the match. */
export function findPii(text: string): PiiFinding[] {
  const findings: PiiFinding[] = [];
  for (const { kind, source } of PATTERNS) {
    for (const match of text.matchAll(new RegExp(source, 'g'))) {
      findings.push({ kind, index: match.index ?? 0 });
    }
  }
  return findings.sort((a, b) => a.index - b.index);
}

const MAX_DEPTH = 8;

function redactAny(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' || typeof value === 'symbol' ? undefined : value;
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[redacted binary]';
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  try {
    if (value instanceof Error) {
      // A driver wraps its own error before it reaches us — e.g. Drizzle's "Failed query: ..." text
      // for a Postgres failure carries the real detail (and, if any, the query's identifiers) only
      // in `.cause`, not in `.message`. Following the chain (same depth/circular guards as anything
      // else) is what makes redactLogValue's "full error, still redacted" promise true rather than
      // just true of the outermost wrapper.
      return {
        name: value.name,
        message: redactString(value.message),
        ...(value.stack ? { stack: redactString(value.stack) } : {}),
        ...(value.cause !== undefined ? { cause: redactAny(value.cause, depth + 1, seen) } : {}),
      };
    }
    if (Array.isArray(value)) return value.map((item) => redactAny(item, depth + 1, seen));
    if (value instanceof Date) return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redactAny(item, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/** A copy of `value` with identifiers, hashes and secrets replaced by `[redacted]`. */
export function redactLogValue(value: unknown): unknown {
  return redactAny(value, 0, new WeakSet());
}

// ---- URLs -----------------------------------------------------------------------------------

// The only query params kept (collector.md §4 step 9): campaign attribution, nothing personal.
export const ALLOWED_QUERY_PARAMS: readonly string[] = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'fbclid',
  'gclid',
  'gbraid',
  'wbraid',
];

// Everything after these path prefixes is a bearer-style token or an order/customer reference.
const TOKEN_PATH_PREFIXES = ['/checkouts/', '/orders/', '/account/', '/cart/c/'];

function maskedPath(pathname: string): string {
  // The earliest prefix wins, so /account/orders/1 is masked from /account/, not from /orders/.
  let masked: { at: number; prefix: string } | null = null;
  for (const prefix of TOKEN_PATH_PREFIXES) {
    const at = pathname.indexOf(prefix);
    if (at !== -1 && pathname.length > at + prefix.length && (!masked || at < masked.at)) {
      masked = { at, prefix };
    }
  }
  return masked ? `${pathname.slice(0, masked.at + masked.prefix.length)}:token` : pathname;
}

function parseHttpUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * For a page URL: scheme, host and path, only the allow-listed query params, no fragment and no
 * userinfo, and everything after a token-bearing path prefix replaced by `:token` (the whole
 * remainder, so a step name like `/information` after a checkout token is masked with it). Returns
 * '' for anything that isn't a http(s) URL.
 */
export function sanitiseUrl(url: string): string {
  const parsed = parseHttpUrl(url);
  if (!parsed) return '';
  const kept = new URLSearchParams();
  for (const [name, value] of parsed.searchParams) {
    if (ALLOWED_QUERY_PARAMS.includes(name)) kept.append(name, value);
  }
  const query = kept.toString();
  return `${parsed.protocol}//${parsed.host}${maskedPath(parsed.pathname)}${query ? `?${query}` : ''}`;
}

/** For a referrer: origin and path only (no query at all), with the same token masking. */
export function sanitiseReferrer(url: string): string {
  const parsed = parseHttpUrl(url);
  return parsed ? `${parsed.protocol}//${parsed.host}${maskedPath(parsed.pathname)}` : '';
}
