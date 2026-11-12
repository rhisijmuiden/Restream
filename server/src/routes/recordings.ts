import type { FastifyInstance } from 'fastify';
import { createReadStream, statSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { HttpError, requireAuth } from '../lib/guards.js';
import { audit } from '../lib/audit.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { recordingsDir, removeRecordingFile } from '../lib/recordings.js';
import type { MediaSupervisor } from '../media/supervisor.js';

const idParam = z.object({ id: z.uuid() });

interface RecRow {
  id: string; stream_id: string | null; stream_name: string; event_id: string | null; title: string; file: string; status: string;
  size_bytes: string; duration_seconds: number; video: string | null; audio: string | null; error: string | null;
  started_at: Date; ended_at: Date | null; started_by_name: string | null;
}

/** "Sunday service 12-11-2026.mp4" style names, without characters that break a download. */
function downloadName(r: RecRow) {
  const base = (r.title || r.stream_name || 'recording').replace(/[^\p{L}\p{N} ._-]+/gu, '').trim().slice(0, 80) || 'recording';
  const stamp = r.started_at.toISOString().slice(0, 16).replace('T', ' ').replace(':', 'h');
  return `${base} ${stamp}.mp4`;
}

export async function recordingRoutes(app: FastifyInstance, { sql, media }: { sql: Sql; media: MediaSupervisor }) {
  const viewer = { preHandler: requireAuth('viewer') };
  const operator = { preHandler: requireAuth('operator') };
  const admin = { preHandler: requireAuth('admin') };

  async function getRec(id: string) {
    const [r] = await sql<RecRow[]>`
      SELECT r.*, u.name AS started_by_name FROM recordings r LEFT JOIN users u ON u.id = r.started_by WHERE r.id = ${id}`;
    if (!r) throw new HttpError(404, 'not_found');
    return r;
  }

  app.get('/api/recordings', viewer, async () => {
    const rows = await sql<RecRow[]>`
      SELECT r.*, COALESCE(NULLIF(u.name, ''), u.email) AS started_by_name
      FROM recordings r LEFT JOIN users u ON u.id = r.started_by ORDER BY r.started_at DESC LIMIT 500`;
    const s = await getSettings(sql);
    let disk: { totalBytes: number; freeBytes: number } | null = null;
    try {
      const fs = statfsSync(recordingsDir());
      disk = { totalBytes: fs.blocks * fs.bsize, freeBytes: fs.bavail * fs.bsize };
    } catch { /* directory does not exist yet */ }
    const [{ used }] = await sql<{ used: string }[]>`SELECT COALESCE(sum(size_bytes), 0)::text AS used FROM recordings`;
    return {
      retentionDays: s.recordings.retentionDays,
      disk,
      usedBytes: Number(used),
      recordings: rows.map((r) => {
        const live = r.status === 'recording' ? media.activeRecording(r.id) : null;
        return {
          id: r.id, streamId: r.stream_id, streamName: r.stream_name, eventId: r.event_id, title: r.title, status: r.status,
          sizeBytes: live?.sizeBytes ?? Number(r.size_bytes), durationSeconds: live?.durationSeconds ?? r.duration_seconds,
          video: r.video, audio: r.audio, error: r.error, startedAt: r.started_at, endedAt: r.ended_at, startedBy: r.started_by_name,
          fileName: downloadName(r),
        };
      }),
    };
  });

  app.patch('/api/recordings/:id', operator, async (req) => {
    const { id } = idParam.parse(req.params);
    const { title } = z.object({ title: z.string().trim().max(100) }).parse(req.body);
    await getRec(id);
    await sql`UPDATE recordings SET title = ${title} WHERE id = ${id}`;
    return { ok: true };
  });

  app.delete('/api/recordings/:id', operator, async (req) => {
    const { id } = idParam.parse(req.params);
    const r = await getRec(id);
    if (r.status === 'recording') throw new HttpError(409, 'recording_active');
    removeRecordingFile(r.file);
    await sql`DELETE FROM recordings WHERE id = ${id}`;
    await audit(sql, req, 'recording.deleted', { id, stream: r.stream_name, startedAt: r.started_at });
    return { ok: true };
  });

  app.put('/api/recordings/settings', admin, async (req) => {
    const { retentionDays } = z.object({ retentionDays: z.number().int().min(0).max(3650) }).parse(req.body);
    await setSettings(sql, { recordings: { retentionDays } });
    await audit(sql, req, 'recordings.settings', { retentionDays });
    return { ok: true };
  });

  /** The MP4 file, with Range support so it can be watched (and seeked) in the browser. ?download=1 saves it. */
  app.get('/api/recordings/:id/file', viewer, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { download } = z.object({ download: z.string().optional() }).parse(req.query);
    const r = await getRec(id);
    const file = path.join(recordingsDir(), r.file);
    let size: number;
    try { size = statSync(file).size; } catch { throw new HttpError(404, 'file_missing'); }

    reply.header('accept-ranges', 'bytes').header('cache-control', 'private, no-store').type('video/mp4');
    const name = downloadName(r);
    reply.header('content-disposition', `${download ? 'attachment' : 'inline'}; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`);

    const range = typeof req.headers.range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range.trim()) : null;
    if (range && (range[1] || range[2])) {
      let start: number; let end: number;
      if (range[1]) { start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1; }
      else { start = Math.max(0, size - Number(range[2])); end = size - 1; }
      if (start > end || start >= size) return reply.status(416).header('content-range', `bytes */${size}`).send();
      reply.status(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', String(end - start + 1));
      return reply.send(createReadStream(file, { start, end }));
    }
    if (download) await audit(sql, req, 'recording.downloaded', { id, stream: r.stream_name });
    reply.header('content-length', String(size));
    return reply.send(createReadStream(file));
  });
}
