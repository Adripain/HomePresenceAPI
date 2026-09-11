import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth.js';
import { database, inTransaction } from '../database.js';
import { digest, encryptJson } from '../security.js';

const pushTokenBody = z.object({
  token: z.string().regex(/^[0-9a-f]{64,400}$/i),
  environment: z.enum(['sandbox', 'production']),
  language: z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/).max(35)
});

export async function registerDeviceRoutes(app: FastifyInstance): Promise<void> {
  app.put('/v1/devices/push-token', { preHandler: authenticate }, async (request, reply) => {
    const body = pushTokenBody.parse(request.body);
    await inTransaction(async (db) => {
      // A token belongs to one installation at a time. Clearing an old row
      // prevents duplicate alerts after an app reinstall.
      await db.query(
        'UPDATE devices SET push_token_encrypted = NULL, push_token_hash = NULL, push_environment = NULL, push_language = NULL WHERE push_token_hash = $1 AND id <> $2',
        [digest(body.token), request.auth.deviceId]
      );
      await db.query(
        `UPDATE devices SET push_token_encrypted = $1, push_token_hash = $2,
         push_environment = $3, push_language = $4, last_seen_at = now()
          WHERE id = $5 AND user_id = $6 AND revoked_at IS NULL`,
        [encryptJson({ token: body.token }), digest(body.token), body.environment, body.language, request.auth.deviceId, request.auth.userId]
      );
    });
    return reply.code(204).send();
  });

  app.delete('/v1/devices/push-token', { preHandler: authenticate }, async (request, reply) => {
    await database.query(
      'UPDATE devices SET push_token_encrypted = NULL, push_token_hash = NULL, push_environment = NULL, push_language = NULL WHERE id = $1 AND user_id = $2',
      [request.auth.deviceId, request.auth.userId]
    );
    return reply.code(204).send();
  });
}
