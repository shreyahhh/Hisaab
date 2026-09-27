import type { FastifyInstance, FastifyReply } from 'fastify';
import { redactLogValue } from '@truepath/privacy';
import { AuthApiError } from './authCall.js';

// The app's one error handler (SPEC §0 rule 3; issue #20, and its review follow-up). Every route's
// *known* failures reply directly (`reply.code(...).send(...)`) and never throw, so this only ever
// sees what nobody anticipated: an uncaught AuthApiError, a hand-built response object thrown by our
// own trusted code (rate limiting — @fastify/rate-limit's errorResponseBuilder), a genuine
// Fastify-internal client error (malformed JSON, an oversized body, ...), or anything else — a
// database driver error, a bug, a Fastify-internal *server* failure. Only the first three are
// answered with any detail, and even then never Fastify's own message; before this, an uncaught
// error of any kind fell through to Fastify's default handler, which put the raw error message —
// for a Drizzle/pg failure, the full SQL statement and its bound parameters — straight in the 500
// body. Everything left over is always a bare `{ error: 'internal_error', request_id }`, and the
// real, redacted detail is logged server-side under the same request_id so it can still be found.

/** One structured JSON line per report; overridable in tests, like AuditService's `report` option. */
export type ErrorReporter = (line: Record<string, unknown>) => void;

/** Default reporter: one structured JSON line on stderr, matching audit.ts's `logAuditFailure`. */
export const logUnhandledError: ErrorReporter = (line) => {
  console.error(JSON.stringify(line));
};

export interface RegisterErrorHandlerOptions {
  readonly report?: ErrorReporter;
}

/**
 * A value our own code threw on purpose to become an HTTP response, not an exception: never an
 * `Error` instance, and — because nothing but ids/enums/counts ever goes into one of these — never
 * carrying driver or programmer detail. Matches `rateLimitedBody()` in rateLimit.ts, the one thing
 * in this app that throws a plain object; verified empirically that Fastify hands such a throw to
 * the error handler completely unwrapped (`error instanceof Error` is false), so this check is safe.
 */
function isHandBuiltErrorResponse(value: unknown): value is {
  readonly statusCode: number;
  readonly error: string;
  readonly [key: string]: unknown;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Error) &&
    typeof (value as { statusCode?: unknown }).statusCode === 'number' &&
    typeof (value as { error?: unknown }).error === 'string'
  );
}

/**
 * A genuine Fastify-internal client error — malformed JSON, a body over the size limit, a
 * content-type with no parser, a schema-validation failure — never a database/application error.
 * These always carry a `FST_ERR_*` code (`@fastify/error`'s own convention, distinct from
 * AuthApiError's Better Auth codes and from any code this app defines) and a real 4xx `statusCode`.
 * Verified empirically for all four cases named in issue #20's follow-up. Gated to `< 500` so a
 * genuinely server-side Fastify failure (a plugin bug, `FST_ERR_REP_ALREADY_SENT`, ...) still falls
 * through to the generic logged path below, instead of being treated as the caller's mistake.
 */
function isFastifyClientError(
  value: unknown,
): value is Error & { readonly code: string; readonly statusCode: number } {
  if (!(value instanceof Error)) return false;
  const code = (value as { code?: unknown }).code;
  const statusCode = (value as { statusCode?: unknown }).statusCode;
  return (
    typeof code === 'string' &&
    code.startsWith('FST_ERR_') &&
    typeof statusCode === 'number' &&
    statusCode >= 400 &&
    statusCode < 500
  );
}

// A generic code per status, never Fastify's own message (which can echo a fragment of the body,
// e.g. a JSON parse error's "Unexpected token X"). Any 4xx not listed falls back to 'bad_request',
// which is always at least as safe as forwarding Fastify's own FST_ERR_* code would have been.
const GENERIC_CLIENT_ERROR_CODES: Readonly<Record<number, string>> = {
  400: 'bad_request',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  431: 'header_too_large',
};

function genericClientErrorCode(statusCode: number): string {
  return GENERIC_CLIENT_ERROR_CODES[statusCode] ?? 'bad_request';
}

/**
 * `request.url` is the raw request-line target — percent-encoded, so an `@` in a query value
 * arrives as `%40` and none of redactLogValue's patterns (which match literal characters) would
 * see it. Decoded first, then redacted, an embedded identifier is actually caught. Malformed
 * encoding (an unpaired `%`) is left as-is rather than thrown on; it still goes through redaction,
 * just without the benefit of decoding.
 */
function decodedUrlForLogging(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

/** Registers the app's global error handler. */
export function registerAuthErrorHandler(
  app: FastifyInstance,
  options: RegisterErrorHandlerOptions = {},
): void {
  const report = options.report ?? logUnhandledError;

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof AuthApiError) {
      await reply.code(error.statusCode).send({ error: error.code });
      return;
    }
    if (isHandBuiltErrorResponse(error)) {
      await reply.code(error.statusCode).send(error);
      return;
    }
    if (isFastifyClientError(error)) {
      await reply.code(error.statusCode).send({ error: genericClientErrorCode(error.statusCode) });
      return;
    }

    // Anything else: never known to be safe, so nothing about it reaches the client. The detail
    // (error name/message/stack, method, url) goes through redactLogValue first — the same
    // redaction the log-scan test (SPEC §5.10 test 4) and Sentry's beforeSend use — so an identifier
    // that ended up in a query string or an error message is masked in the log line too, not just
    // kept out of the response.
    const detail = redactLogValue({
      error,
      method: request.method,
      url: decodedUrlForLogging(request.url),
    }) as Record<string, unknown>;
    report({
      event: 'unhandled_error',
      alert: 'unhandled_error',
      request_id: request.id,
      ...detail,
    });
    await reply.code(500).send({ error: 'internal_error', request_id: request.id });
  });
}

/** Copies a Fetch API Response (status, headers incl. Set-Cookie, body) onto a Fastify reply. */
export async function forwardResponse(reply: FastifyReply, response: Response): Promise<void> {
  reply.code(response.status);
  response.headers.forEach((value, key) => reply.header(key, value));
  await reply.send(response.body ? await response.text() : null);
}
