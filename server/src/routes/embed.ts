import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { config } from '../config.js';
import { getSettings } from '../lib/settings.js';
import { createPlaybackToken, headerHost, hostAllowed, verifyPlaybackToken } from '../lib/playback.js';
import type { PlaybackCache } from './media.js';

/** Media tokens handed out by the embed page; the player reloads the page before they run out. */
export const EMBED_TOKEN_HOURS = 24;

const fallbackHtml = '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Live</title></head><body></body></html>';

let template: string | null = null;
function loadTemplate(): string {
  if (template) return template;
  const file = path.join(config.webDist, 'embed.html');
  const html = existsSync(file) ? readFileSync(file, 'utf8') : fallbackHtml;
  if (existsSync(file)) template = html;
  return html;
}

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface EmbedConfig {
  state: 'ok' | 'not_found' | 'restricted';
  /** Prefix for the media requests, e.g. /live/abc~token/ */
  mediaBase: string;
  title: string;
  instance: string;
  /** Unix ms at which the page must be reloaded for a fresh media token (0 = never). */
  reloadAt: number;
}

function page(reply: FastifyReply, status: number, cfg: EmbedConfig, frameAncestors: string) {
  const html = loadTemplate().replace('</head>', `<meta name="restream-embed" content="${esc(JSON.stringify(cfg))}"></head>`);
  return reply
    .status(status)
    .removeHeader('x-frame-options')
    .header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer')
    .header('cross-origin-resource-policy', 'cross-origin')
    .header('content-security-policy', [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
      "media-src 'self' blob:", "connect-src 'self'", "worker-src 'self' blob:", "font-src 'self' data:",
      "base-uri 'none'", "form-action 'none'", `frame-ancestors ${frameAncestors}`,
    ].join('; '))
    .type('text/html; charset=utf-8')
    .send(html);
}

/**
 * The embeddable player: /embed/<playbackId>[?token=…][&autoplay=1&muted=1&mode=webrtc&title=0].
 * Allowed domains are enforced by the browser (CSP frame-ancestors) and by checking where the page is
 * loaded from; a stream that requires a token only plays with a valid ?token.
 */
export async function embedRoutes(app: FastifyInstance, { sql, playback }: { sql: Sql; playback: PlaybackCache }) {
  app.get('/embed/:pid', async (req: FastifyRequest, reply) => {
    const { pid } = req.params as { pid: string };
    const q = z.object({ token: z.string().max(64).optional() }).safeParse(req.query);
    const token = q.success ? q.data.token : undefined;
    const s = await getSettings(sql);
    const base: EmbedConfig = { state: 'not_found', mediaBase: '', title: '', instance: s.instanceName, reloadAt: 0 };

    const info = /^[a-z0-9]{6,32}$/.test(pid) ? await playback.lookup(pid) : null;
    if (!info) return page(reply, 404, base, '*');
    const [row] = await sql<{ name: string }[]>`SELECT name FROM streams WHERE playback_id = ${pid}`;
    const ownHost = headerHost(s.publicUrl) ?? String(req.headers.host ?? '').replace(/:\d+$/, '');

    const domains = info.allowedDomains;
    const frameAncestors = domains.length ? ["'self'", ...domains].join(' ') : '*';
    const tokenOk = !!token && verifyPlaybackToken(pid, info.tokenSecret, token);
    const restricted = { ...base, state: 'restricted' as const, title: row?.name ?? '' };

    if (info.requireToken && !tokenOk) return page(reply, 403, restricted, frameAncestors);
    if (domains.length && !tokenOk) {
      // The site that frames the player sends its address as Referer (at least the origin, by default).
      const ref = headerHost(req.headers.referer);
      const dest = req.headers['sec-fetch-dest'];
      const fromAllowed = ref ? ref === ownHost || hostAllowed(ref, domains) : dest === 'iframe';
      if (!fromAllowed) return page(reply, 403, restricted, frameAncestors);
    }

    const needToken = info.requireToken || domains.length > 0;
    let mediaBase = `/live/${pid}/`;
    let reloadAt = 0;
    if (needToken) {
      const exp = new Date(Date.now() + EMBED_TOKEN_HOURS * 3600_000);
      mediaBase = `/live/${pid}~${createPlaybackToken(pid, info.tokenSecret, exp)}/`;
      reloadAt = exp.getTime() - 10 * 60_000;
    }
    return page(reply, 200, { ...base, state: 'ok', mediaBase, title: row?.name ?? '', reloadAt }, frameAncestors);
  });
}
