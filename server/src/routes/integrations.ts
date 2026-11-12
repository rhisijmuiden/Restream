import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { HttpError, requireAuth } from '../lib/guards.js';
import { audit } from '../lib/audit.js';
import { decrypt, encrypt, sha256 } from '../lib/crypto.js';
import { newApiKey } from '../lib/apiKeys.js';
import { webhookEvents } from '../lib/events.js';
import { newWebhookSecret, webhookUrlProblem, type WebhookDispatcher } from '../lib/webhooks.js';

const idParam = z.object({ id: z.uuid() });

const webhookBody = z.object({
  name: z.string().trim().min(1).max(60),
  url: z.string().trim().max(1000),
  /** Empty: every event. */
  events: z.array(z.enum(webhookEvents)).max(webhookEvents.length).default([]),
  enabled: z.boolean().default(true),
});

/** API keys and webhooks (Administration › API & webhooks). Administrators only. */
export async function integrationRoutes(app: FastifyInstance, { sql, webhooks }: { sql: Sql; webhooks: WebhookDispatcher }) {
  const admin = { preHandler: requireAuth('admin') };

  // ----------------------------------------------------------------------------------------------
  // API keys

  app.get('/api/api-keys', admin, async () => {
    const rows = await sql<{
      id: string; name: string; prefix: string; role: string; created_at: Date; expires_at: Date | null; last_used_at: Date | null;
      last_used_ip: string | null; revoked_at: Date | null; created_by_name: string;
    }[]>`
      SELECT k.id, k.name, k.prefix, k.role, k.created_at, k.expires_at, k.last_used_at, k.last_used_ip, k.revoked_at,
             COALESCE(NULLIF(u.name, ''), u.email) AS created_by_name
      FROM api_keys k JOIN users u ON u.id = k.created_by
      ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC`;
    return rows.map((k) => ({
      id: k.id, name: k.name, prefix: k.prefix, role: k.role, createdAt: k.created_at, expiresAt: k.expires_at,
      lastUsedAt: k.last_used_at, lastUsedIp: k.last_used_ip, revokedAt: k.revoked_at, createdBy: k.created_by_name,
      active: !k.revoked_at && (!k.expires_at || k.expires_at > new Date()),
    }));
  });

  /** Creates a key; the key itself is only in this response. */
  app.post('/api/api-keys', admin, async (req) => {
    const body = z.object({
      name: z.string().trim().min(1).max(60),
      role: z.enum(['admin', 'operator', 'viewer']).default('operator'),
      expiresInDays: z.number().int().min(1).max(3650).nullable().default(null),
    }).parse(req.body);
    const token = newApiKey();
    const expires = body.expiresInDays === null ? null : new Date(Date.now() + body.expiresInDays * 86_400_000);
    const [k] = await sql<{ id: string }[]>`
      INSERT INTO api_keys (name, token_hash, prefix, role, created_by, expires_at)
      VALUES (${body.name}, ${sha256(token)}, ${token.slice(0, 10)}, ${body.role}, ${req.user!.id}, ${expires})
      RETURNING id`;
    await audit(sql, req, 'api_key.created', { id: k.id, name: body.name, role: body.role });
    return { id: k.id, token };
  });

  app.delete('/api/api-keys/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params);
    const r = await sql`UPDATE api_keys SET revoked_at = now() WHERE id = ${id} AND revoked_at IS NULL`;
    if (!r.count) throw new HttpError(404, 'not_found');
    await audit(sql, req, 'api_key.revoked', { id });
    return { ok: true };
  });

  // ----------------------------------------------------------------------------------------------
  // Webhooks

  app.get('/api/webhooks/events', admin, async () => webhookEvents);

  app.get('/api/webhooks', admin, async () => {
    const hooks = await sql<{ id: string; name: string; url: string; secret_enc: string; events: string[]; enabled: boolean; created_at: Date }[]>`
      SELECT id, name, url, secret_enc, events, enabled, created_at FROM webhooks ORDER BY created_at`;
    const stats = await sql<{ webhook_id: string; delivered: number; failed: number; pending: number; last_at: Date | null; last_status: string | null; last_error: string | null }[]>`
      SELECT webhook_id,
             count(*) FILTER (WHERE status = 'delivered')::int AS delivered,
             count(*) FILTER (WHERE status = 'failed')::int AS failed,
             count(*) FILTER (WHERE status = 'pending')::int AS pending,
             max(created_at) AS last_at,
             (array_agg(status ORDER BY created_at DESC) FILTER (WHERE attempts > 0))[1] AS last_status,
             (array_agg(error ORDER BY created_at DESC) FILTER (WHERE attempts > 0))[1] AS last_error
      FROM webhook_deliveries WHERE created_at > now() - interval '14 days' GROUP BY webhook_id`;
    const by = new Map(stats.map((s) => [s.webhook_id, s]));
    return hooks.map((h) => {
      const s = by.get(h.id);
      return {
        id: h.id, name: h.name, url: h.url, secret: decrypt(h.secret_enc), events: h.events, enabled: h.enabled, createdAt: h.created_at,
        stats: { delivered: s?.delivered ?? 0, failed: s?.failed ?? 0, pending: s?.pending ?? 0, lastAt: s?.last_at ?? null, lastStatus: s?.last_status ?? null, lastError: s?.last_error ?? null },
      };
    });
  });

  app.post('/api/webhooks', admin, async (req) => {
    const body = webhookBody.parse(req.body);
    const problem = webhookUrlProblem(body.url);
    if (problem) throw new HttpError(400, problem);
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM webhooks`;
    if (n >= 20) throw new HttpError(400, 'too_many_webhooks');
    const [h] = await sql<{ id: string }[]>`
      INSERT INTO webhooks (name, url, secret_enc, events, enabled)
      VALUES (${body.name}, ${body.url}, ${encrypt(newWebhookSecret())}, ${body.events}, ${body.enabled}) RETURNING id`;
    await audit(sql, req, 'webhook.created', { id: h.id, name: body.name, url: body.url });
    return { id: h.id };
  });

  app.put('/api/webhooks/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = webhookBody.parse(req.body);
    const problem = webhookUrlProblem(body.url);
    if (problem) throw new HttpError(400, problem);
    const r = await sql`
      UPDATE webhooks SET name = ${body.name}, url = ${body.url}, events = ${body.events}, enabled = ${body.enabled}, updated_at = now()
      WHERE id = ${id}`;
    if (!r.count) throw new HttpError(404, 'not_found');
    await audit(sql, req, 'webhook.updated', { id, name: body.name, url: body.url, enabled: body.enabled });
    return { ok: true };
  });

  app.post('/api/webhooks/:id/rotate-secret', admin, async (req) => {
    const { id } = idParam.parse(req.params);
    const r = await sql`UPDATE webhooks SET secret_enc = ${encrypt(newWebhookSecret())}, updated_at = now() WHERE id = ${id}`;
    if (!r.count) throw new HttpError(404, 'not_found');
    await audit(sql, req, 'webhook.secret_rotated', { id });
    return { ok: true };
  });

  app.delete('/api/webhooks/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params);
    const r = await sql`DELETE FROM webhooks WHERE id = ${id}`;
    if (!r.count) throw new HttpError(404, 'not_found');
    await audit(sql, req, 'webhook.deleted', { id });
    return { ok: true };
  });

  /** Sends a "ping" event right away and reports what the receiver answered. */
  app.post('/api/webhooks/:id/test', admin, async (req) => {
    const { id } = idParam.parse(req.params);
    const [h] = await sql`SELECT id FROM webhooks WHERE id = ${id}`;
    if (!h) throw new HttpError(404, 'not_found');
    return webhooks.test(id);
  });

  app.get('/api/webhooks/:id/deliveries', admin, async (req) => {
    const { id } = idParam.parse(req.params);
    const rows = await sql<{
      id: string; event_id: string; event: string; status: string; attempts: number; response_code: number | null; error: string | null;
      duration_ms: number | null; created_at: Date; delivered_at: Date | null; next_attempt_at: Date; payload: unknown;
    }[]>`
      SELECT id, event_id, event, status, attempts, response_code, error, duration_ms, created_at, delivered_at, next_attempt_at, payload
      FROM webhook_deliveries WHERE webhook_id = ${id} ORDER BY created_at DESC LIMIT 100`;
    return rows.map((d) => ({
      id: d.id, eventId: d.event_id, event: d.event, status: d.status, attempts: d.attempts, responseCode: d.response_code, error: d.error,
      durationMs: d.duration_ms, createdAt: d.created_at, deliveredAt: d.delivered_at, nextAttemptAt: d.status === 'pending' ? d.next_attempt_at : null,
      payload: d.payload,
    }));
  });

  app.post('/api/webhooks/deliveries/:id/redeliver', admin, async (req) => {
    const { id } = idParam.parse(req.params);
    const newId = await webhooks.redeliver(id);
    if (!newId) throw new HttpError(404, 'not_found');
    await audit(sql, req, 'webhook.redelivered', { delivery: id });
    return { id: newId };
  });
}
