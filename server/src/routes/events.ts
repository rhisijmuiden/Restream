import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { HttpError, requireAuth } from '../lib/guards.js';
import { audit } from '../lib/audit.js';
import type { EventScheduler } from '../events/scheduler.js';
import type { Provisioner } from '../platforms/provisioner.js';

const idParam = z.object({ id: z.uuid() });

const eventBody = z.object({
  streamId: z.uuid(),
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().max(5000).default(''),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }).nullable().default(null),
  autoStart: z.boolean().default(true),
  autoStop: z.boolean().default(true),
  record: z.boolean().default(false),
  privacy: z.enum(['public', 'unlisted', 'private']).default('public'),
  destinationIds: z.array(z.uuid()).max(20).default([]),
});

interface EventRow {
  id: string; stream_id: string; title: string; description: string; starts_at: Date; ends_at: Date | null; auto_start: boolean; auto_stop: boolean;
  record: boolean; privacy: string; status: string; started_at: Date | null; ended_at: Date | null; created_at: Date;
}

export async function eventRoutes(app: FastifyInstance, { sql, scheduler, provisioner }: { sql: Sql; scheduler: EventScheduler; provisioner: Provisioner }) {
  const viewer = { preHandler: requireAuth('viewer') };
  const operator = { preHandler: requireAuth('operator') };

  app.get('/api/events', viewer, async () => {
    const events = await sql<(EventRow & { stream_name: string | null })[]>`
      SELECT e.*, s.name AS stream_name FROM events e LEFT JOIN streams s ON s.id = e.stream_id
      WHERE e.status IN ('scheduled', 'live') OR COALESCE(e.ended_at, e.ends_at, e.starts_at) > now() - interval '60 days'
      ORDER BY e.starts_at`;
    const targets = await sql<{ event_id: string; destination_id: string; status: string; watch_url: string | null; error: string | null; name: string; platform: string; auth: string }[]>`
      SELECT t.event_id, t.destination_id, t.status, t.watch_url, t.error, d.name, d.platform, d.auth
      FROM event_targets t JOIN destinations d ON d.id = t.destination_id WHERE t.status <> 'removed' ORDER BY d.position`;
    return events.map((e) => ({
      id: e.id, streamId: e.stream_id, streamName: e.stream_name, title: e.title, description: e.description,
      startsAt: e.starts_at, endsAt: e.ends_at, autoStart: e.auto_start, autoStop: e.auto_stop, record: e.record, privacy: e.privacy,
      status: e.status, startedAt: e.started_at, endedAt: e.ended_at,
      targets: targets.filter((t) => t.event_id === e.id).map((t) => ({
        destinationId: t.destination_id, name: t.name, platform: t.platform, viaAccount: t.auth === 'account',
        status: t.status, watchUrl: t.watch_url, error: t.error,
      })),
    }));
  });

  async function check(body: z.infer<typeof eventBody>) {
    const start = new Date(body.startsAt);
    if (body.endsAt && new Date(body.endsAt) <= start) throw new HttpError(400, 'event_end_before_start');
    if (body.endsAt && new Date(body.endsAt).getTime() - start.getTime() > 24 * 3600_000) throw new HttpError(400, 'event_too_long');
    const [s] = await sql`SELECT id FROM streams WHERE id = ${body.streamId}`;
    if (!s) throw new HttpError(400, 'not_found');
    if (body.destinationIds.length) {
      const ok = await sql`SELECT id FROM destinations WHERE stream_id = ${body.streamId} AND id IN ${sql(body.destinationIds)}`;
      if (ok.length !== new Set(body.destinationIds).size) throw new HttpError(400, 'invalid_destination');
    }
  }

  async function getEvent(id: string) {
    const [e] = await sql<EventRow[]>`SELECT * FROM events WHERE id = ${id}`;
    if (!e) throw new HttpError(404, 'not_found');
    return e;
  }

  const kick = () => { provisioner.nudge(); };

  app.post('/api/events', operator, async (req) => {
    const body = eventBody.parse(req.body);
    await check(body);
    if (new Date(body.startsAt).getTime() < Date.now() - 60_000) throw new HttpError(400, 'event_in_past');
    const id = await sql.begin(async (tx) => {
      const [e] = await tx<{ id: string }[]>`
        INSERT INTO events (stream_id, title, description, starts_at, ends_at, auto_start, auto_stop, record, privacy, created_by)
        VALUES (${body.streamId}, ${body.title}, ${body.description}, ${body.startsAt}, ${body.endsAt}, ${body.autoStart},
                ${body.autoStop}, ${body.record}, ${body.privacy}, ${req.user!.id})
        RETURNING id`;
      for (const d of new Set(body.destinationIds)) await tx`INSERT INTO event_targets (event_id, destination_id) VALUES (${e.id}, ${d})`;
      return e.id;
    });
    await audit(sql, req, 'event.created', { id, title: body.title, startsAt: body.startsAt });
    kick();
    return { id };
  });

  app.put('/api/events/:id', operator, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = eventBody.parse(req.body);
    const cur = await getEvent(id);
    if (cur.status !== 'scheduled') throw new HttpError(409, 'event_not_editable');
    if (body.streamId !== cur.stream_id) throw new HttpError(400, 'event_stream_change');
    await check(body);
    await sql.begin(async (tx) => {
      await tx`
        UPDATE events SET title = ${body.title}, description = ${body.description}, starts_at = ${body.startsAt}, ends_at = ${body.endsAt},
               auto_start = ${body.autoStart}, auto_stop = ${body.autoStop}, record = ${body.record}, privacy = ${body.privacy}, updated_at = now()
        WHERE id = ${id}`;
      const want = new Set(body.destinationIds);
      const have = await tx<{ destination_id: string; status: string; remote_id: string | null }[]>`
        SELECT destination_id, status, remote_id FROM event_targets WHERE event_id = ${id}`;
      for (const t of have) {
        if (!want.has(t.destination_id)) {
          if (t.remote_id) await tx`UPDATE event_targets SET status = 'removed' WHERE event_id = ${id} AND destination_id = ${t.destination_id}`;
          else await tx`DELETE FROM event_targets WHERE event_id = ${id} AND destination_id = ${t.destination_id}`;
        } else if (t.status === 'removed' || t.status === 'failed') {
          await tx`UPDATE event_targets SET status = ${t.remote_id ? 'registered' : 'pending'}, dirty = ${!!t.remote_id}, error = NULL WHERE event_id = ${id} AND destination_id = ${t.destination_id}`;
        } else {
          // Push the new title/time to the platform.
          await tx`UPDATE event_targets SET dirty = true WHERE event_id = ${id} AND destination_id = ${t.destination_id} AND status = 'registered'`;
        }
        want.delete(t.destination_id);
      }
      for (const d of want) await tx`INSERT INTO event_targets (event_id, destination_id) VALUES (${id}, ${d})`;
    });
    await audit(sql, req, 'event.updated', { id, title: body.title });
    kick();
    return { ok: true };
  });

  app.post('/api/events/:id/start', operator, async (req) => {
    const { id } = idParam.parse(req.params);
    const e = await getEvent(id);
    if (e.status !== 'scheduled') throw new HttpError(409, 'event_not_editable');
    await scheduler.startEvent(id);
    await audit(sql, req, 'event.started', { id, title: e.title });
    return { ok: true };
  });

  app.post('/api/events/:id/stop', operator, async (req) => {
    const { id } = idParam.parse(req.params);
    const e = await getEvent(id);
    if (e.status !== 'live') throw new HttpError(409, 'event_not_live');
    await scheduler.stopEvent(id);
    await audit(sql, req, 'event.stopped', { id, title: e.title });
    return { ok: true };
  });

  /** Cancels a scheduled event and removes what was announced on the platforms. */
  app.post('/api/events/:id/cancel', operator, async (req) => {
    const { id } = idParam.parse(req.params);
    const e = await getEvent(id);
    if (e.status !== 'scheduled') throw new HttpError(409, 'event_not_editable');
    await sql.begin(async (tx) => {
      await tx`UPDATE events SET status = 'cancelled', updated_at = now() WHERE id = ${id}`;
      await tx`UPDATE event_targets SET status = 'removed' WHERE event_id = ${id} AND remote_id IS NOT NULL AND status IN ('registered', 'failed')`;
      await tx`DELETE FROM event_targets WHERE event_id = ${id} AND status <> 'removed'`;
    });
    await audit(sql, req, 'event.cancelled', { id, title: e.title });
    kick();
    return { ok: true };
  });

  /** Tries the failed platform registrations again. */
  app.post('/api/events/:id/retry', operator, async (req) => {
    const { id } = idParam.parse(req.params);
    await getEvent(id);
    await sql`UPDATE event_targets SET status = 'pending', error = NULL WHERE event_id = ${id} AND status = 'failed' AND remote_id IS NULL`;
    await sql`UPDATE event_targets SET status = 'registered', dirty = true, error = NULL WHERE event_id = ${id} AND status = 'failed' AND remote_id IS NOT NULL`;
    kick();
    return { ok: true };
  });

  app.delete('/api/events/:id', operator, async (req) => {
    const { id } = idParam.parse(req.params);
    const e = await getEvent(id);
    if (!['ended', 'cancelled'].includes(e.status)) throw new HttpError(409, 'event_not_editable');
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM event_targets WHERE event_id = ${id} AND status = 'removed'`;
    if (n > 0) throw new HttpError(409, 'event_cleanup_pending');
    await sql`DELETE FROM events WHERE id = ${id}`;
    await audit(sql, req, 'event.deleted', { id, title: e.title });
    return { ok: true };
  });
}
