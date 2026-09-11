import * as http2 from 'node:http2';
import { importPKCS8, SignJWT } from 'jose';
import { config } from './config.js';
import { database } from './database.js';
import { decryptJson } from './security.js';

type PushEnvironment = 'sandbox' | 'production';
type PresenceEvent = 'arrival' | 'departure' | 'empty';

type PushRecipient = {
  token: string;
  tokenHash: string;
  environment: PushEnvironment;
  language: string;
  event: PresenceEvent;
};

type EncryptedPushRecipient = {
  encrypted_token: string;
  token_hash: string;
  environment: PushEnvironment;
  language: string | null;
  event: PresenceEvent;
};

let cachedProviderToken: { value: string; createdAt: number } | undefined;
let signingKey: Awaited<ReturnType<typeof importPKCS8>> | undefined;

async function providerToken(): Promise<string> {
  if (!config.apns) throw new Error('APNs is not configured');
  const now = Date.now();
  if (cachedProviderToken && now - cachedProviderToken.createdAt < 50 * 60_000) {
    return cachedProviderToken.value;
  }
  signingKey ??= await importPKCS8(
    Buffer.from(config.apns.privateKeyBase64, 'base64').toString('utf8'),
    'ES256'
  );
  const value = await new SignJWT()
    .setProtectedHeader({ alg: 'ES256', kid: config.apns.keyID })
    .setIssuer(config.apns.teamID)
    .setIssuedAt()
    .sign(signingKey);
  cachedProviderToken = { value, createdAt: now };
  return value;
}

async function sendToAPNs(
  recipient: PushRecipient,
  payload: Record<string, unknown>
): Promise<{ invalidTokenHash?: string }> {
  const apns = config.apns;
  if (!apns) return {};
  const authorization = await providerToken();
  const authority = recipient.environment === 'sandbox'
    ? 'https://api.sandbox.push.apple.com'
    : 'https://api.push.apple.com';
  return new Promise((resolve, reject) => {
    const client = http2.connect(authority);
    let completed = false;
    const finish = (result: { invalidTokenHash?: string } | Error) => {
      if (completed) return;
      completed = true;
      client.close();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    client.once('error', (error) => finish(error));
    const request = client.request({
      ':method': 'POST',
      ':path': `/3/device/${recipient.token}`,
      authorization: `bearer ${authorization}`,
      'apns-topic': apns.bundleID,
      'apns-push-type': 'alert',
      'apns-priority': '10'
    });
    let status = 0;
    let response = '';
    request.on('response', (headers) => {
      status = Number(headers[':status'] ?? 0);
    });
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { response += chunk; });
    request.on('error', (error) => finish(error));
    request.on('end', () => {
      if (status >= 200 && status < 300) return finish({});
      let reason: string | undefined;
      try {
        reason = (JSON.parse(response || '{}') as { reason?: string }).reason;
      } catch {
        reason = undefined;
      }
      if (status === 410 || reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic') {
        return finish({ invalidTokenHash: recipient.tokenHash });
      }
      finish(new Error(`APNs rejected a notification (${status}, ${reason ?? 'unknown'})`));
    });
    request.end(JSON.stringify(payload));
  });
}

function alertFor(event: PresenceEvent, homeName: string, memberName: string, language: string): string {
  switch (language.split('-')[0]?.toLowerCase()) {
    case 'en':
      switch (event) {
        case 'arrival': return `${memberName} arrived at ${homeName}.`;
        case 'departure': return `${memberName} left ${homeName}.`;
        case 'empty': return `${homeName} is now empty.`;
      }
    case 'es':
      switch (event) {
        case 'arrival': return `${memberName} ha llegado a ${homeName}.`;
        case 'departure': return `${memberName} ha salido de ${homeName}.`;
        case 'empty': return `${homeName} está vacío ahora.`;
      }
    case 'de':
      switch (event) {
        case 'arrival': return `${memberName} ist bei ${homeName} angekommen.`;
        case 'departure': return `${memberName} hat ${homeName} verlassen.`;
        case 'empty': return `${homeName} ist jetzt leer.`;
      }
    default:
      switch (event) {
        case 'arrival': return `${memberName} est arrivé·e à ${homeName}.`;
        case 'departure': return `${memberName} est parti·e de ${homeName}.`;
        case 'empty': return `${homeName} est désormais vide.`;
      }
  }
}

export async function sendPresenceNotifications(input: {
  homeID: string;
  homeName: string;
  memberName: string;
  arrived: boolean;
  departed: boolean;
  becameEmpty: boolean;
}): Promise<void> {
  if (!config.apns || (!input.arrived && !input.departed)) return;
  const recipientRows = await database.query<EncryptedPushRecipient>(
    `SELECT d.push_token_encrypted AS encrypted_token, d.push_token_hash,
            d.push_environment AS environment, d.push_language AS language,
            CASE
              WHEN $4 AND preferences.notify_when_empty THEN 'empty'
              WHEN $3 AND preferences.notify_on_departure THEN 'departure'
              WHEN $2 AND preferences.notify_on_arrival THEN 'arrival'
            END AS event
       FROM home_notification_preferences preferences
       JOIN devices d ON d.user_id = preferences.user_id
      WHERE preferences.home_id = $1
        AND d.revoked_at IS NULL
        AND d.push_token_encrypted IS NOT NULL
        AND d.push_token_hash IS NOT NULL
        AND d.push_environment IS NOT NULL
        AND (($2 AND preferences.notify_on_arrival)
          OR ($3 AND preferences.notify_on_departure)
          OR ($4 AND preferences.notify_when_empty))`,
    [input.homeID, input.arrived, input.departed, input.becameEmpty]
  );
  const recipients: PushRecipient[] = recipientRows.rows.map((recipient) => ({
    token: decryptJson<{ token: string }>(recipient.encrypted_token).token,
    tokenHash: recipient.token_hash,
    environment: recipient.environment,
    language: recipient.language ?? 'fr',
    event: recipient.event
  }));
  const results = await Promise.allSettled(recipients.map(async (recipient) => {
    const body = alertFor(recipient.event, input.homeName, input.memberName, recipient.language);
    return sendToAPNs(recipient, {
      aps: { alert: { title: input.homeName, body }, sound: 'default' },
      homeID: input.homeID,
      event: recipient.event
    });
  }));
  const invalidTokenHashes = results.flatMap((result) =>
    result.status === 'fulfilled' && result.value.invalidTokenHash ? [result.value.invalidTokenHash] : []
  );
  if (invalidTokenHashes.length > 0) {
    await database.query(
      `UPDATE devices SET push_token_encrypted = NULL, push_token_hash = NULL,
        push_environment = NULL, push_language = NULL WHERE push_token_hash = ANY($1::text[])`,
      [invalidTokenHashes]
    );
  }
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}
