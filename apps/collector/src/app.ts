import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { COLLECT_MAX_BODY_BYTES, SUPPRESS_READY_KEY } from '@truepath/shared';
import { handleCollect, type CollectDeps, type CollectResult } from './collect.js';

// The Collector's HTTP surface (collector.md §2.1). Fastify only adapts requests to `handleCollect`
// and results back to status codes; the rules live there.
//
// Logging (collector.md §6): one structured line per request with store id, status, reason and
// latency. Never the body, the query string (it carries the signature), the visitor id, the IP or the
// user agent — the framework's own request logger is off for exactly that reason.

export interface CollectorAppDeps extends Omit<CollectDeps, 'redis'> {
  readonly redis: Redis;
  /** One JSON line per request. Defaults to stdout. */
  readonly log?: (line: Record<string, unknown>) => void;
}

const defaultLog = (line: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

export function buildCollectorApp(deps: CollectorAppDeps): FastifyInstance {
  const log = deps.log ?? defaultLog;

  const app = Fastify({
    // Off entirely: the framework's request logger would print the URL, and so the signature.
    logger: false,
    // 10,240 bytes (SPEC §7.2). Larger bodies get 413 before they are read into memory.
    bodyLimit: COLLECT_MAX_BODY_BYTES,
    // Exactly one proxy hop is trusted — the ALB (collector.md §4 step 9). More would let a client
    // spoof its address and dodge the per-IP limit; fewer would rate-limit every shopper as the ALB.
    // Written as a function (hop 0 only) because Fastify's types don't accept the hop-count number
    // that proxy-addr does at runtime.
    trustProxy: (_address: string, hop: number) => hop === 0,
  });

  // The pixel posts `text/plain` (a CORS "simple request", so no preflight); `application/json` is
  // also accepted. Both arrive as the raw string, because the signature covers the raw bytes.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    ['text/plain', 'application/json'],
    { parseAs: 'string' },
    (_request, body, done) => {
      done(null, body);
    },
  );

  const results = new WeakMap<FastifyRequest, CollectResult>();
  const startedAt = new WeakMap<FastifyRequest, bigint>();

  app.addHook('onRequest', async (request, reply) => {
    startedAt.set(request, process.hrtime.bigint());
    // Every response: HSTS (S-1), and the CORS answer. The request's Origin is `null` from the pixel
    // sandbox, hence `*`; no credentials are ever involved and the Collector sets no cookies.
    void reply
      .header('strict-transport-security', 'max-age=31536000; includeSubDomains')
      .header('access-control-allow-origin', '*')
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-store');
  });

  app.addHook('onResponse', async (request, reply) => {
    if (!request.url.startsWith('/v1/collect')) return;
    const result = results.get(request);
    const began = startedAt.get(request);
    log({
      event: 'collect',
      store_id: result?.storeId,
      status: reply.statusCode,
      ...(result?.error ? { reason: result.error } : {}),
      accepted: result?.accepted ?? 0,
      dropped: result?.dropped ?? {},
      ms: began ? Number((process.hrtime.bigint() - began) / 1_000_000n) : undefined,
    });
  });

  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: 'not_found' }));

  app.setErrorHandler(
    async (error: Error & { code?: string; statusCode?: number }, request, reply) => {
      if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
        results.set(request, { status: 400, accepted: 0, dropped: {} });
        return reply.code(413).send({ error: 'payload_too_large' });
      }
      const status = error.statusCode;
      if (status !== undefined && status >= 400 && status < 500) {
        // Bad content type, malformed request line, and the like.
        return reply.code(400).send({ error: 'invalid_payload' });
      }
      // Anything else: the message can hold arbitrary data, so log only the error's name.
      log({ event: 'collect_unhandled_error', error: error.name });
      return reply.code(500).send({ error: 'internal' });
    },
  );

  app.options('/v1/collect', async (_request, reply) =>
    reply
      .code(204)
      .header('access-control-allow-methods', 'POST, OPTIONS')
      .header('access-control-allow-headers', 'content-type')
      .header('access-control-max-age', '86400')
      .send(),
  );

  app.post<{ Querystring: { k?: string; ts?: string; kid?: string; sig?: string } }>(
    '/v1/collect',
    async (request, reply) => {
      const result = await handleCollect(
        { ...deps },
        {
          query: request.query,
          rawBody: typeof request.body === 'string' ? request.body : '',
          origin: request.headers.origin,
          ip: request.ip,
          userAgent: request.headers['user-agent'],
        },
      );
      results.set(request, result);
      if (result.status === 204) return reply.code(204).send();
      return reply.code(result.status).send({ error: result.error });
    },
  );

  app.get('/healthz', async () => ({ status: 'ok' }));

  // Ready only when it can actually take traffic: durable Redis reachable AND the suppression set
  // marked ready (else every request would be a 503 — HLD §8 fail closed) AND geo loaded.
  app.get('/readyz', async (_request, reply) => {
    let redisOk = false;
    let suppressionReady = false;
    try {
      redisOk = (await deps.redis.ping()) === 'PONG';
      suppressionReady =
        redisOk && (await deps.redis.exists(deps.redisKeys?.ready ?? SUPPRESS_READY_KEY)) === 1;
    } catch {
      // stays false
    }
    const geoReady = deps.geo.ready;
    const ready = redisOk && suppressionReady && geoReady;
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      redis: redisOk,
      suppression: suppressionReady,
      geo: geoReady,
    });
  });

  return app;
}
