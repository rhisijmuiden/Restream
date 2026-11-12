import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { config } from '../config.js';
import { decrypt, sha256 } from '../lib/crypto.js';
import { requireAuth } from '../lib/guards.js';
import { headerHost, hostAllowed, verifyPlaybackToken } from '../lib/playback.js';
import type { MediaSupervisor } from '../media/supervisor.js';

const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** True only for requests made on this machine without passing through nginx. */
export function isLocal(req: FastifyRequest) {
  return loopback.has(req.socket.remoteAddress ?? '') && !req.headers['x-forwarded-for'] && !req.headers['x-real-ip'];
}

const hookBody = z.object({
  action: z.string(),
  path: z.string().default(''),
  ip: z.string().default(''),
  protocol: z.string().default(''),
});

export interface PlaybackInfo {
  key: string;
  pid: string;
  allowedDomains: string[];
  requireToken: boolean;
  tokenSecret: string;
}

/** Playback ids map to ingest keys and access rules; cached briefly because every HLS segment request needs one. */
export class PlaybackCache {
  private cache = new Map<string, { info: PlaybackInfo | null; at: number }>();
  constructor(private sql: Sql) {}
  async lookup(pid: string): Promise<PlaybackInfo | null> {
    const hit = this.cache.get(pid);
    if (hit && Date.now() - hit.at < 5000) return hit.info;
    const [s] = await this.sql<{ ingest_key_enc: string; playback_enabled: boolean; enabled: boolean; allowed_domains: string[]; require_token: boolean; token_secret: string }[]>`
      SELECT ingest_key_enc, playback_enabled, enabled, allowed_domains, require_token, token_secret FROM streams WHERE playback_id = ${pid}`;
    const info = s && s.enabled && s.playback_enabled
      ? { key: decrypt(s.ingest_key_enc), pid, allowedDomains: s.allowed_domains, requireToken: s.require_token, tokenSecret: s.token_secret }
      : null;
    if (this.cache.size > 1000) this.cache.clear();
    this.cache.set(pid, { info, at: Date.now() });
    return info;
  }
  clear() { this.cache.clear(); }
}

const hopByHop = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer', 'content-length', 'server', 'set-cookie', 'location', 'access-control-allow-origin', 'access-control-allow-credentials']);

