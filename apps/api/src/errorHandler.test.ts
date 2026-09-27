import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import Fastify from 'fastify';
import { createAuditLogRepository, type AuditLogRepository } from '@truepath/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuditService } from './audit.js';
import { registerAuthErrorHandler } from './errors.js';
import { buildTestApp, testAuth, testDb } from './testApp.js';
import { cleanupRealTenant, seedRealTenant } from './testAuthTenant.js';

// The global error handler (issue #20): any error that isn't a known, mapped one must never put a
// SQL statement, bound parameters, a stack trace or a raw error message in the response — only
// `{ error: 'internal_error', request_id }` — while the real, redacted detail is still logged
// server-side under that request_id. Two distinct causes are forced here: a genuine Postgres error
// (a trigger on `audit_log`) and a plain JS error from our own code (a stubbed audit write), on the
// same representative route — `GET /v1/orgs/:id/audit-log`, which writes an audit row synchronously
// before answering (README: "if it fails, so does the request").

const ORIGIN = 'http://localhost:5173';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const asHeaders = (t: { cookie: string }) => ({ cookie: t.cookie, origin: ORIGIN });

async function tenant(label: string) {
  const t = await seedRealTenant(testAuth, testDb, label);
  cleanups.push(() => cleanupRealTenant(testDb, t));
  return t;
}

function collectingReporter() {
  const lines: Array<Record<string, unknown>> = [];
  return { lines, report: (line: Record<string, unknown>) => lines.push(line) };
}

const FORBIDDEN_SUBSTRINGS = [
  'insert into',
  'select ',
  'audit_log',
  'params:',
  'at Object',
  '.ts:',
  'TypeError',
  'Error:',
];

function assertNoLeakage(body: string) {
  const lower = body.toLowerCase();
  for (const needle of FORBIDDEN_SUBSTRINGS) {
    expect(lower, `response body must not contain "${needle}": ${body}`).not.toContain(
      needle.toLowerCase(),
    );
  }
}

describe('global error handler — a genuine database error', () => {
  it('answers 500 internal_error with a request_id, and logs the real detail (redacted) under it', async () => {
    const owner = await tenant('errh-db');
    const { lines, report } = collectingReporter();
    const app = buildTestApp({ errorReporter: report });

    const id = randomUUID().replaceAll('-', '_');
    const fn = `test_boom_${id}`;
    // Fails only this org's audit_log inserts, so nothing else running against the shared
    // database is affected. The raised message deliberately looks like it could leak: it isn't the
    // point of the assertion (the assertion is that NOTHING resembling it reaches the client).
    await testDb.execute(
      sql.raw(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'select secret from audit_log where organization_id = 42'; END $$`),
    );
    await testDb.execute(
      sql.raw(`CREATE TRIGGER ${fn} BEFORE INSERT ON audit_log FOR EACH ROW
        WHEN (NEW.organization_id = '${owner.organizationId}')
        EXECUTE FUNCTION ${fn}()`),
    );
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/orgs/${owner.organizationId}/audit-log`,
        headers: asHeaders(owner),
      });

      expect(res.statusCode).toBe(500);
      const body = res.json();
      expect(Object.keys(body).sort()).toEqual(['error', 'request_id']);
      expect(body.error).toBe('internal_error');
      // A UUID (genReqId in app.ts), not Fastify's default per-process counter ("req-1", "req-2",
      // ...): it must stay unique across restarts and across a deployment's several API instances.
      expect(body.request_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      assertNoLeakage(res.body);
      expect(res.body).not.toContain(owner.organizationId);
      expect(res.body).not.toContain(owner.userId);

      expect(lines).toHaveLength(1);
      const line = lines[0]!;
      expect(line.event).toBe('unhandled_error');
      expect(line.alert).toBe('unhandled_error');
      expect(line.request_id).toBe(body.request_id);
      expect(line.method).toBe('GET');
      expect(String(line.url)).toContain(`/v1/orgs/${owner.organizationId}/audit-log`);
      // The real detail IS present server-side — this is what "logged, not lost" means. Drizzle
      // wraps the driver's own error ("Failed query: ...") in .message; the trigger's actual text
      // is one level down, in .cause — redactLogValue now follows that chain (packages/privacy).
      const errorField = line.error as {
        name?: string;
        message?: string;
        cause?: { message?: string };
      };
      expect(errorField.name).toBeTruthy();
      expect(errorField.message).toContain('Failed query');
      expect(errorField.cause?.message).toContain('select secret from audit_log');
    } finally {
      await testDb.execute(sql.raw(`DROP TRIGGER IF EXISTS ${fn} ON audit_log`));
      await testDb.execute(sql.raw(`DROP FUNCTION IF EXISTS ${fn}()`));
      await app.close();
    }
  });
});

