/** A local stand-in for the Google/YouTube, Facebook Graph and Twitch APIs, recording every call. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { endpoints } from '../src/platforms/api.js';

export interface Call { method: string; path: string; query: Record<string, string>; body: Record<string, unknown>; auth: string }

export async function startFakePlatforms() {
  const calls: Call[] = [];
  let n = 0;
  const fail = new Set<string>();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const url = new URL(req.url!, 'http://x');
    let body: Record<string, unknown> = {};
    if (raw) body = (req.headers['content-type'] ?? '').includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    const call: Call = { method: req.method!, path: url.pathname, query: Object.fromEntries(url.searchParams), body, auth: String(req.headers.authorization ?? '') };
    calls.push(call);
    const send = (status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const key = `${req.method} ${url.pathname}`;
    if (fail.has(key)) return send(403, { error: { message: `forbidden by test: ${key}` } });

    // --- Google / YouTube
    if (key === 'POST /google/token') {
      if (body.grant_type === 'refresh_token') return send(200, { access_token: `yt-access-${++n}`, expires_in: 3600 });
      return send(200, { access_token: 'yt-access-0', refresh_token: 'yt-refresh', expires_in: 3600, scope: 'https://www.googleapis.com/auth/youtube' });
    }
    if (key === 'GET /youtube/channels') return send(200, { items: [{ id: 'UC123', snippet: { title: 'Kerk TV', customUrl: '@kerktv', thumbnails: { default: { url: 'https://img/yt.png' } } } }] });
    if (key === 'GET /youtube/liveStreams') return send(200, { items: url.searchParams.get('id') === 'ls-1' ? [{ id: 'ls-1', cdn: { ingestionInfo: { rtmpsIngestionAddress: 'rtmps://a.rtmps.youtube.com/live2', streamName: 'yt-key-1' } } }] : [] });
    if (key === 'POST /youtube/liveStreams') return send(200, { id: 'ls-1', cdn: { ingestionInfo: { rtmpsIngestionAddress: 'rtmps://a.rtmps.youtube.com/live2', streamName: 'yt-key-1' } } });
    if (key === 'POST /youtube/liveBroadcasts') return send(200, { id: `bc-${++n}` });
    if (key === 'PUT /youtube/liveBroadcasts') return send(200, { id: body.id });
    if (key === 'DELETE /youtube/liveBroadcasts') { res.writeHead(204); return res.end(); }
    if (key === 'POST /youtube/liveBroadcasts/bind') return send(200, { id: url.searchParams.get('id') });
    if (key === 'POST /youtube/liveBroadcasts/transition') return send(200, { id: url.searchParams.get('id') });

    // --- Facebook
    if (key === 'GET /graph/oauth/access_token') return send(200, { access_token: url.searchParams.get('grant_type') === 'fb_exchange_token' ? 'fb-long' : 'fb-short' });
    if (key === 'GET /graph/me/accounts') return send(200, { data: [{ id: 'page-1', name: 'Kerk Pagina', access_token: 'page-token-1' }, { id: 'page-2', name: 'Tweede', access_token: 'page-token-2' }] });
    let m = /^\/graph\/([\w-]+)\/live_videos$/.exec(url.pathname);
    if (m && req.method === 'POST') return send(200, { id: `lv-${++n}`, secure_stream_url: `rtmps://live-api-s.facebook.com:443/rtmp/FB-${n}` });
    m = /^\/graph\/(lv-\d+)$/.exec(url.pathname);
    if (m && req.method === 'GET') return send(200, { secure_stream_url: `rtmps://live-api-s.facebook.com:443/rtmp/FB-${m[1]}`, permalink_url: `/kerk/videos/${m[1]}` });
    if (m && req.method === 'POST') return send(200, { success: true });
    if (m && req.method === 'DELETE') return send(200, { success: true });

    // --- Twitch
    if (key === 'POST /twitch-auth/token') return send(200, { access_token: 'tw-access', refresh_token: 'tw-refresh', expires_in: 14000, scope: ['channel:read:stream_key'] });
    if (key === 'GET /helix/users') return send(200, { data: [{ id: 'tw-1', login: 'kerktv', display_name: 'KerkTV', profile_image_url: 'https://img/tw.png' }] });
    if (key === 'GET /helix/streams/key') return send(200, { data: [{ stream_key: 'live_tw_key' }] });
    if (key === 'PATCH /helix/channels') { res.writeHead(204); return res.end(); }
    if (key === 'POST /helix/schedule/segment') return send(200, { data: { segments: [{ id: `seg-${++n}` }] } });
    if (key === 'PATCH /helix/schedule/segment') return send(200, { data: {} });
    if (key === 'DELETE /helix/schedule/segment') { res.writeHead(204); return res.end(); }

    send(404, { error: { message: `fake: no route ${key}` } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const saved = { ...endpoints };
  Object.assign(endpoints, {
    googleAuth: `${base}/google/auth`, googleToken: `${base}/google/token`, youtube: `${base}/youtube`,
    facebookDialog: `${base}/fb/dialog`, facebookGraph: `${base}/graph`, twitchAuth: `${base}/twitch-auth`, twitchApi: `${base}/helix`,
  });
  return {
    calls, fail,
    find: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path),
    close: async () => { Object.assign(endpoints, saved); await new Promise((r) => server.close(r)); },
  };
}
