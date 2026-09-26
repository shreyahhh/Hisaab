import type { FastifyInstance, FastifyReply } from 'fastify';
import { AuthApiError } from './authCall.js';

/** Maps an uncaught AuthApiError to Better Auth's status with the `{ error: <code> }` body. */
export function registerAuthErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof AuthApiError) {
      await reply.code(error.statusCode).send({ error: error.code });
      return;
    }
    // Not ours: hand it back to Fastify's default handling.
    throw error;
  });
}

/** Copies a Fetch API Response (status, headers incl. Set-Cookie, body) onto a Fastify reply. */
export async function forwardResponse(reply: FastifyReply, response: Response): Promise<void> {
  reply.code(response.status);
  response.headers.forEach((value, key) => reply.header(key, value));
  await reply.send(response.body ? await response.text() : null);
}
