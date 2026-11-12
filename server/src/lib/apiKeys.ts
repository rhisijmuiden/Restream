import type { FastifyRequest } from 'fastify';
import type { Sql } from '../db.js';
import { randomToken, sha256 } from './crypto.js';
import type { Role } from './session.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set when the request authenticated with an API key instead of a session cookie. */
    apiKey: { id: string; name: string } | null;
  }
}

const rank: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

/** New API key: "rsk_" followed by 43 url-safe characters (256 bits). */
export function newApiKey() {
  return `rsk_${randomToken()}`;
}

/**
 * Paths an API key may not use: signing in and the own account (they would act on the person who made the key),
 * the browser-only OAuth flows, user management, managing API keys themselves, and restoring a backup.
 */
export function apiKeyForbidden(method: string, url: string): boolean {
  const p = url.split('?')[0];
  if (p === '/api/auth/me' && method === 'GET') return false;
  return /^\/api\/(auth|users|api-keys)(\/|$)/.test(p)
    || /^\/api\/accounts\/oauth\//.test(p)
    || p === '/api/backups/restore';
}

/**
 * Authenticates "Authorization: Bearer rsk_…". The request acts as the user who made the key,
 * with the key's role but never more than that user has now.
 */
export async function loadApiKey(sql: Sql, req: FastifyRequest, token: string) {
  req.session = null;
  req.user = null;
  if (!/^rsk_[A-Za-z0-9_-]{20,100}$/.test(token)) return;
  const [r] = await sql<{
    id: string; name: string; role: Role; user_id: string; email: string; user_role: Role; language: 'en' | 'nl'; last_used_at: Date | null;
  }[]>`
    SELECT k.id, k.name, k.role, u.id AS user_id, u.email, u.role AS user_role, u.language, k.last_used_at
    FROM api_keys k JOIN users u ON u.id = k.created_by
    WHERE k.token_hash = ${sha256(token)} AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now()) AND NOT u.disabled`;
  if (!r) return;
  const role = rank[r.role] <= rank[r.user_role] ? r.role : r.user_role;
  req.apiKey = { id: r.id, name: r.name };
  req.session = { id: `apikey:${r.id}`, user_id: r.user_id, stage: 'full', pending_totp_enc: null };
  req.user = { id: r.user_id, email: r.email, name: `${r.name} (API)`, role, language: r.language, totp_enabled: true, must_change_password: false };
  if (!r.last_used_at || Date.now() - r.last_used_at.getTime() > 60_000) {
    sql`UPDATE api_keys SET last_used_at = now(), last_used_ip = ${req.ip} WHERE id = ${r.id}`.catch(() => {});
  }
}
