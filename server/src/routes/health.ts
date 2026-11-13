import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { HttpError, requireAuth } from '../lib/guards.js';
import type { HealthMonitor } from '../health/monitor.js';
import { preflight } from '../health/preflight.js';
import type { MediaSupervisor } from '../media/supervisor.js';

export async function healthRoutes(app: FastifyInstance, { sql, media, health }: { sql: Sql; media: MediaSupervisor; health: HealthMonitor }) {
  const viewer = { preHandler: requireAuth('viewer') };
  const operator = { preHandler: requireAuth('operator') };

  /** Live health of feeds, destinations and server, with 15 minutes of history and the open issues. */
  app.get('/api/monitor', viewer, async (req) => {
    const { history } = z.object({ history: z.enum(['0', '1']).default('1') }).parse(req.query);
    const snap = health.snapshot();
    if (history === '1') return snap;
    return {
      ...snap,
      server: { ...snap.server, history: [] },
      feeds: snap.feeds.map((f) => ({ ...f, history: [] })),
      outputs: snap.outputs.map((o) => ({ ...o, history: [] })),
    };
  });

  /** The check before Go live: changes nothing, takes a few seconds (account and server checks run in parallel). */
  app.post('/api/streams/:id/preflight', operator, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const r = await preflight(sql, media, health, id);
    if (!r) throw new HttpError(404, 'not_found');
    return r;
  });
}
