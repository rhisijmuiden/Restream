import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Sql } from '../db.js';
import { config } from '../config.js';
import { randomToken, sha256 } from './crypto.js';

export const COOKIE = 'restream_session';

export type Role = 'admin' | 'operator' | 'viewer';
export type Stage = 'mfa' | 'mfa_setup' | 'full';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  language: 'en' | 'nl';
  totp_enabled: boolean;
  must_change_password: boolean;
}

export interface SessionRow {
  id: string;
  user_id: string;
  stage: Stage;
  pending_totp_enc: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionRow | null;
    user: SessionUser | null;
  }
}

export async function createSession(sql: Sql, req: FastifyRequest, reply: FastifyReply, userId: string, stage: Stage) {
  const token = randomToken();
  const hours = stage === 'full' ? config.sessionHours : 0.25;
  await sql`
    INSERT INTO sessions (id, user_id, stage, ip, user_agent, expires_at)
    VALUES (${sha256(token)}, ${userId}, ${stage}, ${req.ip}, ${String(req.headers['user-agent'] ?? '').slice(0, 300)},
            now() + make_interval(secs => ${hours * 3600}))`;
  reply.setCookie(COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    maxAge: config.sessionHours * 3600,
  });
}

/** Moves a session to a new stage and rotates its id to prevent fixation. */
export async function promoteSession(sql: Sql, reply: FastifyReply, oldId: string, stage: Stage) {
  const token = randomToken();
  await sql`
    UPDATE sessions SET id = ${sha256(token)}, stage = ${stage}, pending_totp_enc = NULL,
           expires_at = now() + make_interval(secs => ${config.sessionHours * 3600})
    WHERE id = ${oldId}`;
  reply.setCookie(COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    maxAge: config.sessionHours * 3600,
  });
}

export async function loadSession(sql: Sql, req: FastifyRequest) {
  req.session = null;
  req.user = null;
  const token = req.cookies[COOKIE];
  if (!token) return;
  const rows = await sql<(SessionRow & SessionUser & { disabled: boolean })[]>`
    SELECT s.id, s.user_id, s.stage, s.pending_totp_enc,
           u.email, u.name, u.role, u.language, u.totp_enabled, u.must_change_password, u.disabled
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ${sha256(token)} AND s.expires_at > now()`;
  const r = rows[0];
  if (!r || r.disabled) return;
  req.session = { id: r.id, user_id: r.user_id, stage: r.stage, pending_totp_enc: r.pending_totp_enc };
  req.user = {
    id: r.user_id, email: r.email, name: r.name, role: r.role, language: r.language,
    totp_enabled: r.totp_enabled, must_change_password: r.must_change_password,
  };
  // Sliding expiry, written at most once a minute.
  sql`UPDATE sessions SET last_seen_at = now() WHERE id = ${r.id} AND last_seen_at < now() - interval '1 minute'`.catch(() => {});
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(COOKIE, { path: '/' });
}
