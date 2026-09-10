import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { config } from './config.js';
import { database } from './database.js';
import { ApiError } from './security.js';
import { registerAuthRoutes } from './routes/auth-routes.js';
import { registerHomeRoutes } from './routes/home-routes.js';
import { registerRelayRoutes } from './routes/relay-routes.js';

const app = Fastify({
  trustProxy: config.TRUST_PROXY,
  bodyLimit: 32 * 1024,
  logger: {
    level: config.NODE_ENV === 'production' ? 'info' : 'debug',
    redact: ['req.headers.authorization', 'req.body.identityToken', 'req.body.refreshToken', 'req.body.code', 'req.body.username']
  },
  disableRequestLogging: config.NODE_ENV === 'production'
});

await app.register(helmet, {
  global: true,
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
});
await app.register(rateLimit, {
  global: true,
  max: 120,
  timeWindow: '1 minute',
  hook: 'onRequest',
  keyGenerator: (request) => request.ip
});

app.get('/healthz', async () => {
  await database.query('SELECT 1');
  return { ok: true };
});

await app.register(registerAuthRoutes);
await app.register(registerHomeRoutes);
await app.register(registerRelayRoutes);

app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found' }));
app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ZodError) return reply.code(422).send({ error: 'invalid_request' });
  if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: error.code });
  if ((error as { code?: string }).code === '23505') return reply.code(409).send({ error: 'conflict' });
  app.log.error(error);
  return reply.code(500).send({ error: 'internal_error' });
});

const close = async (signal: string) => {
  app.log.info({ signal }, 'Shutting down');
  await app.close();
  await database.end();
  process.exit(0);
};
process.once('SIGINT', () => void close('SIGINT'));
process.once('SIGTERM', () => void close('SIGTERM'));

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
