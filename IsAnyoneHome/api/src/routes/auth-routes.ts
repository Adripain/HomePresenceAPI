import type { FastifyInstance } from 'fastify';
import { appleSignIn, authenticate, deleteAccount, refreshSession, revokeCurrentSession } from '../auth.js';

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/auth/apple', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const session = await appleSignIn(request.body);
    return reply.code(201).send(session);
  });

  app.post('/v1/auth/refresh', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => {
    return refreshSession(request.body);
  });

  app.delete('/v1/auth/session', { preHandler: authenticate }, async (request, reply) => {
    await revokeCurrentSession(request);
    return reply.code(204).send();
  });

  app.delete('/v1/account', { preHandler: authenticate }, async (request, reply) => {
    await deleteAccount(request);
    return reply.code(204).send();
  });
}
