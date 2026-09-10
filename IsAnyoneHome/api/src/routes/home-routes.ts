import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth.js';
import { database, inTransaction, type Queryable } from '../database.js';
import { ApiError, decryptJson, digest, encryptJson, isPrivateIPv4, opaqueToken } from '../security.js';

type Role = 'owner' | 'admin' | 'member';
type Location = { latitude: number; longitude: number };

const homeBody = z.object({
  name: z.string().trim().min(1).max(80),
  latitude: z.number().finite().gte(-90).lte(90),
  longitude: z.number().finite().gte(-180).lte(180),
  radiusMeters: z.number().int().min(100).max(1_000)
});
const invitationBody = z.object({ role: z.enum(['admin', 'member']).default('member') });
const acceptInvitationBody = z.object({ code: z.string().min(40).max(100) });
const presenceBody = z.object({
  eventId: z.string().uuid(),
  deviceId: z.string().uuid(),
  isPresent: z.boolean(),
  source: z.enum(['region_enter', 'region_exit', 'heartbeat']),
  observedAt: z.string().datetime({ offset: true })
});
const automationBody = z.object({
  name: z.string().trim().min(1).max(80),
  trigger: z.enum(['all_away', 'anyone_arrives']),
  action: z.literal('turn_off_all_lights')
});
const bridgeBody = z.object({
  label: z.string().trim().min(1).max(80),
  host: z.string().trim().min(7).max(15),
  username: z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/)
});

function homeId(request: FastifyRequest): string {
  return z.string().uuid().parse((request.params as { homeId?: string }).homeId);
}

async function memberRole(db: Queryable, userId: string, home: string): Promise<Role> {
  const result = await db.query<{ role: Role }>('SELECT role FROM home_members WHERE home_id = $1 AND user_id = $2', [home, userId]);
  const role = result.rows[0]?.role;
  if (!role) throw new ApiError(404, 'Home not found', 'home_not_found');
  return role;
}

async function requireAdmin(db: Queryable, userId: string, home: string): Promise<void> {
  const role = await memberRole(db, userId, home);
  if (role === 'member') throw new ApiError(403, 'Administrator access required', 'forbidden');
}

function mapHome(row: {
  id: string; name: string; encrypted_location: string; radius_meters: number; role: Role; present_count: number; has_bridge: boolean;
}) {
  const location = decryptJson<Location>(row.encrypted_location);
  return {
    id: row.id,
    name: row.name,
    latitude: location.latitude,
    longitude: location.longitude,
    radiusMeters: row.radius_meters,
    role: row.role,
    presentCount: Number(row.present_count),
    hasBridge: row.has_bridge
  };
}

async function readHome(db: Queryable, userId: string, id: string) {
  const result = await db.query<{
    id: string; name: string; encrypted_location: string; radius_meters: number; role: Role; present_count: number; has_bridge: boolean;
  }>(
    `SELECT h.id, h.name, h.encrypted_location, h.radius_meters, hm.role,
            COUNT(pr.user_id) FILTER (WHERE pr.is_present)::int AS present_count,
            EXISTS(SELECT 1 FROM bridge_configurations bc WHERE bc.home_id = h.id) AS has_bridge
       FROM homes h
       JOIN home_members hm ON hm.home_id = h.id AND hm.user_id = $2
       LEFT JOIN presence_records pr ON pr.home_id = h.id
      WHERE h.id = $1
      GROUP BY h.id, hm.role`,
    [id, userId]
  );
  const row = result.rows[0];
  if (!row) throw new ApiError(404, 'Home not found', 'home_not_found');
  return mapHome(row);
}

