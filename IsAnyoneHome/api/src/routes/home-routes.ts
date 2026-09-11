import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth.js';
import { database, inTransaction, type Queryable } from '../database.js';
import { sendPresenceNotifications } from '../push.js';
import { ApiError, decryptJson, digest, encryptJson, opaqueToken } from '../security.js';

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
const notificationPreferencesBody = z.object({
  arrivals: z.boolean(),
  departures: z.boolean(),
  homeEmpty: z.boolean()
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
  id: string; name: string; encrypted_location: string; radius_meters: number; role: Role; present_count: number;
}) {
  const location = decryptJson<Location>(row.encrypted_location);
  return {
    id: row.id,
    name: row.name,
    latitude: location.latitude,
    longitude: location.longitude,
    radiusMeters: row.radius_meters,
    role: row.role,
    presentCount: Number(row.present_count)
  };
}

async function readHome(db: Queryable, userId: string, id: string) {
  const result = await db.query<{
    id: string; name: string; encrypted_location: string; radius_meters: number; role: Role; present_count: number;
  }>(
    `SELECT h.id, h.name, h.encrypted_location, h.radius_meters, hm.role,
            COUNT(pr.user_id) FILTER (WHERE pr.is_present)::int AS present_count
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

export async function registerHomeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get('/v1/homes', async (request) => {
    const homes = await database.query<{
      id: string; name: string; encrypted_location: string; radius_meters: number; role: Role; present_count: number;
    }>(
      `SELECT h.id, h.name, h.encrypted_location, h.radius_meters, hm.role,
              COUNT(pr.user_id) FILTER (WHERE pr.is_present)::int AS present_count
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

  app.get('/v1/homes/:homeId/notification-preferences', async (request) => {
    const id = homeId(request);
    await memberRole(database, request.auth.userId, id);
    const result = await database.query<{
      notify_on_arrival: boolean; notify_on_departure: boolean; notify_when_empty: boolean;
    }>(
      `SELECT notify_on_arrival, notify_on_departure, notify_when_empty
         FROM home_notification_preferences WHERE home_id = $1 AND user_id = $2`,
      [id, request.auth.userId]
    );
    const preferences = result.rows[0];
    return {
      arrivals: preferences?.notify_on_arrival ?? false,
      departures: preferences?.notify_on_departure ?? false,
      homeEmpty: preferences?.notify_when_empty ?? false
    };
  });

  app.put('/v1/homes/:homeId/notification-preferences', async (request) => {
    const id = homeId(request);
    await memberRole(database, request.auth.userId, id);
    const body = notificationPreferencesBody.parse(request.body);
    await database.query(
      `INSERT INTO home_notification_preferences
         (home_id, user_id, notify_on_arrival, notify_on_departure, notify_when_empty)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (home_id, user_id) DO UPDATE SET
         notify_on_arrival = EXCLUDED.notify_on_arrival,
         notify_on_departure = EXCLUDED.notify_on_departure,
         notify_when_empty = EXCLUDED.notify_when_empty,
         updated_at = now()`,
      [id, request.auth.userId, body.arrivals, body.departures, body.homeEmpty]
    );
    return body;
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
    const result = await inTransaction(async (db) => {
      await memberRole(db, request.auth.userId, id);
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [id]);
      const event = await db.query(
        `INSERT INTO presence_events (id, home_id, user_id, device_id, is_present, source, observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [body.eventId, id, request.auth.userId, request.auth.deviceId, body.isPresent, body.source, observedAt]
      );
      if (event.rowCount === 0) return { accepted: true, duplicate: true };
      const previous = await db.query<{ is_present: boolean }>(
        'SELECT is_present FROM presence_records WHERE home_id = $1 AND user_id = $2',
        [id, request.auth.userId]
      );
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
      const arrived = body.isPresent && previous.rows[0]?.is_present !== true;
      const departed = !body.isPresent && previous.rows[0]?.is_present === true;
      if (!arrived && !departed) return { accepted: true, occupied: after.rows[0]?.occupied ?? false };
      const labels = await db.query<{ home_name: string; display_name: string | null }>(
        `SELECT h.name AS home_name, u.display_name
           FROM homes h JOIN users u ON u.id = $2 WHERE h.id = $1`,
        [id, request.auth.userId]
      );
      return {
        accepted: true,
        occupied: after.rows[0]?.occupied ?? false,
        notification: {
          homeName: labels.rows[0]?.home_name ?? 'Domicile',
          memberName: labels.rows[0]?.display_name ?? 'Un membre',
          arrived,
          departed,
          becameEmpty: Boolean(before.rows[0]?.occupied && !after.rows[0]?.occupied)
        }
      };
    });
    if ('notification' in result && result.notification) {
      void sendPresenceNotifications({ homeID: id, ...result.notification }).catch((error: unknown) => {
        app.log.error({ err: error, homeID: id }, 'Unable to send presence notification');
      });
    }
    return result;
  });
}

export { decryptJson };
