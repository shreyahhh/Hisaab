import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APIError } from 'better-auth/api';
import { describe, expect, it } from 'vitest';
import { AuthApiError, authCall } from './authCall.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

async function failure(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('authCall', () => {
  it('returns a successful result untouched', async () => {
    const value = { ok: true };
    expect(await authCall(async () => value)).toBe(value);
  });

  it('returns a 2xx Response, and a 3xx redirect, untouched', async () => {
    const ok = json(200, { fine: true });
    expect(await authCall(async () => ok)).toBe(ok);
    const redirect = new Response(null, { status: 302, headers: { location: '/somewhere' } });
    expect(await authCall(async () => redirect)).toBe(redirect);
  });

  it.each([400, 401, 403, 404, 409, 422, 429, 500])(
    "turns a %i Response into an AuthApiError with that status and Better Auth's code",
    async (status) => {
      const error = await failure(() =>
        authCall(async () => json(status, { code: 'SOME_CODE', message: 'x' })),
      );
      expect(error).toBeInstanceOf(AuthApiError);
      expect(error).toMatchObject({ statusCode: status, code: 'SOME_CODE' });
    },
  );

  it('falls back to a generic code when the body has none, is not JSON, or is empty', async () => {
    for (const response of [
      json(400, { message: 'no code' }),
      json(400, { code: 42 }),
      json(400, null),
      new Response('<html>bad gateway</html>', { status: 502 }),
      new Response(null, { status: 401 }),
    ]) {
      const error = await failure(() => authCall(async () => response));
      expect(error).toBeInstanceOf(AuthApiError);
      expect((error as AuthApiError).code).toBe('auth_error');
      expect((error as AuthApiError).statusCode).toBe(response.status);
    }
  });

  it('turns a thrown APIError into an AuthApiError with its status and code', async () => {
    const error = await failure(() =>
      authCall(async () => {
        throw new APIError('CONFLICT', { code: 'THING_EXISTS', message: 'x' });
      }),
    );
    expect(error).toBeInstanceOf(AuthApiError);
    expect(error).toMatchObject({ statusCode: 409, code: 'THING_EXISTS' });
  });

  it('gives a thrown APIError with no code the generic one', async () => {
    const error = await failure(() =>
      authCall(async () => {
        throw new APIError('BAD_REQUEST');
      }),
    );
    expect(error).toMatchObject({ statusCode: 400, code: 'auth_error' });
  });

  it('does not convert anything that is not a Better Auth rejection', async () => {
    const boom = new Error('database is down');
    expect(await failure(() => authCall(async () => Promise.reject(boom)))).toBe(boom);
  });

  it("keeps Better Auth's message out of the error, which can echo request data", async () => {
    const error = (await failure(() =>
      authCall(async () => json(400, { code: 'X', message: 'user someone@example.com exists' })),
    )) as Error;
    expect(error.message).not.toContain('someone@example.com');
  });

  it('leaves the original response readable (it reads a clone)', async () => {
    const response = json(400, { code: 'X' });
    await failure(() => authCall(async () => response));
    expect(response.bodyUsed).toBe(false);
  });
});

// The whole point of the helper is that there is no second, unwrapped way to call Better Auth:
// a bare `auth.api.x()` brings back the "no exception means success" bug. So every use of
// `auth.api.` in the app's own source must be the direct body of an `authCall(() => …)`.
describe('every auth.api.* call in apps/api goes through authCall', () => {
  const SRC = path.dirname(fileURLToPath(import.meta.url));

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'testAuthTenant.ts'
        ? [full]
        : [];
    });
  }

  it('finds the call sites it is meant to guard', () => {
    const calls = sourceFiles(SRC).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/\bauth\.api\.\w+/g)].map((m) => m[0]),
    );
    expect(calls.length).toBeGreaterThanOrEqual(10);
  });

  it('has no unwrapped call', () => {
    const unwrapped: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/(?:\b\w+\.)?auth\.api\.(\w+)/g)) {
        const before = text.slice(0, match.index);
        // Comments may mention `auth.api.*`; only code counts.
        const lineStart = before.lastIndexOf('\n') + 1;
        if (/^\s*(\*|\/\/)/.test(text.slice(lineStart, match.index))) continue;
        if (!/authCall\(\s*(async\s*)?\(\)\s*=>\s*$/.test(before)) {
          unwrapped.push(`${path.relative(SRC, file)}: auth.api.${match[1]}`);
        }
      }
    }
    expect(unwrapped).toEqual([]);
  });
});
