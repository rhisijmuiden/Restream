import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { config } from '../config.js';
import { HttpError, requireAuth } from '../lib/guards.js';
import { decrypt, encrypt, sha256 } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { getSettings } from '../lib/settings.js';
import { ingestPath, kickPublisher, listPaths } from '../media/mediamtx.js';
import { platforms, presets, serverUrlProblem, unsafeSrtValue, type Platform } from '../media/platforms.js';
import type { MediaSupervisor } from '../media/supervisor.js';

const base62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function randomString(len: number, alphabet = base62) {
  const bytes = randomBytes(len * 2);
  let out = '';
  for (let i = 0; out.length < len; i++) {
    const b = bytes[i % bytes.length];
    if (b < 256 - (256 % alphabet.length)) out += alphabet[b % alphabet.length];
    if (i > len * 8) return randomString(len, alphabet);
  }
  return out;
}
export const newIngestKey = () => `rs${randomString(30)}`;
const newPlaybackId = () => randomString(12, 'abcdefghijkmnopqrstuvwxyz23456789');

const idParam = z.object({ id: z.uuid() });

interface StreamRow {
  id: string; name: string; ingest_key_enc: string; playback_id: string; playback_enabled: boolean; enabled: boolean; created_at: Date;
}
interface DestRow {
  id: string; stream_id: string; name: string; platform: Platform; server_url: string; stream_key_enc: string; passphrase_enc: string;
  enabled: boolean; mode: 'copy' | 'transcode'; video_bitrate: number; audio_bitrate: number; max_height: number; fps: number | null;
  live: boolean; live_since: Date | null; position: number;
}

const mask = (enc: string) => {
  if (!enc) return '';
  const v = decrypt(enc);
  return v.length <= 6 ? '••••' : `••••${v.slice(-4)}`;
};

const destinationBody = z.object({
  name: z.string().trim().min(1).max(60),
  platform: z.enum(platforms),
  serverUrl: z.string().trim().max(500).optional(),
  /** Omitted keeps the stored key, an empty string clears it. */
  streamKey: z.string().trim().max(500).regex(/^[^\s]*$/).optional(),
  /** SRT encryption passphrase: 10 to 79 characters. */
  passphrase: z.union([z.literal(''), z.string().min(10).max(79)]).optional(),
  enabled: z.boolean().default(true),
  mode: z.enum(['copy', 'transcode']).default('copy'),
  videoBitrate: z.number().int().min(300).max(20000).default(6000),
  audioBitrate: z.number().int().min(64).max(320).default(160),
  maxHeight: z.union([z.literal(480), z.literal(720), z.literal(1080)]).default(1080),
  fps: z.union([z.literal(25), z.literal(30), z.literal(50), z.literal(60), z.null()]).default(null),
});

