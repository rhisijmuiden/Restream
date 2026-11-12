import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { HttpError, requireAuth } from '../lib/guards.js';
import { audit } from '../lib/audit.js';
import type { LiveMonitor } from '../live/monitor.js';
import { summarise } from '../live/stats.js';

const idParam = z.object({ id: z.uuid() });

interface BroadcastRow {
  id: string; stream_id: string | null; stream_name: string; event_id: string | null; title: string;
  started_at: Date; last_live_at: Date; ended_at: Date | null; peak_viewers: number; avg_viewers: number; chat_messages: number;
}
interface OutputRow {
  id: string; broadcast_id: string; destination_id: string | null; platform: string; name: string; watch_url: string | null;
  stats: boolean; peak_viewers: number; avg_viewers: number; chat_messages: number;
}
interface ChatRow { seq: string; output_id: string; platform: string; author: string; text: string; highlight: string | null; at: Date }

const chatView = (names: Map<string, string>) => (m: ChatRow) => ({
  seq: Number(m.seq), outputId: m.output_id, destination: names.get(m.output_id) ?? '', platform: m.platform,
  author: m.author, text: m.text, highlight: m.highlight, at: m.at,
});

/** Live viewers and combined chat for the dashboard, and the statistics of past broadcasts. */
export async function liveRoutes(app: FastifyInstance, { sql, live }: { sql: Sql; live: LiveMonitor }) {
  const viewer = { preHandler: requireAuth('viewer') };
  const admin = { preHandler: requireAuth('admin') };

  async function view(b: BroadcastRow) {
    const outs = await sql<OutputRow[]>`SELECT * FROM broadcast_outputs WHERE broadcast_id = ${b.id} ORDER BY stats DESC, name`;
    const running = !b.ended_at;
    const s = running ? await summarise(sql, b.id) : null;
    const per = new Map(s?.outputs.map((o) => [o.outputId, o]));
    const end = b.ended_at ?? b.last_live_at;
    return {
      id: b.id, streamId: b.stream_id, streamName: b.stream_name, eventId: b.event_id, title: b.title,
      startedAt: b.started_at, endedAt: b.ended_at, live: running,
      durationSeconds: Math.max(0, Math.round(((running ? Date.now() : end.getTime()) - b.started_at.getTime()) / 1000)),
      peakViewers: s?.peak ?? b.peak_viewers,
      avgViewers: s?.avg ?? b.avg_viewers,
      chatMessages: s?.chat ?? b.chat_messages,
      currentViewers: s?.current ?? null,
      outputs: outs.map((o) => ({
        id: o.id, destinationId: o.destination_id, platform: o.platform, name: o.name, watchUrl: o.watch_url, stats: o.stats,
        peakViewers: per.get(o.id)?.peak ?? o.peak_viewers, avgViewers: per.get(o.id)?.avg ?? o.avg_viewers, chatMessages: per.get(o.id)?.chat ?? o.chat_messages,
      })),
    };
  }

  /**
   * Polled by the dashboard every few seconds: the running broadcast of a stream with its viewers per destination,
   * and the chat messages after `after` (the last 100 when it is left out).
   */
  app.get('/api/streams/:id/live', viewer, async (req) => {
    const { id } = idParam.parse(req.params);
    const { after } = z.object({ after: z.coerce.number().int().min(0).optional() }).parse(req.query);
    const [st] = await sql<{ id: string }[]>`SELECT id FROM streams WHERE id = ${id}`;
    if (!st) throw new HttpError(404, 'not_found');
    const dests = await sql<{ id: string; name: string; platform: string }[]>`SELECT id, name, platform FROM destinations WHERE stream_id = ${id} ORDER BY position, created_at`;
    const destinations = dests.map((d) => {
      const l = live.outputLive(d.id);
      return { destinationId: d.id, name: d.name, platform: d.platform, onAir: !!l, ...(l ?? { supported: false, viewers: null, updatedAt: null, error: null, chat: 'off', chatError: null }) };
    });
    const [b] = await sql<BroadcastRow[]>`SELECT * FROM broadcasts WHERE stream_id = ${id} AND ended_at IS NULL`;
    if (!b) return { broadcast: null, destinations, totalViewers: null, chat: [], cursor: after ?? 0 };
    const outs = await sql<{ id: string; name: string }[]>`SELECT id, name FROM broadcast_outputs WHERE broadcast_id = ${b.id}`;
    const names = new Map(outs.map((o) => [o.id, o.name]));
    const rows = after === undefined
      ? (await sql<ChatRow[]>`SELECT * FROM chat_messages WHERE broadcast_id = ${b.id} ORDER BY seq DESC LIMIT 100`).reverse()
      : await sql<ChatRow[]>`SELECT * FROM chat_messages WHERE broadcast_id = ${b.id} AND seq > ${after} ORDER BY seq LIMIT 300`;
    const known = destinations.filter((d) => d.supported && d.viewers !== null);
    const [max] = await sql<{ seq: string | null }[]>`SELECT max(seq)::text AS seq FROM chat_messages WHERE broadcast_id = ${b.id}`;
    return {
      broadcast: await view(b),
      destinations,
      totalViewers: known.length ? known.reduce((n, d) => n + (d.viewers ?? 0), 0) : null,
      chat: rows.map(chatView(names)),
      cursor: rows.length ? Number(rows[rows.length - 1].seq) : after ?? Number(max?.seq ?? 0),
    };
  });

  app.get('/api/broadcasts', viewer, async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.iso.datetime({ offset: true }).optional() }).parse(req.query);
    const rows = q.before
      ? await sql<BroadcastRow[]>`SELECT * FROM broadcasts WHERE started_at < ${new Date(q.before)} ORDER BY started_at DESC LIMIT ${q.limit}`
      : await sql<BroadcastRow[]>`SELECT * FROM broadcasts ORDER BY started_at DESC LIMIT ${q.limit}`;
    return { broadcasts: await Promise.all(rows.map(view)) };
  });

  async function load(id: string) {
    const [b] = await sql<BroadcastRow[]>`SELECT * FROM broadcasts WHERE id = ${id}`;
    if (!b) throw new HttpError(404, 'not_found');
    return b;
  }

  /** One broadcast with its viewer curve (total and per destination). */
  app.get('/api/broadcasts/:id', viewer, async (req) => {
    const b = await load(idParam.parse(req.params).id);
    const samples = await sql<{ at: Date; output_id: string; viewers: number }[]>`
      SELECT at, output_id, viewers FROM viewer_samples WHERE broadcast_id = ${b.id} ORDER BY at`;
    const series: { at: Date; total: number; outputs: Record<string, number> }[] = [];
    for (const s of samples) {
      let last = series[series.length - 1];
      if (!last || last.at.getTime() !== s.at.getTime()) { last = { at: s.at, total: 0, outputs: {} }; series.push(last); }
      last.total += s.viewers;
      last.outputs[s.output_id] = s.viewers;
    }
    return { ...(await view(b)), series };
  });

  app.get('/api/broadcasts/:id/chat', viewer, async (req) => {
    const b = await load(idParam.parse(req.params).id);
    const q = z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(1000).default(500) }).parse(req.query);
    const names = new Map((await sql<{ id: string; name: string }[]>`SELECT id, name FROM broadcast_outputs WHERE broadcast_id = ${b.id}`).map((o) => [o.id, o.name]));
    const rows = await sql<ChatRow[]>`SELECT * FROM chat_messages WHERE broadcast_id = ${b.id} AND seq > ${q.after} ORDER BY seq LIMIT ${q.limit}`;
    return { messages: rows.map(chatView(names)), more: rows.length === q.limit };
  });

  /** The whole chat as CSV (UTF-8 with BOM so Excel shows accents correctly). */
  app.get('/api/broadcasts/:id/chat.csv', viewer, async (req, reply) => {
    const b = await load(idParam.parse(req.params).id);
    const names = new Map((await sql<{ id: string; name: string }[]>`SELECT id, name FROM broadcast_outputs WHERE broadcast_id = ${b.id}`).map((o) => [o.id, o.name]));
    const rows = await sql<ChatRow[]>`SELECT * FROM chat_messages WHERE broadcast_id = ${b.id} ORDER BY at, seq`;
    // Quote every field; a leading =,+,-,@ would be read as a formula by spreadsheets.
    const cell = (v: string) => `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;
    const lines = [['time', 'platform', 'destination', 'author', 'message', 'amount'].join(',')];
    for (const m of rows) lines.push([m.at.toISOString(), m.platform, names.get(m.output_id) ?? '', m.author, m.text, m.highlight ?? ''].map(cell).join(','));
    const date = b.started_at.toISOString().slice(0, 10);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="chat-${date}-${b.id.slice(0, 8)}.csv"`)
      .send(`﻿${lines.join('\r\n')}\r\n`);
  });

  app.delete('/api/broadcasts/:id', admin, async (req) => {
    const b = await load(idParam.parse(req.params).id);
    if (!b.ended_at) throw new HttpError(409, 'broadcast_running');
    await sql`DELETE FROM broadcasts WHERE id = ${b.id}`;
    await audit(sql, req, 'broadcast.delete', { id: b.id, title: b.title, startedAt: b.started_at });
    return { ok: true };
  });
}