describe('global error handler — a thrown non-database error', () => {
  it('answers the same generic 500, with no message or stack, and logs the real one', async () => {
    const owner = await tenant('errh-js');
    const { lines, report } = collectingReporter();

    // A stubbed audit repository whose write throws a plain JS bug, not a driver error — proves the
    // handler isn't secretly keyed to Postgres-shaped errors.
    const inner = createAuditLogRepository(testDb);
    const brokenLog: AuditLogRepository = {
      ...inner,
      write: async () => {
        throw new TypeError('a programmer bug, not a database error, reached the handler');
      },
    };
    const app = buildTestApp({ errorReporter: report, audit: createAuditService(brokenLog) });

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/orgs/${owner.organizationId}/audit-log`,
        headers: asHeaders(owner),
      });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'internal_error', request_id: expect.any(String) });
      assertNoLeakage(res.body);
      expect(res.body).not.toContain('programmer bug');

      expect(lines).toHaveLength(1);
      const errorField = lines[0]!.error as { name?: string; message?: string };
      expect(errorField.name).toBe('TypeError');
      expect(errorField.message).toContain('a programmer bug, not a database error');
      expect(lines[0]!.request_id).toBe(res.json().request_id);
    } finally {
      await app.close();
    }
  });
});

describe('global error handler — query-string identifiers are redacted in the log line too', () => {
  // A standalone Fastify instance with only this handler registered — no route in this app has a
  // query schema that would accept a stray identifier param, so this exercises errors.ts directly
  // rather than routing an unrelated 400 through orgs.ts's strict query validation.
  it('masks an email embedded in the request URL before it is reported', async () => {
    const { lines, report } = collectingReporter();
    const probe = Fastify({ logger: false });
    registerAuthErrorHandler(probe, { report });
    probe.get('/probe', async () => {
      throw new Error('boom');
    });

    try {
      const res = await probe.inject({
        method: 'GET',
        url: '/probe?x=shopper%40example.com',
      });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('shopper@example.com');

      expect(lines).toHaveLength(1);
      expect(String(lines[0]!.url)).not.toContain('shopper@example.com');
      expect(String(lines[0]!.url)).toContain('[redacted]');
    } finally {
      await probe.close();
    }
  });

  it('malformed percent-encoding in the URL does not crash the handler itself', async () => {
    const { lines, report } = collectingReporter();
    const probe = Fastify({ logger: false });
    registerAuthErrorHandler(probe, { report });
    probe.get('/probe', async () => {
      throw new Error('boom');
    });

    try {
      const res = await probe.inject({ method: 'GET', url: '/probe?x=%E0%A4%A' }); // unpaired % byte
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'internal_error', request_id: expect.any(String) });
      expect(lines).toHaveLength(1);
    } finally {
      await probe.close();
    }
  });
});

describe('global error handler — existing mapped errors are unchanged', () => {
  it('a wrong password is still 401 with the Better Auth code, not swallowed into internal_error', async () => {
    const owner = await tenant('errh-mapped-401');
    const app = buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { origin: ORIGIN },
        payload: { email: owner.email, password: 'definitely-the-wrong-password-123' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'INVALID_EMAIL_OR_PASSWORD' });
    } finally {
      await app.close();
    }
  });

  it('a rate-limited request is still 429 with its own body and retry-after header', async () => {
    const app = buildTestApp();
    try {
      const ip = `10.77.${Math.floor(Math.random() * 254) + 1}.1`;
      let last;
      for (let i = 0; i < 11; i += 1) {
        last = await app.inject({
          method: 'POST',
          url: '/v1/auth/signup',
          headers: { origin: ORIGIN },
          remoteAddress: ip,
          payload: {
            email: `errh-429-${i}-${randomUUID()}@example.invalid`,
            password: 'x',
            name: 'x',
          },
        });
      }
      expect(last!.statusCode).toBe(429);
      expect(last!.json()).toMatchObject({ error: 'rate_limited' });
      expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it('a foreign organization is still 404, not internal_error', async () => {
    const a = await tenant('errh-mapped-404-a');
    const b = await tenant('errh-mapped-404-b');
    const app = buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/orgs/${b.organizationId}/stores`,
        headers: asHeaders(a),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
    } finally {
      await app.close();
    }
  });
});

