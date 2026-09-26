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