export async function mediaRoutes(app: FastifyInstance, { sql, playback, media }: { sql: Sql; playback: PlaybackCache; media?: MediaSupervisor }) {
  /**
   * MediaMTX asks this endpoint before every publish and read (authMethod: http).
   * Publishing needs a valid stream key (the path is live/<key>); reading is only allowed from this machine,
   * which is where the FFmpeg outputs and the playback proxy below connect from.
   */
  app.post('/api/internal/mediamtx/auth', { config: { internal: true } }, async (req, reply) => {
    if (!isLocal(req)) return reply.status(404).send({ error: 'not_found' });
    const b = hookBody.parse(req.body);
    // Restream's own light preview encoder (FFmpeg on this machine) publishes preview/<key> over RTSP.
    if (b.action === 'publish' && loopback.has(b.ip) && b.protocol === 'rtsp' && /^preview\/[A-Za-z0-9]{16,64}$/.test(b.path)) return { ok: true };
    if (b.action === 'publish') {
      const m = /^live\/([A-Za-z0-9]{16,64})$/.exec(b.path);
      if (!m || !['rtmp', 'srt'].includes(b.protocol)) return reply.status(401).send({ ok: false });
      // The main key or the backup key of a stream.
      const h = sha256(m[1]);
      const [s] = await sql<{ id: string; enabled: boolean; backup: boolean }[]>`
        SELECT id, enabled, backup_key_hash = ${h} AS backup FROM streams WHERE ingest_key_hash = ${h} OR backup_key_hash = ${h}`;
      if (!s || !s.enabled) {
        req.log.info({ ip: b.ip, protocol: b.protocol }, 'ingest refused: unknown or disabled stream key');
        return reply.status(401).send({ ok: false });
      }
      req.log.info({ stream: s.id, ip: b.ip, protocol: b.protocol, feed: s.backup ? 'backup' : 'main' }, 'ingest accepted');
      return { ok: true };
    }
    if (b.action === 'read' && loopback.has(b.ip)) return { ok: true };
    return reply.status(401).send({ ok: false });
  });

  for (const type of ['application/sdp', 'application/trickle-ice-sdpfrag']) {
    app.addContentTypeParser(type, { parseAs: 'string', bodyLimit: 64 * 1024 }, (_req, body, done) => done(null, body));
  }

  /**
   * Public playback (hotlink and embed): /live/<playbackId>/index.m3u8 (HLS), /live/<playbackId>/whep (WebRTC),
   * and the MediaMTX player pages at /live/<playbackId>/ and /live/<playbackId>/webrtc/.
   * MediaMTX only listens on 127.0.0.1; this proxy swaps the public playback id for the secret ingest path.
   *
   * The playback id may carry a signed token: /live/<playbackId>~<token>/… (in the path, so the relative
   * segment URLs in HLS playlists keep it). Access rules per stream:
   * - a valid token always gives access;
   * - "require token": nothing else does;
   * - allowed domains: only browsers on those sites (Origin header) get access;
   * - otherwise playback is public.
   */
  async function proxy(req: FastifyRequest, reply: FastifyReply) {
    const { pid: raw, '*': restRaw } = req.params as { pid: string; '*': string };
    const rest = restRaw ?? '';
    const m = /^([a-z0-9]{6,32})(?:~([0-9a-z]{1,8}\.[A-Za-z0-9_-]{22}))?$/.exec(raw);
    if (!m || rest.includes('..')) return publicHeaders(reply, '*').status(404).send({ error: 'not_found' });
    const [, pid, token] = m;
    const info = await playback.lookup(pid);
    if (!info) return publicHeaders(reply, '*').status(404).send({ error: 'not_found' });

    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    let allowOrigin = '*';
    let allowed = true;
    if (token) {
      allowed = verifyPlaybackToken(pid, info.tokenSecret, token);
    } else if (info.requireToken) {
      allowed = false;
    } else if (info.allowedDomains.length) {
      const host = headerHost(origin);
      allowed = !!host && hostAllowed(host, info.allowedDomains);
      allowOrigin = allowed ? origin : 'null';
    }
    publicHeaders(reply, allowOrigin);
    if (req.method === 'OPTIONS') return reply.status(204).send();
    if (!allowed) return reply.status(403).send({ error: 'playback_restricted' });
    return forward(req, reply, `live/${info.key}`, `/live/${raw}/`, rest);
  }

  const publicHeaders = (reply: FastifyReply, origin: string) => {
    reply
      .header('access-control-allow-origin', origin)
      .header('access-control-allow-methods', 'GET, HEAD, POST, PATCH, DELETE, OPTIONS')
      .header('access-control-allow-headers', 'Content-Type, If-Match, Authorization')
      .header('access-control-expose-headers', 'ETag, ID, Accept-Patch, Link, Location')
      .header('cross-origin-resource-policy', 'cross-origin')
      .removeHeader('x-frame-options');
    if (origin !== '*') reply.header('vary', 'Origin');
    return reply;
  };

  /** Forwards a request to MediaMTX for ingest key `key`; `base` is the public URL prefix that stands for /live/<key>/. */
  async function forward(req: FastifyRequest, reply: FastifyReply, mtxPath: string, base: string, rest: string) {
    let upstream: string; let prefix: string; let sub: string;
    if (rest === 'webrtc' || rest.startsWith('webrtc/')) {
      upstream = config.media.webrtcUrl; prefix = `${base}webrtc/`; sub = rest.slice('webrtc/'.length);
    } else if (rest === 'whep' || rest.startsWith('whep/')) {
      upstream = config.media.webrtcUrl; prefix = base; sub = rest;
    } else {
      upstream = config.media.hlsUrl; prefix = base; sub = rest;
    }
    if (rest === 'webrtc') return reply.redirect(`${base}webrtc/`);
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const target = `${upstream}/${mtxPath}/${sub}${qs}`;

    const headers: Record<string, string> = {};
    for (const h of ['content-type', 'if-match', 'accept', 'range']) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }
    // Only MediaMTX's own HLS session cookies are passed on.
    const cookies = String(req.headers.cookie ?? '').split(';').map((c) => c.trim()).filter((c) => /^(cookieCheck|hlsSession)=/.test(c));
    if (cookies.length) headers.cookie = cookies.join('; ');

    let res: Response;
    try {
      res = await fetch(target, {
        method: req.method,
        headers,
        body: ['POST', 'PATCH'].includes(req.method) ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? '')) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      return reply.status(502).send({ error: 'media_unavailable' });
    }

    reply.status(res.status);
    res.headers.forEach((v, k) => { if (!hopByHop.has(k)) reply.header(k, v); });
    const loc = res.headers.get('location');
    if (loc) reply.header('location', loc.split(`/${mtxPath}/`).join(prefix));
    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (setCookies.length) reply.header('set-cookie', setCookies);
    if ((res.headers.get('content-type') ?? '').includes('text/html')) {
      // MediaMTX player pages use inline scripts and are meant to be embedded.
      reply.header('content-security-policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors *");
    }
    if (!res.body || req.method === 'HEAD') return reply.send();
    const body = Readable.fromWeb(res.body as never);
    if (res.headers.get('content-length')) reply.header('content-length', res.headers.get('content-length')!);
    return reply.send(body);
  }

  const methods = ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] as const;
  app.route({ method: [...methods], url: '/live/:pid/*', handler: proxy });
  /** Signed-in preview for the console, also when public playback is switched off. Only WHEP and HLS. */
  app.route({
    method: ['GET', 'POST', 'PATCH', 'DELETE'],
    url: '/api/preview/:id/*',
    preHandler: requireAuth('viewer'),
    handler: async (req, reply) => {
      // "<id>~backup" previews the backup feed; "~lite" is the light WebRTC preview without B-frames (WHEP only).
      const { id: raw, '*': rest } = z.object({ id: z.string().regex(/^[0-9a-f-]{36}(~backup)?(~lite)?$/), '*': z.string().regex(/^(whep(\/[0-9a-f-]{36})?|[A-Za-z0-9_.-]+\.(m3u8|mp4|m4s)|)$/) }).parse(req.params);
      const lite = raw.endsWith('~lite');
      const feed = raw.replace(/~lite$/, '');
      const id = z.uuid().parse(feed.replace(/~backup$/, ''));
      const backup = feed.endsWith('~backup');
      const [s] = await sql<{ ingest_key_enc: string; backup_key_enc: string | null }[]>`SELECT ingest_key_enc, backup_key_enc FROM streams WHERE id = ${id}`;
      if (!s || (backup && !s.backup_key_enc)) return reply.status(404).send({ error: 'not_found' });
      const key = decrypt(backup ? s.backup_key_enc! : s.ingest_key_enc);
      if (!lite) return forward(req, reply, `live/${key}`, `/api/preview/${raw}/`, rest);
      if (!rest.startsWith('whep') || !media) return reply.status(404).send({ error: 'not_found' });
      // A new session starts the encoder (or keeps it running); later requests only need it to exist.
      const path = req.method === 'POST' ? await media.ensurePreview(key) : `preview/${key}`;
      if (!path) return reply.status(503).send({ error: 'preview_unavailable' });
      return forward(req, reply, path, `/api/preview/${raw}/`, rest);
    },
  });

  app.get('/live/:pid', async (req, reply) => reply.redirect(`/live/${(req.params as { pid: string }).pid}/`));
}
