import { z } from 'zod';

const environment = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().url(),
  DATABASE_SSL: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  SESSION_SIGNING_SECRET_BASE64: z.string().min(40),
  DATA_ENCRYPTION_KEY_BASE64: z.string().min(40),
  APPLE_CLIENT_ID: z.string().min(3),
  TRUST_PROXY: z.enum(['true', 'false']).default('false').transform((value) => value === 'true')
});

function requiredKey(value: string, name: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error(`${name} must decode to exactly 32 bytes`);
  return key;
}

const raw = environment.parse(process.env);

export const config = {
  ...raw,
  sessionKey: requiredKey(raw.SESSION_SIGNING_SECRET_BASE64, 'SESSION_SIGNING_SECRET_BASE64'),
  encryptionKey: requiredKey(raw.DATA_ENCRYPTION_KEY_BASE64, 'DATA_ENCRYPTION_KEY_BASE64')
};
