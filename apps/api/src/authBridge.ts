import { toNodeHandler } from 'better-auth/node';
import type { FastifyReply, FastifyRequest } from 'fastify';

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
