import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from './config.js';

const algorithm = 'aes-256-gcm';

export class ApiError extends Error {
  constructor(public readonly statusCode: number, message: string, public readonly code = 'request_failed') {
    super(message);
  }
}

export function opaqueToken(prefix = ''): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, config.encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptJson<T>(payload: string): T {
  const [version, encodedIv, encodedTag, encodedCiphertext] = payload.split('.');
  if (version !== 'v1' || !encodedIv || !encodedTag || !encodedCiphertext) {
    throw new Error('Invalid encrypted payload');
  }
  const decipher = createDecipheriv(algorithm, config.encryptionKey, Buffer.from(encodedIv, 'base64url'));
  decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
    decipher.final()
  ]).toString('utf8');
  return JSON.parse(plaintext) as T;
}

export function isPrivateIPv4(host: string): boolean {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}