export async function streamRoutes(app: FastifyInstance, { sql, media }: { sql: Sql; media: MediaSupervisor }) {
  const viewer = { preHandler: requireAuth('viewer') };
  const operator = { preHandler: requireAuth('operator') };
  const admin = { preHandler: requireAuth('admin') };

  async function publicBase(req: FastifyRequest) {
    const s = await getSettings(sql);
    const url = s.publicUrl || `${req.protocol}://${req.headers.host ?? 'localhost'}`;
    return url.replace(/\/+$/, '');
  }

  async function view(req: FastifyRequest) {
    const canSeeKeys = req.user!.role !== 'viewer';
    const base = await publicBase(req);
    const host = new URL(base).hostname;
    const { rtmpPort, srtPort } = config.media;
    const streams = await sql<StreamRow[]>`SELECT * FROM streams ORDER BY created_at`;
    const dests = await sql<DestRow[]>`SELECT * FROM destinations ORDER BY position, created_at`;
    return {
      mediaEnabled: config.media.enabled,
      mediamtxOnline: media.mediamtxOnline,
      streams: streams.map((s) => {
        const key = canSeeKeys ? decrypt(s.ingest_key_enc) : null;
        const rtmpServer = `rtmp://${host}${rtmpPort === 1935 ? '' : `:${rtmpPort}`}/live`;
        return {
          id: s.id,
          name: s.name,
          enabled: s.enabled,
          playbackEnabled: s.playback_enabled,
          playbackId: s.playback_id,
          createdAt: s.created_at,
          ingest: {
            rtmpServer,
            streamKey: key,
            rtmpUrl: key ? `${rtmpServer}/${key}` : null,
            srtUrl: key ? `srt://${host}:${srtPort}?streamid=publish:${ingestPath(key)}` : null,
          },
          playback: {
            hls: `${base}/live/${s.playback_id}/index.m3u8`,
            whep: `${base}/live/${s.playback_id}/whep`,
            hlsPage: `${base}/live/${s.playback_id}/`,
            webrtcPage: `${base}/live/${s.playback_id}/webrtc/`,
          },
          status: media.ingestState(s.id),
          destinations: dests.filter((d) => d.stream_id === s.id).map((d) => ({
            id: d.id,
            name: d.name,
            platform: d.platform,
            serverUrl: d.server_url,
            streamKeyMasked: mask(d.stream_key_enc),
            passphraseSet: !!d.passphrase_enc,
            enabled: d.enabled,
            mode: d.mode,
            videoBitrate: d.video_bitrate,
            audioBitrate: d.audio_bitrate,
            maxHeight: d.max_height,
            fps: d.fps,
            live: d.live,
            liveSince: d.live_since,
            status: d.live ? media.outputState(d.id) : { ...media.outputState(d.id), state: 'off' as const },
          })),
        };
      }),
    };
  }

  app.get('/api/streams', viewer, async (req) => view(req));

  app.get('/api/platforms', viewer, async () => presets);

  app.post('/api/streams', operator, async (req) => {
    const body = z.object({ name: z.string().trim().min(1).max(60) }).parse(req.body);
    const key = newIngestKey();
    const [s] = await sql<{ id: string }[]>`
      INSERT INTO streams (name, ingest_key_hash, ingest_key_enc, playback_id)
      VALUES (${body.name}, ${sha256(key)}, ${encrypt(key)}, ${newPlaybackId()}) RETURNING id`;
    await audit(sql, req, 'stream.created', { id: s.id, name: body.name });
    media.nudge();
    return { id: s.id };
  });

  async function getStream(id: string) {
    const [s] = await sql<StreamRow[]>`SELECT * FROM streams WHERE id = ${id}`;
    if (!s) throw new HttpError(404, 'not_found');
    return s;
  }

  async function kick(key: string) {
    if (!config.media.enabled) return;
    try {
      const p = (await listPaths()).find((x) => x.name === ingestPath(key));
      if (p) await kickPublisher(p);
    } catch { /* MediaMTX offline: nothing to kick */ }
  }

  app.patch('/api/streams/:id', operator, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({
      name: z.string().trim().min(1).max(60).optional(),
      enabled: z.boolean().optional(),
      playbackEnabled: z.boolean().optional(),
    }).parse(req.body);
    const s = await getStream(id);
    await sql`
      UPDATE streams SET name = COALESCE(${body.name ?? null}, name), enabled = COALESCE(${body.enabled ?? null}, enabled),
             playback_enabled = COALESCE(${body.playbackEnabled ?? null}, playback_enabled), updated_at = now()
      WHERE id = ${id}`;
    if (body.enabled === false) await kick(decrypt(s.ingest_key_enc));
    await audit(sql, req, 'stream.updated', { id, ...body });
    media.nudge();
    return { ok: true };
  });

  app.post('/api/streams/:id/rotate-key', operator, async (req) => {
    const { id } = idParam.parse(req.params);
    const s = await getStream(id);
    const key = newIngestKey();
    await sql`UPDATE streams SET ingest_key_hash = ${sha256(key)}, ingest_key_enc = ${encrypt(key)}, updated_at = now() WHERE id = ${id}`;
    await kick(decrypt(s.ingest_key_enc));
    await audit(sql, req, 'stream.key_rotated', { id });
    media.nudge();
    return { ok: true };
  });

  app.delete('/api/streams/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params);
    const s = await getStream(id);
    await sql`DELETE FROM streams WHERE id = ${id}`;
    await kick(decrypt(s.ingest_key_enc));
    await audit(sql, req, 'stream.deleted', { id, name: s.name });
    media.nudge();
    return { ok: true };
  });

  /** Go live / stop for every destination of a stream. Go live only starts destinations marked "included". */
  app.post('/api/streams/:id/live', operator, async (req) => {
    const { id } = idParam.parse(req.params);
    const { live } = z.object({ live: z.boolean() }).parse(req.body);
    await getStream(id);
    const r = live
      ? await sql`UPDATE destinations SET live = true, live_since = COALESCE(live_since, now()), updated_at = now() WHERE stream_id = ${id} AND enabled AND NOT live`
      : await sql`UPDATE destinations SET live = false, live_since = NULL, updated_at = now() WHERE stream_id = ${id} AND live`;
    await audit(sql, req, live ? 'stream.live' : 'stream.stopped', { id, destinations: r.count });
    media.nudge();
    return { ok: true, changed: r.count };
  });

  function checkDestination(platform: Platform, serverUrl: string, body: { streamKey?: string; passphrase?: string }) {
    const problem = serverUrlProblem(platform, serverUrl);
    if (problem) throw new HttpError(400, problem);
    if (platform === 'srt' && [body.streamKey, body.passphrase].some((v) => v && unsafeSrtValue.test(v))) throw new HttpError(400, 'invalid_srt_value');
  }

  app.post('/api/streams/:id/destinations', operator, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = destinationBody.parse(req.body);
    await getStream(id);
    const serverUrl = body.serverUrl || presets[body.platform].server;
    checkDestination(body.platform, serverUrl, body);
    if (presets[body.platform].keyRequired && !body.streamKey) throw new HttpError(400, 'stream_key_required');
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM destinations WHERE stream_id = ${id}`;
    if (n >= 20) throw new HttpError(400, 'too_many_destinations');
    const [d] = await sql<{ id: string }[]>`
      INSERT INTO destinations (stream_id, name, platform, server_url, stream_key_enc, passphrase_enc, enabled, mode,
                                video_bitrate, audio_bitrate, max_height, fps, position)
      VALUES (${id}, ${body.name}, ${body.platform}, ${serverUrl}, ${body.streamKey ? encrypt(body.streamKey) : ''},
              ${body.passphrase ? encrypt(body.passphrase) : ''}, ${body.enabled}, ${body.mode},
              ${body.videoBitrate}, ${body.audioBitrate}, ${body.maxHeight}, ${body.fps}, ${n})
      RETURNING id`;
    await audit(sql, req, 'destination.created', { id: d.id, stream: id, platform: body.platform, name: body.name });
    return { id: d.id };
  });

  async function getDestination(id: string) {
    const [d] = await sql<DestRow[]>`SELECT * FROM destinations WHERE id = ${id}`;
    if (!d) throw new HttpError(404, 'not_found');
    return d;
  }

  app.put('/api/destinations/:id', operator, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = destinationBody.parse(req.body);
    const cur = await getDestination(id);
    if (body.platform !== cur.platform) throw new HttpError(400, 'platform_change');
    const serverUrl = body.serverUrl || presets[body.platform].server;
    checkDestination(body.platform, serverUrl, body);
    const keyEnc = body.streamKey === undefined ? cur.stream_key_enc : body.streamKey ? encrypt(body.streamKey) : '';
    if (presets[body.platform].keyRequired && !keyEnc) throw new HttpError(400, 'stream_key_required');
    const passEnc = body.passphrase === undefined ? cur.passphrase_enc : body.passphrase ? encrypt(body.passphrase) : '';
    await sql`
      UPDATE destinations SET name = ${body.name}, server_url = ${serverUrl}, stream_key_enc = ${keyEnc}, passphrase_enc = ${passEnc},
             enabled = ${body.enabled}, mode = ${body.mode}, video_bitrate = ${body.videoBitrate}, audio_bitrate = ${body.audioBitrate},
             max_height = ${body.maxHeight}, fps = ${body.fps}, updated_at = now()
      WHERE id = ${id}`;
    await audit(sql, req, 'destination.updated', { id, name: body.name, keyChanged: body.streamKey !== undefined });
    media.nudge();
    return { ok: true };
  });

  app.delete('/api/destinations/:id', operator, async (req) => {
    const { id } = idParam.parse(req.params);
    const d = await getDestination(id);
    await sql`DELETE FROM destinations WHERE id = ${id}`;
    await audit(sql, req, 'destination.deleted', { id, name: d.name });
    media.nudge();
    return { ok: true };
  });

  app.post('/api/destinations/:id/live', operator, async (req) => {
    const { id } = idParam.parse(req.params);
    const { live } = z.object({ live: z.boolean() }).parse(req.body);
    const d = await getDestination(id);
    await sql`UPDATE destinations SET live = ${live}, live_since = ${live ? (d.live_since ?? new Date()) : null}, updated_at = now() WHERE id = ${id}`;
    await audit(sql, req, live ? 'destination.live' : 'destination.stopped', { id, name: d.name });
    media.nudge();
    return { ok: true };
  });
}
