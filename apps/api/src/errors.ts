import { APIError } from 'better-auth/api';
import type { FastifyReply } from 'fastify';

/** Translates a Better Auth APIError into a Fastify response instead of a bare 500. */
export async function sendAuthApiError(reply: FastifyReply, error: unknown): Promise<void> {
  if (error instanceof APIError) {
    await reply.code(error.statusCode).send({ error: error.body?.code ?? 'auth_error' });
    return;
  }
  throw error;
}

/** Copies a Fetch API Response (status, headers incl. Set-Cookie, body) onto a Fastify reply. */
export async function forwardResponse(reply: FastifyReply, response: Response): Promise<void> {
  reply.code(response.status);
  response.headers.forEach((value, key) => reply.header(key, value));
  await reply.send(response.body ? await response.text() : null);
}
