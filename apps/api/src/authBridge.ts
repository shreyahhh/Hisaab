import type { IncomingMessage } from 'node:http';
import { toNodeHandler } from 'better-auth/node';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AUTH_BASE_PATH, EXPOSED_AUTH_ROUTES } from '@truepath/auth';

// Better Auth's own Node integration (better-auth/node's toNodeHandler) operates directly on the
// raw Node req/res, so Fastify's body parser never touches — and can't double-parse or drop — a
// non-JSON auth payload. Kept structurally typed against `{ handler }` rather than importing
// @truepath/auth's concrete Auth type, so this bridge has no build-order dependency on
// packages/auth.
export interface AuthHandlerLike {
  handler: (request: Request) => Promise<Response>;
}

export async function bridgeToBetterAuth(
  auth: AuthHandlerLike,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.hijack();
  // Issue #16: Fastify's own content-type parser already drains `request.raw`'s stream for any
  // route it registers (it must, to build `request.body`), so by the time this handler runs, the
  // raw Node stream has nothing left for better-call's getRequest() to read — every bridged POST
  // with a body failed `[body] Invalid input: expected object, received undefined`, because
  // getRequest() only falls back to a *plain* `.body` property on the object it's given when the
  // stream can't be read (better-call/dist/adapters/node/request.mjs's canReadRawBody/
  // maybeConsumedReq.body), and Fastify never attaches `.body` to `request.raw` — only to its own
  // `FastifyRequest` wrapper. Attaching it here is the one thing that fallback needs and Fastify
  // doesn't give it, for exactly the routes that need a body (GET/HEAD never reach this: Fastify
  // does not parse a body for them, so `request.body` stays undefined and this is a no-op).
  (request.raw as IncomingMessage & { body?: unknown }).body = request.body;
  await toNodeHandler(auth)(request.raw, reply.raw);
}

/**
 * Registers one Fastify route per entry in EXPOSED_AUTH_ROUTES, and nothing else — there is no
 * wildcard, so a Better Auth endpoint we haven't listed (including one a future upgrade or plugin
 * adds) is not routed. Fastify mirrors each GET with a HEAD.
 */
export function registerAuthBridge(app: FastifyInstance, auth: AuthHandlerLike): void {
  for (const route of EXPOSED_AUTH_ROUTES) {
    app.route({
      method: route.method,
      url: `${AUTH_BASE_PATH}${route.path}`,
      handler: (request, reply) => bridgeToBetterAuth(auth, request, reply),
    });
  }
}
