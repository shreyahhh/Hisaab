import type { FastifyInstance, FastifyReply } from 'fastify';
import { redactLogValue } from '@truepath/privacy';
import { AuthApiError } from './authCall.js';

// The app's one error handler (SPEC §0 rule 3; issue #20). Every route's *known* failures reply
// directly (`reply.code(...).send(...)`) and never throw, so this only ever sees what nobody
// anticipated: an uncaught AuthApiError, a hand-built response object thrown by our own trusted code
// (rate limiting — @fastify/rate-limit's errorResponseBuilder), or anything else — a database driver
// error, a bug, a Fastify-internal failure. Only the first two are answered with any detail; before
// this, the third case fell through to Fastify's default handler, which put the raw error message —
// for a Drizzle/pg failure, the full SQL statement and its bound parameters — straight in the 500
// body. Now it is always a bare `{ error: 'internal_error', request_id }`, and the real, redacted
// detail is logged server-side under the same request_id so it can still be found.

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
