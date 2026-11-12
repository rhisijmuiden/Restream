import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';

/** Parses an APP_KEY value (64 hex characters or base64 of 32 bytes). */
export function parseKey(raw: string): Buffer {
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('APP_KEY must be 32 bytes (64 hex chars or base64)');
  return buf;
}

export function key(): Buffer {
  const raw = config.appKey;
  if (!raw) {
    if (process.env.NODE_ENV === 'production') throw new Error('APP_KEY is not set');
    return createHash('sha256').update('restream-dev-key').digest();
  }
  return parseKey(raw);
}

/** AES-256-GCM, output: base64(iv | tag | ciphertext). */
export function encrypt(plain: string, k: Buffer = key()): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

export function decrypt(payload: string, k: Buffer = key()): string {
  const buf = Buffer.from(payload, 'base64');
  const d = createDecipheriv('aes-256-gcm', k, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

export function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Human friendly password: 4 groups of 5 chars without look-alikes. */
export function generatePassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(20);
  let out = '';
  for (let i = 0; i < 20; i++) {
    if (i && i % 5 === 0) out += '-';
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

export function generateRecoveryCodes(n = 10): string[] {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: n }, () => {
    const b = randomBytes(10);
    let s = '';
    for (let i = 0; i < 10; i++) s += alphabet[b[i] % alphabet.length];
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}
