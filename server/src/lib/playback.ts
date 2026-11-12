import { createHmac, timingSafeEqual } from 'node:crypto';
import { key } from './crypto.js';

/**
 * Signed playback tokens for embed and hotlink URLs: `<exp base36>.<signature>`.
 * exp is a unix time in seconds (0 = no expiry). The signature covers the playback id and the stream's
 * token secret, so replacing that secret revokes every token of the stream. Tokens are never stored.
 */
const sigLength = 22;

function sign(pid: string, exp: number, secret: string) {
  return createHmac('sha256', key()).update(`playback:${pid}.${exp}.${secret}`).digest('base64url').slice(0, sigLength);
}

export function createPlaybackToken(pid: string, secret: string, expiresAt: Date | null): string {
  const exp = expiresAt ? Math.floor(expiresAt.getTime() / 1000) : 0;
  return `${exp.toString(36)}.${sign(pid, exp, secret)}`;
}

export const tokenPattern = /^[0-9a-z]{1,8}\.[A-Za-z0-9_-]{22}$/;

export function verifyPlaybackToken(pid: string, secret: string, token: string, now = Date.now()): boolean {
  if (!tokenPattern.test(token)) return false;
  const [expRaw, sig] = token.split('.');
  const exp = Number.parseInt(expRaw, 36);
  if (!Number.isFinite(exp) || (exp !== 0 && exp * 1000 < now)) return false;
  const want = Buffer.from(sign(pid, exp, secret));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Expiry of a token (null = never), or undefined when it cannot be parsed. */
export function tokenExpiry(token: string): Date | null | undefined {
  if (!tokenPattern.test(token)) return undefined;
  const exp = Number.parseInt(token.split('.')[0], 36);
  return exp === 0 ? null : new Date(exp * 1000);
}

/**
 * Normalises an allowed-domain entry: "https://www.example.com/page" → "www.example.com", "*.example.com" stays.
 * Returns null for anything that is not a host name.
 */
export function normaliseDomain(raw: string): string | null {
  let v = raw.trim().toLowerCase();
  if (!v) return null;
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');
  if (!/^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(v)) return null;
  if (v === '*' || v.length > 253) return null;
  return v;
}

/** True when `host` is covered by one of the allowed domains ("*.example.com" also covers example.com). */
export function hostAllowed(host: string, domains: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return domains.some((d) => {
    if (d.startsWith('*.')) {
      const base = d.slice(2);
      return h === base || h.endsWith(`.${base}`);
    }
    return h === d;
  });
}

/** Host of an Origin or Referer header value, or null. */
export function headerHost(v: string | string[] | undefined): string | null {
  if (typeof v !== 'string' || !v || v === 'null') return null;
  try { return new URL(v).hostname; } catch { return null; }
}
