import { APIError } from 'better-auth/api';

// Better Auth reports failure in two different ways: `auth.api.*` throws an APIError, or — with
// `asResponse: true` — returns a 4xx Response and does NOT throw. Code that assumes "no exception
// means success" mis-handles the second (login audited a wrong password as login_succeeded).
// `authCall` folds both into one thrown `AuthApiError`, so a call site has a single failure path.
//
// Every `auth.api.*` call in this app goes through it (authCallUsage.test.ts enforces that), and
// app.ts maps an uncaught AuthApiError to `{ error: <code> }` with Better Auth's status.

export class AuthApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
  ) {
    // Only the code: Better Auth's own message text can echo request data.
    super(`Better Auth rejected the request (${statusCode} ${code})`);
    this.name = 'AuthApiError';
  }
}

const FALLBACK_CODE = 'auth_error';

async function codeFromResponse(response: Response): Promise<string> {
  try {
    const body: unknown = await response.clone().json();
    const code = (body as { code?: unknown } | null)?.code;
    return typeof code === 'string' && code.length > 0 ? code : FALLBACK_CODE;
  } catch {
    return FALLBACK_CODE;
  }
}

/**
 * Runs a Better Auth call. A thrown APIError, or a returned Response with a status of 400 or more,
 * becomes an `AuthApiError` carrying the status and Better Auth's error code. Anything else that
 * is thrown (a database outage, a bug) is not a Better Auth rejection and passes through as is.
 */
export async function authCall<T>(call: () => Promise<T>): Promise<T> {
  let result: T;
  try {
    result = await call();
  } catch (error) {
    if (error instanceof APIError) {
      const code = error.body?.code;
      throw new AuthApiError(
        error.statusCode,
        typeof code === 'string' && code.length > 0 ? code : FALLBACK_CODE,
      );
    }
    throw error;
  }
  const response: unknown = result;
  if (response instanceof Response && response.status >= 400) {
    throw new AuthApiError(response.status, await codeFromResponse(response));
  }
  return result;
}
