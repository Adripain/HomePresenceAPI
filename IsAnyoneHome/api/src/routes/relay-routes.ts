import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { database, inTransaction } from '../database.js';
import { decryptJson, ApiError, digest, opaqueToken } from '../security.js';

type Relay = { relayId: string; homeId: string };
type BridgeConfig = { host: string; username: string };

declare module 'fastify' {
  interface FastifyRequest {
    relay: Relay;
  }
}

const claimBody = z.object({ code: z.string().min(40).max(100), name: z.string().trim().min(1).max(80) });
const completionBody = z.object({ status: z.enum(['completed', 'failed']), error: z.string().trim().max(300).optional() });

async function authenticateRelay(request: FastifyRequest): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Relay ')) throw new ApiError(401, 'Relay authentication required', 'relay_unauthorized');
  const relay = await database.query<{ id: string; home_id: string }>(
    'SELECT id, home_id FROM relays WHERE secret_hash = $1 AND revoked_at IS NULL',
    [digest(header.slice(6))]
  );
  const item = relay.rows[0];
  if (!item) throw new ApiError(401, 'Relay authentication required', 'relay_unauthorized');
  request.relay = { relayId: item.id, homeId: item.home_id };
}

export async function registerRelayRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/relays/claim', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = claimBody.parse(request.body);
    const claimed = await inTransaction(async (db) => {
      const enrollment = await db.query<{ id: string; home_id: string }>(
        `SELECT id, home_id FROM relay_enrollments
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
          FOR UPDATE`,
        [digest(body.code)]
      );
      const item = enrollment.rows[0];
      if (!item) throw new ApiError(404, 'Enrollment code is invalid or expired', 'invalid_enrollment');
      const secret = opaqueToken('rls_');
      const relay = await db.query<{ id: string }>(
        'INSERT INTO relays (home_id, name, secret_hash) VALUES ($1, $2, $3) RETURNING id',
        [item.home_id, body.name, digest(secret)]
      );
      await db.query('UPDATE relay_enrollments SET used_at = now() WHERE id = $1', [item.id]);
      return { relayId: relay.rows[0]?.id, secret };
    });
    return reply.code(201).send(claimed);
  });

  app.post('/v1/relay/heartbeat', { preHandler: authenticateRelay }, async (request) => {
    await database.query('UPDATE relays SET last_seen_at = now() WHERE id = $1', [request.relay.relayId]);
    return { ok: true };
  });

  app.get('/v1/relay/config', { preHandler: authenticateRelay }, async (request) => {
    const config = await database.query<{ encrypted_config: string }>(
      'SELECT encrypted_config FROM bridge_configurations WHERE home_id = $1', [request.relay.homeId]
    );
    const encrypted = config.rows[0]?.encrypted_config;
    if (!encrypted) throw new ApiError(409, 'No lighting bridge configured', 'bridge_required');
    await database.query('UPDATE relays SET last_seen_at = now() WHERE id = $1', [request.relay.relayId]);
    return { bridge: decryptJson<BridgeConfig>(encrypted) };
  });

  app.get('/v1/relay/commands/next', { preHandler: authenticateRelay }, async (request, reply) => {
    const command = await inTransaction(async (db) => {
      const next = await db.query<{ id: string; action: 'turn_off_all_lights'; execution_id: string }>(
        `SELECT id, action, execution_id FROM relay_commands
          WHERE relay_id = $1 AND status = 'queued'
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED LIMIT 1`,
        [request.relay.relayId]
      );
      const item = next.rows[0];
      if (!item) return null;
      await db.query(
        `UPDATE relay_commands SET status = 'delivering', attempts = attempts + 1, delivered_at = now()
          WHERE id = $1`,
        [item.id]
      );
      await db.query('UPDATE relays SET last_seen_at = now() WHERE id = $1', [request.relay.relayId]);
      return { id: item.id, executionId: item.execution_id, action: item.action };
    });
    if (!command) return reply.code(204).send();
    return command;
  });

  app.post('/v1/relay/commands/:commandId/complete', { preHandler: authenticateRelay }, async (request) => {
    const commandId = z.string().uuid().parse((request.params as { commandId?: string }).commandId);
    const body = completionBody.parse(request.body);
    const command = await inTransaction(async (db) => {
      const result = await db.query<{ execution_id: string }>(
        `UPDATE relay_commands SET status = $1, completed_at = now(), error = $2
          WHERE id = $3 AND relay_id = $4 AND status = 'delivering'
          RETURNING execution_id`,
        [body.status, body.error ?? null, commandId, request.relay.relayId]
      );
      const item = result.rows[0];
      if (!item) throw new ApiError(404, 'Command not found', 'command_not_found');
      await db.query(
        `UPDATE automation_executions SET status = $1, detail = $2, completed_at = now()
          WHERE id = $3`,
        [body.status, body.error ?? null, item.execution_id]
      );
      return item;
    });
    return { id: command.execution_id, status: body.status };
  });
}
