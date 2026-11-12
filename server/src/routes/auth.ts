import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { decrypt, encrypt, generateRecoveryCodes, sha256 } from '../lib/crypto.js';
import { hashPassword, passwordProblem, verifyPassword } from '../lib/password.js';
import { newTotpSecret, totpQr, verifyTotp } from '../lib/totp.js';
import { clearSessionCookie, createSession, promoteSession } from '../lib/session.js';
import { HttpError, requireAuth } from '../lib/guards.js';
import { audit } from '../lib/audit.js';
import { getSettings } from '../lib/settings.js';

const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$0g3Lq2cGkY5V0b6x0Qm4nG2b1QXyqgq3nY1QJmG3eT4';
const MAX_FAILS = 10;
const LOCK_MINUTES = 15;

const loginBody = z.object({ email: z.string().trim().min(3).max(254), password: z.string().min(1).max(256) });
const codeBody = z.object({ code: z.string().trim().min(6).max(20) });

interface UserRow {
  id: string; password_hash: string; disabled: boolean; totp_enabled: boolean;
  locked_until: Date | null; failed_logins: number; auth_source: string;
}

export async function authRoutes(app: FastifyInstance, { sql }: { sql: Sql }) {
  const loginLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/api/auth/login', loginLimit, async (req, reply) => {
    const { email, password } = loginBody.parse(req.body);
    const [u] = await sql<UserRow[]>`
      SELECT id, password_hash, disabled, totp_enabled, locked_until, failed_logins, auth_source
      FROM users WHERE lower(email) = lower(${email})`;
    if (!u) {
      await verifyPassword(DUMMY_HASH, password);
      throw new HttpError(401, 'invalid_credentials');
    }
    if (u.locked_until && u.locked_until > new Date()) throw new HttpError(429, 'account_locked');
    const ok = u.auth_source === 'local' && (await verifyPassword(u.password_hash, password));
    if (!ok || u.disabled) {
      if (!ok) {
        await sql`
          UPDATE users SET failed_logins = failed_logins + 1,
            locked_until = CASE WHEN failed_logins + 1 >= ${MAX_FAILS} THEN now() + make_interval(mins => ${LOCK_MINUTES}) ELSE locked_until END
          WHERE id = ${u.id}`;
        await audit(sql, req, 'auth.login_failed', { email }, u.id);
      }
      throw new HttpError(401, ok ? 'account_disabled' : 'invalid_credentials');
    }
    await sql`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ${u.id}`;
    const stage = u.totp_enabled ? 'mfa' : 'mfa_setup';
    await createSession(sql, req, reply, u.id, stage);
    return { next: stage };
  });

  app.post('/api/auth/mfa', loginLimit, async (req, reply) => {
    if (!req.session || req.session.stage !== 'mfa') throw new HttpError(401, 'unauthenticated');
    const { code } = codeBody.parse(req.body);
    const [u] = await sql<{ id: string; totp_secret_enc: string; totp_last_step: string | null; recovery_codes: string[] }[]>`
      SELECT id, totp_secret_enc, totp_last_step, recovery_codes FROM users WHERE id = ${req.session.user_id}`;
    const step = await verifyTotp(decrypt(u.totp_secret_enc), code, u.totp_last_step == null ? null : Number(u.totp_last_step));
    if (step !== null) {
      await sql`UPDATE users SET totp_last_step = ${step}, last_login_at = now() WHERE id = ${u.id}`;
    } else {
      // Recovery codes are single use.
      const hashed = sha256(code.toLowerCase());
      if (!u.recovery_codes.includes(hashed)) {
        await audit(sql, req, 'auth.mfa_failed', {}, u.id);
        throw new HttpError(401, 'invalid_code');
      }
      await sql`UPDATE users SET recovery_codes = ${sql.json(u.recovery_codes.filter((c) => c !== hashed))}, last_login_at = now() WHERE id = ${u.id}`;
      await audit(sql, req, 'auth.recovery_code_used', { remaining: u.recovery_codes.length - 1 }, u.id);
    }
    await promoteSession(sql, reply, req.session.id, 'full');
    await audit(sql, req, 'auth.login', { method: 'password+totp' }, u.id);
    return { next: 'done' };
  });

  /** Starts (or restarts) TOTP enrolment. Allowed during forced setup and for signed-in users. */
  app.post('/api/auth/mfa/setup', async (req) => {
    const s = req.session;
    if (!s || !req.user || (s.stage !== 'mfa_setup' && s.stage !== 'full')) throw new HttpError(401, 'unauthenticated');
    const secret = newTotpSecret();
    await sql`UPDATE sessions SET pending_totp_enc = ${encrypt(secret)} WHERE id = ${s.id}`;
    const settings = await getSettings(sql);
    const { uri, qr } = await totpQr(secret, req.user.email, settings.instanceName || 'Restream');
    return { secret, uri, qr };
  });

  app.post('/api/auth/mfa/setup/confirm', loginLimit, async (req, reply) => {
    const s = req.session;
    if (!s || !req.user || (s.stage !== 'mfa_setup' && s.stage !== 'full')) throw new HttpError(401, 'unauthenticated');
    if (!s.pending_totp_enc) throw new HttpError(400, 'no_pending_setup');
    const { code } = codeBody.parse(req.body);
    const secret = decrypt(s.pending_totp_enc);
    const step = await verifyTotp(secret, code);
    if (step === null) throw new HttpError(400, 'invalid_code');
    const codes = generateRecoveryCodes();
    await sql`
      UPDATE users SET totp_secret_enc = ${encrypt(secret)}, totp_enabled = true, totp_last_step = ${step},
             recovery_codes = ${sql.json(codes.map((c) => sha256(c)))}, last_login_at = now()
      WHERE id = ${req.user.id}`;
    if (s.stage === 'mfa_setup') {
      await promoteSession(sql, reply, s.id, 'full');
      await audit(sql, req, 'auth.login', { method: 'password+totp_enrolment' });
    } else {
      await sql`UPDATE sessions SET pending_totp_enc = NULL WHERE id = ${s.id}`;
      // Other sessions keep working, but only this browser saw the new secret.
    }
    await audit(sql, req, 'auth.mfa_enrolled');
    return { recoveryCodes: codes };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.session) await sql`DELETE FROM sessions WHERE id = ${req.session.id}`;
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const settings = await getSettings(sql);
    const base = {
      instanceName: settings.instanceName,
      defaultLanguage: settings.defaultLanguage,
      ssoEnabled: settings.sso.enabled && !!settings.sso.clientId,
    };
    if (!req.user || !req.session) return { ...base, stage: null, user: null };
    const [u] = await sql<{ auth_source: string; recovery_left: number }[]>`
      SELECT auth_source, jsonb_array_length(recovery_codes) AS recovery_left FROM users WHERE id = ${req.user.id}`;
    return { ...base, stage: req.session.stage, user: { ...req.user, auth_source: u.auth_source, recovery_left: u.recovery_left } };
  });

  app.patch('/api/auth/me', { preHandler: requireAuth('viewer', { allowPasswordChange: true }) }, async (req) => {
    const body = z.object({ name: z.string().trim().max(100).optional(), language: z.enum(['en', 'nl']).optional() }).parse(req.body);
    await sql`
      UPDATE users SET name = COALESCE(${body.name ?? null}, name), language = COALESCE(${body.language ?? null}, language)
      WHERE id = ${req.user!.id}`;
    return { ok: true };
  });

  app.post('/api/auth/password', { preHandler: requireAuth('viewer', { allowPasswordChange: true }), ...loginLimit }, async (req) => {
    const body = z.object({ current: z.string().max(256), next: z.string().max(256) }).parse(req.body);
    const [u] = await sql<{ password_hash: string; auth_source: string }[]>`SELECT password_hash, auth_source FROM users WHERE id = ${req.user!.id}`;
    if (u.auth_source !== 'local') throw new HttpError(400, 'sso_account');
    if (!(await verifyPassword(u.password_hash, body.current))) throw new HttpError(400, 'invalid_current_password');
    const problem = passwordProblem(body.next);
    if (problem) throw new HttpError(400, problem);
    await sql`UPDATE users SET password_hash = ${await hashPassword(body.next)}, must_change_password = false WHERE id = ${req.user!.id}`;
    // Sign out every other session of this user.
    await sql`DELETE FROM sessions WHERE user_id = ${req.user!.id} AND id <> ${req.session!.id}`;
    await audit(sql, req, 'auth.password_changed');
    return { ok: true };
  });

  app.post('/api/auth/recovery-codes', { preHandler: requireAuth(), ...loginLimit }, async (req) => {
    const { code } = codeBody.parse(req.body);
    const [u] = await sql<{ totp_secret_enc: string | null }[]>`SELECT totp_secret_enc FROM users WHERE id = ${req.user!.id}`;
    if (!u.totp_secret_enc || (await verifyTotp(decrypt(u.totp_secret_enc), code)) === null) throw new HttpError(400, 'invalid_code');
    const codes = generateRecoveryCodes();
    await sql`UPDATE users SET recovery_codes = ${sql.json(codes.map((c) => sha256(c)))} WHERE id = ${req.user!.id}`;
    await audit(sql, req, 'auth.recovery_codes_regenerated');
    return { recoveryCodes: codes };
  });

  app.get('/api/auth/sessions', { preHandler: requireAuth() }, async (req) => {
    const rows = await sql`
      SELECT id, ip, user_agent, created_at, last_seen_at, (id = ${req.session!.id}) AS current
      FROM sessions WHERE user_id = ${req.user!.id} AND stage = 'full' AND expires_at > now()
      ORDER BY last_seen_at DESC`;
    return rows.map((r) => ({ ...r, id: String(r.id).slice(0, 12) }));
  });

  app.delete('/api/auth/sessions/:id', { preHandler: requireAuth() }, async (req) => {
    const { id } = z.object({ id: z.string().min(8).max(64) }).parse(req.params);
    await sql`DELETE FROM sessions WHERE user_id = ${req.user!.id} AND left(id, 12) = ${id} AND id <> ${req.session!.id}`;
    return { ok: true };
  });
}