describe('global error handler — request ids', () => {
  it('two different forced errors get two different request ids', async () => {
    const owner = await tenant('errh-unique-ids');
    const app = buildTestApp();
    const id = randomUUID().replaceAll('-', '_');
    const fn = `test_ids_${id}`;
    await testDb.execute(
      sql.raw(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'boom'; END $$`),
    );
    await testDb.execute(
      sql.raw(`CREATE TRIGGER ${fn} BEFORE INSERT ON audit_log FOR EACH ROW
        WHEN (NEW.organization_id = '${owner.organizationId}')
        EXECUTE FUNCTION ${fn}()`),
    );
    try {
      const first = await app.inject({
        method: 'GET',
        url: `/v1/orgs/${owner.organizationId}/audit-log`,
        headers: asHeaders(owner),
      });
      const second = await app.inject({
        method: 'GET',
        url: `/v1/orgs/${owner.organizationId}/audit-log`,
        headers: asHeaders(owner),
      });
      expect(first.json().request_id).not.toBe(second.json().request_id);
    } finally {
      await testDb.execute(sql.raw(`DROP TRIGGER IF EXISTS ${fn} ON audit_log`));
      await testDb.execute(sql.raw(`DROP FUNCTION IF EXISTS ${fn}()`));
      await app.close();
    }
  });

  it("the handler's own request_id never comes from a client header, whatever request.id happens to be", async () => {
    // registerAuthErrorHandler only ever reads request.id — it has no header-parsing logic of its
    // own — so this proves that half of the property directly, independent of which genReqId
    // strategy produced request.id. (That app.ts's own genReqId in particular can't be swayed by a
    // header is the next test, against the real app.)
    const probe = Fastify({ logger: false });
    registerAuthErrorHandler(probe);
    probe.get('/probe', async () => {
      throw new Error('boom');
    });
    try {
      const planted = 'attacker-chosen-00000000-0000-0000-0000-000000000000';
      const a = await probe.inject({
        method: 'GET',
        url: '/probe',
        headers: { 'x-request-id': planted },
      });
      const b = await probe.inject({
        method: 'GET',
        url: '/probe',
        headers: { 'request-id': planted },
      });
      expect(a.json().request_id).not.toBe(planted);
      expect(b.json().request_id).not.toBe(planted);
      expect(a.json().request_id).not.toBe(b.json().request_id);
    } finally {
      await probe.close();
    }
  });

  it("app.ts's Fastify instance never echoes a client-sent request id (genReqId ignores its argument)", async () => {
    // The same property, exercised through the real app (app.ts's actual genReqId, not a copy of
    // it) rather than a hand-rolled probe — this is what would actually catch a regression if
    // app.ts's genReqId were ever changed to something that reads the incoming request.
    const owner = await tenant('errh-reqid-header');
    const { lines, report } = collectingReporter();
    const app = buildTestApp({ errorReporter: report });
    const id = randomUUID().replaceAll('-', '_');
    const fn = `test_reqid_${id}`;
    await testDb.execute(
      sql.raw(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'boom'; END $$`),
    );
    await testDb.execute(
      sql.raw(`CREATE TRIGGER ${fn} BEFORE INSERT ON audit_log FOR EACH ROW
        WHEN (NEW.organization_id = '${owner.organizationId}')
        EXECUTE FUNCTION ${fn}()`),
    );
    try {
      const planted = 'attacker-chosen-00000000-0000-0000-0000-000000000000';
      const res = await app.inject({
        method: 'GET',
        url: `/v1/orgs/${owner.organizationId}/audit-log`,
        headers: { ...asHeaders(owner), 'x-request-id': planted },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().request_id).not.toBe(planted);
      // A UUID — app.ts's real genReqId, not Fastify's default counter — confirming this exercised
      // the actual production wiring, not an accidental fallback.
      expect(res.json().request_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(lines[0]?.request_id).toBe(res.json().request_id);
    } finally {
      await testDb.execute(sql.raw(`DROP TRIGGER IF EXISTS ${fn} ON audit_log`));
      await testDb.execute(sql.raw(`DROP FUNCTION IF EXISTS ${fn}()`));
      await app.close();
    }
  });
});

describe("global error handler — Fastify's own client errors keep their status and a generic code", () => {
  // These are never database/application errors: Fastify itself rejects the request before any
  // route handler runs, always with a FST_ERR_* code and a real 4xx statusCode (verified
  // empirically). Before the review follow-up to #20, these were real `Error` instances and so fell
  // into the same catch-all as a database failure, downgrading a client mistake (400/413/415) to a
  // 500 — wrong status, and still an opportunity to leak Fastify's own message. Two are exercised
  // through the real app (a route that reaches Fastify's body parser after our own CSRF/content-type
  // hook lets the request through); the other two — unsupported content type and schema validation —
  // are never reachable through this app's real routes (the CSRF hook rejects any non-JSON
  // content-type itself, first, and no route uses Fastify's declarative `schema` option), so they're
  // exercised on an isolated probe with only this handler registered, to prove the handler's own
  // behaviour independent of what our routes happen to expose today.

  it('a malformed JSON body is still 400, with a generic code, not the parser message', async () => {
    const app = buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/orgs',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        payload: '{not valid json',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'bad_request' });
      expect(res.body.toLowerCase()).not.toContain('json');
      expect(res.body).not.toContain('FST_ERR');
    } finally {
      await app.close();
    }
  });

  it('a body over the size limit is still 413, with a generic code', async () => {
    const app = buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/orgs',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'x'.repeat(2 * 1024 * 1024), slug: 'x' }),
      });
      expect(res.statusCode).toBe(413);
      expect(res.json()).toEqual({ error: 'payload_too_large' });
      expect(res.body).not.toContain('FST_ERR');
    } finally {
      await app.close();
    }
  });

  it("an unsupported content type is still 415, with a generic code, not Fastify's message", async () => {
    const probe = Fastify({ logger: false });
    registerAuthErrorHandler(probe);
    probe.post('/probe', async () => ({ ok: true }));
    try {
      const res = await probe.inject({
        method: 'POST',
        url: '/probe',
        headers: { 'content-type': 'application/xml' },
        payload: '<x/>',
      });
      expect(res.statusCode).toBe(415);
      expect(res.json()).toEqual({ error: 'unsupported_media_type' });
      expect(res.body.toLowerCase()).not.toContain('unsupported media type');
    } finally {
      await probe.close();
    }
  });

  it('a schema-validation failure is still 400, with a generic code, not the field-level message', async () => {
    const probe = Fastify({ logger: false });
    registerAuthErrorHandler(probe);
    probe.post(
      '/probe',
      {
        schema: {
          body: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' } },
          },
        },
      },
      async () => ({ ok: true }),
    );
    try {
      const res = await probe.inject({
        method: 'POST',
        url: '/probe',
        headers: { 'content-type': 'application/json' },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'bad_request' });
      expect(res.body).not.toContain('must have required property');
    } finally {
      await probe.close();
    }
  });

  it('none of the four are logged as an unhandled error — they are ordinary client mistakes', async () => {
    const { lines, report } = collectingReporter();
    const probe = Fastify({ logger: false });
    registerAuthErrorHandler(probe, { report });
    probe.post('/probe', async () => ({ ok: true }));
    await probe.inject({
      method: 'POST',
      url: '/probe',
      headers: { 'content-type': 'application/json' },
      payload: '{not valid json',
    });
    await probe.inject({
      method: 'POST',
      url: '/probe',
      headers: { 'content-type': 'application/xml' },
      payload: '<x/>',
    });
    expect(lines).toEqual([]);
    await probe.close();
  });
});
