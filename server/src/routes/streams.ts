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
import { accountPlatforms, platforms, presets, serverUrlProblem, unsafeSrtValue, type Platform } from '../media/platforms.js';
import { fallbackDir, fallbackImagePath, imageType } from '../lib/fallback.js';
import { mkdir, rm, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { MediaSupervisor } from '../media/supervisor.js';
import type { PlaybackCache } from './media.js';
import type { Provisioner } from '../platforms/provisioner.js';
import { createPlaybackToken, normaliseDomain } from '../lib/playback.js';

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
  allowed_domains: string[]; require_token: boolean; token_secret: string; record: boolean; auto_record: boolean; title: string; description: string;
  backup_key_enc: string | null; fallback_mode: 'off' | 'standard' | 'image'; fallback_image: string | null; fallback_minutes: number; switch_back_seconds: number;
}
interface DestRow {
  id: string; stream_id: string; name: string; platform: Platform; server_url: string; stream_key_enc: string; passphrase_enc: string;
  enabled: boolean; mode: 'copy' | 'transcode'; video_bitrate: number; audio_bitrate: number; max_height: number; fps: number | null;
  live: boolean; live_since: Date | null; position: number; orientation: 'landscape' | 'portrait';
  auth: 'key' | 'account'; account_id: string | null; privacy: 'public' | 'unlisted' | 'private'; watch_url: string | null; prepare_error: string | null;
}
interface AccountRow { id: string; provider: string; name: string; image_url: string; status: string }

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
  /** Portrait crops the middle 9:16 (Instagram); only applies when transcoding. */
  orientation: z.enum(['landscape', 'portrait']).default('landscape'),
  /** 'account': the ingest comes from a connected YouTube/Facebook/Twitch account instead of a typed stream key. */
  auth: z.enum(['key', 'account']).default('key'),
  accountId: z.uuid().nullable().default(null),
  /** Visibility of broadcasts Restream creates on a connected account (YouTube; Facebook pages are public). */
  privacy: z.enum(['public', 'unlisted', 'private']).default('public'),
});

