import type { FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import { config } from './config.js';
import { database, inTransaction, type Queryable } from './database.js';
import { ApiError, digest, opaqueToken } from './security.js';

const appleKeys = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));
const jwtKey = new Uint8Array(config.sessionKey);

export type AuthenticatedUser = { userId: string; deviceId: string };

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthenticatedUser;
  }
}

const signInBody = z.object({
  identityToken: z.string().min(100).max(12_000),
  deviceId: z.string().uuid(),
  displayName: z.string().trim().min(1).max(80).optional()
});

const refreshBody = z.object({
  refreshToken: z.string().min(32).max(256),
  deviceId: z.string().uuid()
});

export type SessionPayload = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

async function accessToken(userId: string, deviceId: string): Promise<string> {
  return new SignJWT({ deviceId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('presence-api')
    .setAudience('presence-ios')
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(jwtKey);
}

async function issueSession(userId: string, deviceId: string, db: Queryable = database): Promise<SessionPayload> {
  const refreshToken = opaqueToken('r_');
  await db.query(
    `INSERT INTO refresh_sessions (user_id, device_id, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '30 days')`,
    [userId, deviceId, digest(refreshToken)]
  );
  return { accessToken: await accessToken(userId, deviceId), refreshToken, expiresIn: 900 };
}

export async function authenticate(request: FastifyRequest): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new ApiError(401, 'Authentication required', 'unauthorized');
  try {
    const { payload } = await jwtVerify(header.slice(7), jwtKey, {
      issuer: 'presence-api',
      audience: 'presence-ios'
    });
    const userId = payload.sub;
    const deviceId = payload.deviceId;
    if (typeof userId !== 'string' || typeof deviceId !== 'string') throw new Error('Invalid claims');
    const device = await database.query(
      'SELECT 1 FROM devices WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
      [deviceId, userId]
    );
    if (device.rowCount !== 1) throw new Error('Revoked device');
    request.auth = { userId, deviceId };
  } catch {
    throw new ApiError(401, 'Authentication required', 'unauthorized');
  }
}

export async function appleSignIn(body: unknown): Promise<SessionPayload> {
  const parsed = signInBody.parse(body);
  let subject: string;
  try {
    const { payload } = await jwtVerify(parsed.identityToken, appleKeys, {
      issuer: 'https://appleid.apple.com',
      audience: config.APPLE_CLIENT_ID
    });
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new Error('Missing subject');
    subject = payload.sub;
  } catch {
    throw new ApiError(401, 'Apple identity could not be verified', 'invalid_apple_identity');
  }

  const result = await database.query<{ id: string }>(
    `INSERT INTO users (apple_subject, display_name)
     VALUES ($1, $2)
     ON CONFLICT (apple_subject) DO UPDATE
       SET display_name = COALESCE(users.display_name, EXCLUDED.display_name)
     RETURNING id`,
    [subject, parsed.displayName ?? null]
  );
  const userId = result.rows[0]?.id;
  if (!userId) throw new Error('Unable to create user');

  const device = await database.query<{ user_id: string }>('SELECT user_id FROM devices WHERE id = $1', [parsed.deviceId]);
  if (device.rowCount === 0) {
    await database.query('INSERT INTO devices (id, user_id) VALUES ($1, $2)', [parsed.deviceId, userId]);
  } else if (device.rows[0]?.user_id !== userId) {
    throw new ApiError(409, 'This installation is already linked to another account', 'device_already_linked');
  } else {
    await database.query('UPDATE devices SET last_seen_at = now(), revoked_at = NULL WHERE id = $1', [parsed.deviceId]);
  }
  return issueSession(userId, parsed.deviceId);
}

export async function refreshSession(body: unknown): Promise<SessionPayload> {
  const parsed = refreshBody.parse(body);
  const oldHash = digest(parsed.refreshToken);
  return inTransaction(async (db) => {
    const session = await db.query<{ id: string; user_id: string; device_id: string }>(
      `SELECT id, user_id, device_id FROM refresh_sessions
       WHERE token_hash = $1 AND device_id = $2 AND revoked_at IS NULL AND expires_at > now()
       FOR UPDATE`,
      [oldHash, parsed.deviceId]
    );
    const item = session.rows[0];
    if (!item) throw new ApiError(401, 'Session expired', 'session_expired');
    await db.query('UPDATE refresh_sessions SET revoked_at = now(), last_used_at = now() WHERE id = $1', [item.id]);
    return issueSession(item.user_id, item.device_id, db);
  });
}

export async function revokeCurrentSession(request: FastifyRequest): Promise<void> {
  await database.query(
    'UPDATE refresh_sessions SET revoked_at = now() WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL',
    [request.auth.userId, request.auth.deviceId]
  );
}

export async function deleteAccount(request: FastifyRequest): Promise<void> {
  await inTransaction(async (db) => {
    const ownedHomes = await db.query<{ id: string }>('SELECT id FROM homes WHERE created_by = $1 FOR UPDATE', [request.auth.userId]);
    for (const home of ownedHomes.rows) {
      const successor = await db.query<{ user_id: string }>(
        `SELECT user_id FROM home_members
          WHERE home_id = $1 AND user_id <> $2
          ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, joined_at ASC
          LIMIT 1`,
        [home.id, request.auth.userId]
      );
      const successorID = successor.rows[0]?.user_id;
      if (!successorID) {
        await db.query('DELETE FROM homes WHERE id = $1', [home.id]);
        continue;
      }
      await db.query('UPDATE homes SET created_by = $1, updated_at = now() WHERE id = $2', [successorID, home.id]);
      await db.query('UPDATE home_members SET role = \'member\' WHERE home_id = $1 AND user_id = $2', [home.id, request.auth.userId]);
      await db.query('UPDATE home_members SET role = \'owner\' WHERE home_id = $1 AND user_id = $2', [home.id, successorID]);
      await db.query('UPDATE automation_rules SET created_by = $1 WHERE home_id = $2 AND created_by = $3', [successorID, home.id, request.auth.userId]);
      await db.query('UPDATE invitations SET created_by = $1 WHERE home_id = $2 AND created_by = $3', [successorID, home.id, request.auth.userId]);
      await db.query('UPDATE bridge_configurations SET created_by = $1 WHERE home_id = $2 AND created_by = $3', [successorID, home.id, request.auth.userId]);
      await db.query('UPDATE relay_enrollments SET created_by = $1 WHERE home_id = $2 AND created_by = $3', [successorID, home.id, request.auth.userId]);
    }
    // The user may have created resources in homes they do not own. Attribute
    // those retained resources to the current home owner before deletion.
    await db.query(
      `UPDATE automation_rules ar SET created_by = h.created_by FROM homes h
        WHERE ar.home_id = h.id AND ar.created_by = $1`, [request.auth.userId]
    );
    await db.query(
      `UPDATE invitations i SET created_by = h.created_by FROM homes h
        WHERE i.home_id = h.id AND i.created_by = $1`, [request.auth.userId]
    );
    await db.query(
      `UPDATE bridge_configurations bc SET created_by = h.created_by FROM homes h
        WHERE bc.home_id = h.id AND bc.created_by = $1`, [request.auth.userId]
    );
    await db.query(
      `UPDATE relay_enrollments re SET created_by = h.created_by FROM homes h
        WHERE re.home_id = h.id AND re.created_by = $1`, [request.auth.userId]
    );
    await db.query('UPDATE invitations SET accepted_by = NULL WHERE accepted_by = $1', [request.auth.userId]);
    await db.query('DELETE FROM users WHERE id = $1', [request.auth.userId]);
  });
}
