import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { generatePassword } from '../lib/crypto.js';
import { hashPassword, passwordProblem } from '../lib/password.js';
import { HttpError, requireAuth } from '../lib/guards.js';
import { audit } from '../lib/audit.js';

const role = z.enum(['admin', 'operator', 'viewer']);
const idParam = z.object({ id: z.uuid() });

export async function userRoutes(app: FastifyInstance, { sql }: { sql: Sql }) {
  const admin = { preHandler: requireAuth('admin') };

  async function assertNotLastAdmin(id: string) {
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND NOT disabled AND id <> ${id}`;
    if (n === 0) throw new HttpError(400, 'last_admin');
  }

  app.get('/api/users', admin, async () => sql`
    SELECT id, email, name, role, language, totp_enabled, disabled, auth_source, must_change_password,
           created_at, last_login_at, (locked_until IS NOT NULL AND locked_until > now()) AS locked
    FROM users ORDER BY lower(email)`);

  app.post('/api/users', admin, async (req) => {
    const body = z.object({
      email: z.email().max(254),
      name: z.string().trim().max(100).default(''),
      role,
      password: z.string().max(256).optional(),
    }).parse(req.body);
    const password = body.password || generatePassword();
    const problem = passwordProblem(password);
    if (problem) throw new HttpError(400, problem);
    const exists = await sql`SELECT 1 FROM users WHERE lower(email) = lower(${body.email})`;
    if (exists.length) throw new HttpError(409, 'email_taken');
    const [u] = await sql<{ id: string }[]>`
      INSERT INTO users (email, name, role, password_hash, must_change_password)
      VALUES (${body.email}, ${body.name}, ${body.role}, ${await hashPassword(password)}, true)
      RETURNING id`;
    await audit(sql, req, 'user.created', { id: u.id, email: body.email, role: body.role });
    return { id: u.id, temporaryPassword: password };
  });

  app.patch('/api/users/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({
      name: z.string().trim().max(100).optional(),
      role: role.optional(),
      disabled: z.boolean().optional(),
    }).parse(req.body);
    if (id === req.user!.id && (body.disabled || (body.role && body.role !== 'admin'))) throw new HttpError(400, 'cannot_demote_self');
    if ((body.role && body.role !== 'admin') || body.disabled) await assertNotLastAdmin(id);
    const r = await sql`
      UPDATE users SET name = COALESCE(${body.name ?? null}, name), role = COALESCE(${body.role ?? null}, role),
             disabled = COALESCE(${body.disabled ?? null}, disabled),
             locked_until = CASE WHEN ${body.disabled ?? null}::boolean = false THEN NULL ELSE locked_until END
      WHERE id = ${id}`;
    if (!r.count) throw new HttpError(404, 'not_found');
    if (body.disabled) await sql`DELETE FROM sessions WHERE user_id = ${id}`;
    await audit(sql, req, 'user.updated', { id, ...body });
    return { ok: true };
  });

  app.post('/api/users/:id/reset-password', admin, async (req) => {
    const { id } = idParam.parse(req.params);
    const password = generatePassword();
    const r = await sql`
      UPDATE users SET password_hash = ${await hashPassword(password)}, must_change_password = true,
             failed_logins = 0, locked_until = NULL
      WHERE id = ${id} AND auth_source = 'local'`;
    if (!r.count) throw new HttpError(404, 'not_found');
    await sql`DELETE FROM sessions WHERE user_id = ${id}`;
    await audit(sql, req, 'user.password_reset', { id });
    return { temporaryPassword: password };
  });

  app.post('/api/users/:id/reset-2fa', admin, async (req) => {
    const { id } = idParam.parse(req.params);
    const r = await sql`
      UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, totp_last_step = NULL, recovery_codes = '[]'::jsonb
      WHERE id = ${id}`;
    if (!r.count) throw new HttpError(404, 'not_found');
    await sql`DELETE FROM sessions WHERE user_id = ${id}`;
    await audit(sql, req, 'user.mfa_reset', { id });
    return { ok: true };
  });

  app.delete('/api/users/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params);
    if (id === req.user!.id) throw new HttpError(400, 'cannot_delete_self');
    await assertNotLastAdmin(id);
    const r = await sql`DELETE FROM users WHERE id = ${id}`;
    if (!r.count) throw new HttpError(404, 'not_found');
    await audit(sql, req, 'user.deleted', { id });
    return { ok: true };
  });

  app.get('/api/audit', admin, async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return sql`
      SELECT a.id, a.action, a.details, a.ip, a.created_at, u.email
      FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC LIMIT ${limit}`;
  });
}