export async function streamRoutes(app: FastifyInstance, { sql, media, playback, provisioner }: { sql: Sql; media: MediaSupervisor; playback: PlaybackCache; provisioner: Provisioner }) {
  /** Runs the platform and media passes now, after a change in the console. */
  const nudge = () => { provisioner.nudge(); media.nudge(); };
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
    const accounts = new Map((await sql<AccountRow[]>`SELECT id, provider, name, image_url, status FROM platform_accounts`).map((a) => [a.id, a]));
    return {
      mediaEnabled: config.media.enabled,
      mediamtxOnline: media.mediamtxOnline,
      streams: streams.map((s) => {
        const key = canSeeKeys ? decrypt(s.ingest_key_enc) : null;
        const bkey = canSeeKeys && s.backup_key_enc ? decrypt(s.backup_key_enc) : null;
        const rtmpServer = `rtmp://${host}${rtmpPort === 1935 ? '' : `:${rtmpPort}`}/live`;
        return {
          id: s.id,
          name: s.name,
          enabled: s.enabled,
          playbackEnabled: s.playback_enabled,
          playbackId: s.playback_id,
          createdAt: s.created_at,
          allowedDomains: s.allowed_domains,
          requireToken: s.require_token,
          record: s.record,
          autoRecord: s.auto_record,
          title: s.title,
          description: s.description,
          recording: media.recordingState(s.id),
          ingest: {
            rtmpServer,
            streamKey: key,
            rtmpUrl: key ? `${rtmpServer}/${key}` : null,
            srtUrl: key ? `srt://${host}:${srtPort}?streamid=publish:${ingestPath(key)}` : null,
          },
          backupIngest: {
            configured: !!s.backup_key_enc,
            streamKey: bkey,
            rtmpUrl: bkey ? `${rtmpServer}/${bkey}` : null,
            srtUrl: bkey ? `srt://${host}:${srtPort}?streamid=publish:${ingestPath(bkey)}` : null,
          },
          fallback: {
            mode: s.fallback_mode,
            imageSet: !!s.fallback_image,
            minutes: s.fallback_minutes,
            switchBackSeconds: s.switch_back_seconds,
          },
          source: { ...media.sourceState(s.id), backupConfigured: !!s.backup_key_enc },
          playback: {
            hls: `${base}/live/${s.playback_id}/index.m3u8`,
            whep: `${base}/live/${s.playback_id}/whep`,
            hlsPage: `${base}/live/${s.playback_id}/`,
            webrtcPage: `${base}/live/${s.playback_id}/webrtc/`,
            embed: `${base}/embed/${s.playback_id}`,
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
            orientation: d.orientation,
            live: d.live,
            liveSince: d.live_since,
            auth: d.auth,
            account: d.account_id && accounts.has(d.account_id)
              ? { id: d.account_id, name: accounts.get(d.account_id)!.name, imageUrl: accounts.get(d.account_id)!.image_url, status: accounts.get(d.account_id)!.status }
              : null,
            privacy: d.privacy,
            watchUrl: d.live ? d.watch_url : null,
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
    nudge();
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
      /** Sites that may embed the player and play the stream; empty = everywhere. */
      allowedDomains: z.array(z.string().max(260)).max(50).optional(),
      requireToken: z.boolean().optional(),
      autoRecord: z.boolean().optional(),
      title: z.string().trim().max(100).optional(),
      description: z.string().trim().max(5000).optional(),
      fallbackMode: z.enum(['off', 'standard', 'image']).optional(),
      fallbackMinutes: z.number().int().min(1).max(720).optional(),
      switchBackSeconds: z.number().int().min(0).max(600).optional(),
    }).parse(req.body);
    const s = await getStream(id);
    if (body.fallbackMode === 'image' && !s.fallback_image) throw new HttpError(400, 'fallback_image_missing');
    let domains: string[] | null = null;
    if (body.allowedDomains) {
      const bad = body.allowedDomains.filter((d) => d.trim() && !normaliseDomain(d));
      if (bad.length) throw new HttpError(400, 'invalid_domain', undefined, bad.join(', '));
      domains = [...new Set(body.allowedDomains.map(normaliseDomain).filter((d): d is string => !!d))];
    }
    await sql`
      UPDATE streams SET name = COALESCE(${body.name ?? null}, name), enabled = COALESCE(${body.enabled ?? null}, enabled),
             playback_enabled = COALESCE(${body.playbackEnabled ?? null}, playback_enabled),
             allowed_domains = COALESCE(${domains}::text[], allowed_domains),
             require_token = COALESCE(${body.requireToken ?? null}, require_token),
             auto_record = COALESCE(${body.autoRecord ?? null}, auto_record),
             title = COALESCE(${body.title ?? null}, title),
             description = COALESCE(${body.description ?? null}, description),
             fallback_mode = COALESCE(${body.fallbackMode ?? null}, fallback_mode),
             fallback_minutes = COALESCE(${body.fallbackMinutes ?? null}, fallback_minutes),
             switch_back_seconds = COALESCE(${body.switchBackSeconds ?? null}, switch_back_seconds),
             updated_at = now()
      WHERE id = ${id}`;
    if (body.enabled === false) {
      await kick(decrypt(s.ingest_key_enc));
      if (s.backup_key_enc) await kick(decrypt(s.backup_key_enc));
    }
    playback.clear();
    await audit(sql, req, 'stream.updated', { id, ...body, description: undefined });
    nudge();
    return { ok: true };
  });

  /** Creates a signed playback link (embed, HLS, WebRTC) that works while the stream requires a token or limits domains. */
  app.post('/api/streams/:id/playback-token', operator, async (req) => {
    const { id } = idParam.parse(req.params);
    const { days } = z.object({ days: z.number().int().min(1).max(3650).nullable() }).parse(req.body);
    const s = await getStream(id);
    const exp = days === null ? null : new Date(Date.now() + days * 86_400_000);
    const token = createPlaybackToken(s.playback_id, s.token_secret, exp);
    const base = await publicBase(req);
    await audit(sql, req, 'stream.token_created', { id, days });
    return {
      token,
      expiresAt: exp,
      embed: `${base}/embed/${s.playback_id}?token=${token}`,
      hls: `${base}/live/${s.playback_id}~${token}/index.m3u8`,
      whep: `${base}/live/${s.playback_id}~${token}/whep`,
    };
  });

  /** Revokes every playback token of the stream (also the ones embedded pages currently use). */
  app.post('/api/streams/:id/revoke-tokens', operator, async (req) => {
    const { id } = idParam.parse(req.params);
    await getStream(id);
    await sql`UPDATE streams SET token_secret = replace(gen_random_uuid()::text, '-', ''), updated_at = now() WHERE id = ${id}`;
    playback.clear();
    await audit(sql, req, 'stream.tokens_revoked', { id });
    return { ok: true };
  });

  /** Starts or stops recording. While the ingest is offline the recording waits and starts when it comes in. */
  app.post('/api/streams/:id/record', operator, async (req) => {
    const { id } = idParam.parse(req.params);
    const { record } = z.object({ record: z.boolean() }).parse(req.body);
    await getStream(id);
    await sql`UPDATE streams SET record = ${record}, record_by = ${record ? req.user!.id : null}, updated_at = now() WHERE id = ${id}`;
    await audit(sql, req, record ? 'recording.started' : 'recording.stopped', { stream: id });
    nudge();
    return { ok: true };
  });

  app.post('/api/streams/:id/rotate-key', operator, async (req) => {
    const { id } = idParam.parse(req.params);
    const s = await getStream(id);
    const key = newIngestKey();
    await sql`UPDATE streams SET ingest_key_hash = ${sha256(key)}, ingest_key_enc = ${encrypt(key)}, updated_at = now() WHERE id = ${id}`;
    await kick(decrypt(s.ingest_key_enc));
    await audit(sql, req, 'stream.key_rotated', { id });
    nudge();
    return { ok: true };
  });

  /** Creates (or replaces) the backup ingest key; `enabled: false` removes it and disconnects the backup encoder. */
  app.post('/api/streams/:id/backup-key', operator, async (req) => {
    const { id } = idParam.parse(req.params);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const s = await getStream(id);
    if (enabled) {
      const key = newIngestKey();
      await sql`UPDATE streams SET backup_key_hash = ${sha256(key)}, backup_key_enc = ${encrypt(key)}, updated_at = now() WHERE id = ${id}`;
    } else {
      await sql`UPDATE streams SET backup_key_hash = NULL, backup_key_enc = NULL, updated_at = now() WHERE id = ${id}`;
    }
    if (s.backup_key_enc) await kick(decrypt(s.backup_key_enc));
    await audit(sql, req, enabled ? (s.backup_key_enc ? 'stream.backup_key_rotated' : 'stream.backup_key_created') : 'stream.backup_key_removed', { id });
    nudge();
    return { ok: true };
  });

  // Fallback image: PNG or JPEG, sent as the raw request body.
  for (const type of ['image/png', 'image/jpeg']) {
    app.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: 8 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  }

  app.put('/api/streams/:id/fallback-image', operator, async (req) => {
    const { id } = idParam.parse(req.params);
    const s = await getStream(id);
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    const ext = buf ? imageType(buf) : null;
    if (!buf || !ext) throw new HttpError(400, 'invalid_image');
    const dir = fallbackDir();
    await mkdir(dir, { recursive: true });
    // A new name per upload, so a running fallback output notices the change and restarts with the new image.
    const file = `${id}-${Date.now().toString(36)}.${ext}`;
    await writeFile(path.join(dir, `${file}.tmp`), buf);
    await rename(path.join(dir, `${file}.tmp`), path.join(dir, file));
    await sql`UPDATE streams SET fallback_image = ${file}, fallback_mode = 'image', updated_at = now() WHERE id = ${id}`;
    if (s.fallback_image) await rm(path.join(dir, s.fallback_image), { force: true });
    await audit(sql, req, 'stream.fallback_image_uploaded', { id, bytes: buf.length });
    nudge();
    return { ok: true };
  });

  app.delete('/api/streams/:id/fallback-image', operator, async (req) => {
    const { id } = idParam.parse(req.params);
    const s = await getStream(id);
    await sql`
      UPDATE streams SET fallback_image = NULL, fallback_mode = CASE WHEN fallback_mode = 'image' THEN 'standard' ELSE fallback_mode END,
             updated_at = now()
      WHERE id = ${id}`;
    if (s.fallback_image) await rm(path.join(fallbackDir(), s.fallback_image), { force: true });
    await audit(sql, req, 'stream.fallback_image_removed', { id });
    nudge();
    return { ok: true };
  });

  /** The uploaded fallback image, or the standard one, for the preview in the console. */
  app.get('/api/streams/:id/fallback-image', viewer, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const s = await getStream(id);
    const file = fallbackImagePath(s.fallback_image ? 'image' : 'standard', s.fallback_image);
    if (!file) return reply.status(404).send({ error: 'not_found' });
    reply.header('cache-control', 'private, max-age=60');
    return reply.type(file.endsWith('.png') ? 'image/png' : 'image/jpeg').send(await readFile(file));
  });

  app.delete('/api/streams/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params);
    const s = await getStream(id);
    await sql`DELETE FROM streams WHERE id = ${id}`;
    await kick(decrypt(s.ingest_key_enc));
    if (s.backup_key_enc) await kick(decrypt(s.backup_key_enc));
    if (s.fallback_image) await rm(path.join(fallbackDir(), s.fallback_image), { force: true });
    await audit(sql, req, 'stream.deleted', { id, name: s.name });
    nudge();
    return { ok: true };
  });

  /** Go live / stop for every destination of a stream. Go live only starts destinations marked "included". */
  app.post('/api/streams/:id/live', operator, async (req) => {
    const { id } = idParam.parse(req.params);
    const { live } = z.object({ live: z.boolean() }).parse(req.body);
    const s = await getStream(id);
    const r = live
      ? await sql`UPDATE destinations SET live = true, live_since = COALESCE(live_since, now()), updated_at = now() WHERE stream_id = ${id} AND enabled AND NOT live`
      : await sql`UPDATE destinations SET live = false, live_since = NULL, updated_at = now() WHERE stream_id = ${id} AND live`;
    // "Record automatically" follows Go live / Stop all.
    if (s.auto_record) await sql`UPDATE streams SET record = ${live}, record_by = ${live ? req.user!.id : null} WHERE id = ${id}`;
    await audit(sql, req, live ? 'stream.live' : 'stream.stopped', { id, destinations: r.count });
    nudge();
    return { ok: true, changed: r.count };
  });

  async function checkDestination(platform: Platform, serverUrl: string, body: z.infer<typeof destinationBody>) {
    const problem = serverUrlProblem(platform, serverUrl);
    if (problem) throw new HttpError(400, problem);
    if (platform === 'srt' && [body.streamKey, body.passphrase].some((v) => v && unsafeSrtValue.test(v))) throw new HttpError(400, 'invalid_srt_value');
    if (body.auth === 'account') {
      if (!(accountPlatforms as readonly string[]).includes(platform)) throw new HttpError(400, 'account_not_supported');
      if (!body.accountId) throw new HttpError(400, 'account_required');
      const [a] = await sql<{ provider: string }[]>`SELECT provider FROM platform_accounts WHERE id = ${body.accountId}`;
      if (!a || a.provider !== platform) throw new HttpError(400, 'account_required');
    }
  }

  app.post('/api/streams/:id/destinations', operator, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = destinationBody.parse(req.body);
    await getStream(id);
    const serverUrl = body.serverUrl || presets[body.platform].server;
    await checkDestination(body.platform, serverUrl, body);
    if (presets[body.platform].keyRequired && body.auth === 'key' && !body.streamKey) throw new HttpError(400, 'stream_key_required');
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM destinations WHERE stream_id = ${id}`;
    if (n >= 20) throw new HttpError(400, 'too_many_destinations');
    const [d] = await sql<{ id: string }[]>`
      INSERT INTO destinations (stream_id, name, platform, server_url, stream_key_enc, passphrase_enc, enabled, mode,
                                video_bitrate, audio_bitrate, max_height, fps, position, auth, account_id, privacy, orientation)
      VALUES (${id}, ${body.name}, ${body.platform}, ${serverUrl}, ${body.streamKey ? encrypt(body.streamKey) : ''},
              ${body.passphrase ? encrypt(body.passphrase) : ''}, ${body.enabled}, ${body.mode},
              ${body.videoBitrate}, ${body.audioBitrate}, ${body.maxHeight}, ${body.fps}, ${n},
              ${body.auth}, ${body.auth === 'account' ? body.accountId : null}, ${body.privacy}, ${body.orientation})
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
    await checkDestination(body.platform, serverUrl, body);
    const keyEnc = body.streamKey === undefined ? cur.stream_key_enc : body.streamKey ? encrypt(body.streamKey) : '';
    if (presets[body.platform].keyRequired && body.auth === 'key' && !keyEnc) throw new HttpError(400, 'stream_key_required');
    // Another account or another way of connecting: the prepared broadcast no longer applies.
    const reset = body.auth !== cur.auth || (body.accountId ?? null) !== (cur.auth === 'account' ? cur.account_id : null);
    const passEnc = body.passphrase === undefined ? cur.passphrase_enc : body.passphrase ? encrypt(body.passphrase) : '';
    await sql`
      UPDATE destinations SET name = ${body.name}, server_url = ${serverUrl}, stream_key_enc = ${keyEnc}, passphrase_enc = ${passEnc},
             enabled = ${body.enabled}, mode = ${body.mode}, video_bitrate = ${body.videoBitrate}, audio_bitrate = ${body.audioBitrate},
             max_height = ${body.maxHeight}, fps = ${body.fps}, auth = ${body.auth},
             account_id = ${body.auth === 'account' ? body.accountId : null}, privacy = ${body.privacy}, orientation = ${body.orientation},
             remote_stream_id = CASE WHEN ${reset} THEN NULL ELSE remote_stream_id END,
             updated_at = now()
      WHERE id = ${id}`;
    await audit(sql, req, 'destination.updated', { id, name: body.name, keyChanged: body.streamKey !== undefined });
    nudge();
    return { ok: true };
  });

  app.delete('/api/destinations/:id', operator, async (req) => {
    const { id } = idParam.parse(req.params);
    const d = await getDestination(id);
    // End a broadcast this destination still has open on its connected account.
    await provisioner.release(id).catch(() => {});
    await sql`DELETE FROM destinations WHERE id = ${id}`;
    await audit(sql, req, 'destination.deleted', { id, name: d.name });
    nudge();
    return { ok: true };
  });

  app.post('/api/destinations/:id/live', operator, async (req) => {
    const { id } = idParam.parse(req.params);
    const { live } = z.object({ live: z.boolean() }).parse(req.body);
    const d = await getDestination(id);
    await sql`UPDATE destinations SET live = ${live}, live_since = ${live ? (d.live_since ?? new Date()) : null}, updated_at = now() WHERE id = ${id}`;
    await audit(sql, req, live ? 'destination.live' : 'destination.stopped', { id, name: d.name });
    nudge();
    return { ok: true };
  });
}