async function queueTransitionAutomations(
  db: Queryable,
  home: string,
  trigger: 'all_away' | 'anyone_arrives'
): Promise<void> {
  const rules = await db.query<{ id: string; action: 'turn_off_all_lights' }>(
    'SELECT id, action FROM automation_rules WHERE home_id = $1 AND trigger = $2 AND enabled = true',
    [home, trigger]
  );
  if (rules.rowCount === 0) return;
  const activeRelay = await db.query<{ id: string }>(
    `SELECT r.id FROM relays r
       JOIN bridge_configurations bc ON bc.home_id = r.home_id
      WHERE r.home_id = $1 AND r.revoked_at IS NULL AND r.last_seen_at > now() - interval '5 minutes'
      ORDER BY r.last_seen_at DESC LIMIT 1`,
    [home]
  );
  const relayId = activeRelay.rows[0]?.id ?? null;
  for (const rule of rules.rows) {
    const execution = await db.query<{ id: string }>(
      `INSERT INTO automation_executions (rule_id, home_id, relay_id, action, status, detail)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [rule.id, home, relayId, rule.action, relayId ? 'queued' : 'skipped', relayId ? null : 'No active local relay']
    );
    if (relayId && execution.rows[0]) {
      await db.query(
        'INSERT INTO relay_commands (relay_id, execution_id, action) VALUES ($1, $2, $3)',
        [relayId, execution.rows[0].id, rule.action]
      );
    }
  }
}

export async function registerHomeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get('/v1/homes', async (request) => {
    const homes = await database.query<{
      id: string; name: string; encrypted_location: string; radius_meters: number; role: Role; present_count: number; has_bridge: boolean;
    }>(
      `SELECT h.id, h.name, h.encrypted_location, h.radius_meters, hm.role,
              COUNT(pr.user_id) FILTER (WHERE pr.is_present)::int AS present_count,
              EXISTS(SELECT 1 FROM bridge_configurations bc WHERE bc.home_id = h.id) AS has_bridge
         FROM homes h
         JOIN home_members hm ON hm.home_id = h.id AND hm.user_id = $1
         LEFT JOIN presence_records pr ON pr.home_id = h.id
        GROUP BY h.id, hm.role
        ORDER BY h.created_at ASC`,
      [request.auth.userId]
    );
    return { homes: homes.rows.map(mapHome) };
  });

  app.post('/v1/homes', async (request, reply) => {
    const body = homeBody.parse(request.body);
    const created = await inTransaction(async (db) => {
      const result = await db.query<{ id: string }>(
        `INSERT INTO homes (name, encrypted_location, radius_meters, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [body.name, encryptJson({ latitude: body.latitude, longitude: body.longitude }), body.radiusMeters, request.auth.userId]
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error('Home creation failed');
      await db.query('INSERT INTO home_members (home_id, user_id, role) VALUES ($1, $2, \'owner\')', [id, request.auth.userId]);
      return id;
    });
    return reply.code(201).send(await readHome(database, request.auth.userId, created));
  });

  app.get('/v1/homes/:homeId', async (request) => readHome(database, request.auth.userId, homeId(request)));

  app.get('/v1/homes/:homeId/members', async (request) => {
    const id = homeId(request);
    await memberRole(database, request.auth.userId, id);
    const members = await database.query<{ id: string; display_name: string | null; role: Role; is_present: boolean | null; observed_at: string | null }>(
      `SELECT u.id, u.display_name, hm.role, pr.is_present, pr.observed_at
         FROM home_members hm
         JOIN users u ON u.id = hm.user_id
         LEFT JOIN presence_records pr ON pr.home_id = hm.home_id AND pr.user_id = hm.user_id
        WHERE hm.home_id = $1
        ORDER BY CASE hm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.created_at`,
      [id]
    );
    return { members: members.rows.map((member) => ({
      id: member.id,
      displayName: member.display_name ?? 'Membre',
      role: member.role,
      isPresent: member.is_present ?? false,
      observedAt: member.observed_at
    })) };
  });

  app.post('/v1/homes/:homeId/invitations', async (request, reply) => {
    const id = homeId(request);
    await requireAdmin(database, request.auth.userId, id);
    const body = invitationBody.parse(request.body);
    const code = opaqueToken('HST_');
    await database.query(
      `INSERT INTO invitations (home_id, created_by, role, token_hash, token_hint, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '7 days')`,
      [id, request.auth.userId, body.role, digest(code), code.slice(0, 10)]
    );
    return reply.code(201).send({ code, expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() });
  });

  app.post('/v1/invitations/accept', async (request) => {
    const body = acceptInvitationBody.parse(request.body);
    return inTransaction(async (db) => {
      const invitation = await db.query<{ id: string; home_id: string; role: Role }>(
        `SELECT id, home_id, role FROM invitations
          WHERE token_hash = $1 AND expires_at > now() AND accepted_at IS NULL AND revoked_at IS NULL
          FOR UPDATE`,
        [digest(body.code)]
      );
      const item = invitation.rows[0];
      if (!item) throw new ApiError(404, 'Invitation is invalid or expired', 'invalid_invitation');
      const member = await db.query('SELECT 1 FROM home_members WHERE home_id = $1 AND user_id = $2', [item.home_id, request.auth.userId]);
      if (member.rowCount !== 0) throw new ApiError(409, 'You already belong to this home', 'already_member');
      await db.query('INSERT INTO home_members (home_id, user_id, role) VALUES ($1, $2, $3)', [item.home_id, request.auth.userId, item.role]);
      await db.query('UPDATE invitations SET accepted_by = $1, accepted_at = now() WHERE id = $2', [request.auth.userId, item.id]);
      return readHome(db, request.auth.userId, item.home_id);
    });
  });

  app.post('/v1/homes/:homeId/presence', async (request) => {
    const id = homeId(request);
    const body = presenceBody.parse(request.body);
    if (body.deviceId !== request.auth.deviceId) throw new ApiError(403, 'Device mismatch', 'forbidden');
    const observedAt = new Date(body.observedAt);
    const now = Date.now();
    if (observedAt.getTime() < now - 15 * 60_000 || observedAt.getTime() > now + 5 * 60_000) {
      throw new ApiError(422, 'Presence timestamp is outside the accepted window', 'invalid_timestamp');
    }
    return inTransaction(async (db) => {
      await memberRole(db, request.auth.userId, id);
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [id]);
      const event = await db.query(
        `INSERT INTO presence_events (id, home_id, user_id, device_id, is_present, source, observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [body.eventId, id, request.auth.userId, request.auth.deviceId, body.isPresent, body.source, observedAt]
      );
      if (event.rowCount === 0) return { accepted: true, duplicate: true };
      const before = await db.query<{ occupied: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM presence_records pr JOIN home_members hm ON hm.home_id = pr.home_id AND hm.user_id = pr.user_id
            WHERE pr.home_id = $1 AND pr.is_present
         ) AS occupied`,
        [id]
      );
      const update = await db.query(
        `INSERT INTO presence_records (home_id, user_id, is_present, observed_at, device_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (home_id, user_id) DO UPDATE SET
           is_present = EXCLUDED.is_present, observed_at = EXCLUDED.observed_at, device_id = EXCLUDED.device_id
         WHERE presence_records.observed_at <= EXCLUDED.observed_at
         RETURNING home_id`,
        [id, request.auth.userId, body.isPresent, observedAt, request.auth.deviceId]
      );
      if (update.rowCount === 0) return { accepted: true, stale: true };
      const after = await db.query<{ occupied: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM presence_records pr JOIN home_members hm ON hm.home_id = pr.home_id AND hm.user_id = pr.user_id
            WHERE pr.home_id = $1 AND pr.is_present
         ) AS occupied`,
        [id]
      );
      if (before.rows[0]?.occupied && !after.rows[0]?.occupied) await queueTransitionAutomations(db, id, 'all_away');
      if (!before.rows[0]?.occupied && after.rows[0]?.occupied) await queueTransitionAutomations(db, id, 'anyone_arrives');
      return { accepted: true, occupied: after.rows[0]?.occupied ?? false };
    });
  });

  app.get('/v1/homes/:homeId/automations', async (request) => {
    const id = homeId(request);
    await memberRole(database, request.auth.userId, id);
    const rules = await database.query<{ id: string; name: string; trigger: string; action: string; enabled: boolean }>(
      'SELECT id, name, trigger, action, enabled FROM automation_rules WHERE home_id = $1 ORDER BY created_at DESC', [id]
    );
    return { automations: rules.rows.map((rule) => ({ id: rule.id, name: rule.name, trigger: rule.trigger, action: rule.action, enabled: rule.enabled })) };
  });

  app.post('/v1/homes/:homeId/automations', async (request, reply) => {
    const id = homeId(request);
    await requireAdmin(database, request.auth.userId, id);
    const body = automationBody.parse(request.body);
    const automation = await database.query<{ id: string; name: string; trigger: string; action: string; enabled: boolean }>(
      `INSERT INTO automation_rules (home_id, name, trigger, action, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, trigger, action, enabled`,
      [id, body.name, body.trigger, body.action, request.auth.userId]
    );
    return reply.code(201).send(automation.rows[0]);
  });

  app.post('/v1/homes/:homeId/bridge', async (request, reply) => {
    const id = homeId(request);
    await requireAdmin(database, request.auth.userId, id);
    const body = bridgeBody.parse(request.body);
    if (!isPrivateIPv4(body.host)) throw new ApiError(422, 'The bridge must use a private IPv4 address', 'invalid_bridge_host');
    await database.query(
      `INSERT INTO bridge_configurations (home_id, label, encrypted_config, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (home_id) DO UPDATE SET label = EXCLUDED.label, encrypted_config = EXCLUDED.encrypted_config,
         created_by = EXCLUDED.created_by, updated_at = now()`,
      [id, body.label, encryptJson({ host: body.host, username: body.username }), request.auth.userId]
    );
    return reply.code(201).send({ linked: true });
  });

  app.post('/v1/homes/:homeId/relay-enrollments', async (request, reply) => {
    const id = homeId(request);
    await requireAdmin(database, request.auth.userId, id);
    const bridge = await database.query('SELECT 1 FROM bridge_configurations WHERE home_id = $1', [id]);
    if (bridge.rowCount === 0) throw new ApiError(409, 'Link a lighting bridge first', 'bridge_required');
    const code = opaqueToken('RLY_');
    await database.query(
      `INSERT INTO relay_enrollments (home_id, token_hash, expires_at, created_by)
       VALUES ($1, $2, now() + interval '15 minutes', $3)`,
      [id, digest(code), request.auth.userId]
    );
    return reply.code(201).send({ code, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
  });
}

export { decryptJson };
