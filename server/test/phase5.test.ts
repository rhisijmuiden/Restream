import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client, addUser, loginWithEnrolment, setup } from './helpers.js';
import { fallbackArgs, ffmpegArgs, type OutputSpec } from '../src/media/ffmpeg.js';
import { presets, serverUrlProblem } from '../src/media/platforms.js';
import { MediaSupervisor, offline, type IngestState } from '../src/media/supervisor.js';
import { addressBlocked, sign, webhookUrlProblem } from '../src/lib/webhooks.js';
import { apiKeyForbidden } from '../src/lib/apiKeys.js';
import { bus, type BusEvent } from '../src/lib/events.js';
import { config } from '../src/config.js';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const spec = (o: Partial<OutputSpec> = {}): OutputSpec => ({
  platform: 'instagram', serverUrl: 'rtmps://edgetee-upload-ams.xx.fbcdn.net:443/rtmp/', streamKey: 'ig-key-1', passphrase: '',
  mode: 'transcode', videoBitrate: 4000, audioBitrate: 128, maxHeight: 720, fps: null, orientation: 'portrait', ...o,
});
const h264 = { videoCodec: 'H264', audioCodec: 'MPEG-4 Audio' };
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

describe('platform presets', () => {
  it('knows the new platforms and their limits', () => {
    expect(presets.instagram).toMatchObject({ orientation: 'portrait', maxHeight: 720, maxFps: 30, defaultMode: 'transcode', audioSampleRate: 44100, keyPerBroadcast: true });
    expect(presets.kick).toMatchObject({ maxKbps: 8000, protocols: ['rtmps'], serverRequired: true });
    expect(presets.x).toMatchObject({ maxHeight: 720, keyframeSeconds: 3 });
    expect(presets.linkedin).toMatchObject({ maxFps: 30, serverRequired: true });
    expect(serverUrlProblem('kick', '')).toBe('server_required');
    expect(serverUrlProblem('kick', 'rtmp://ingest.example.com/app')).toBe('invalid_server_url');
    expect(serverUrlProblem('kick', 'rtmps://fa723fc1b171.global-contribute.live-video.net:443/app')).toBeNull();
  });

  it('crops to 9:16 for portrait platforms and follows their encoder rules', () => {
    const a = ffmpegArgs('rtsp://127.0.0.1:8554/live/k', spec(), h264).join(' ');
    expect(a).toContain("crop='min(iw,ih*9/16)':'min(ih,iw*16/9)',scale=720:1280,setsar=1");
    // 50 fps ingest is capped at Instagram's 30 fps, keyframes every 2 s, CBR, 44.1 kHz audio.
    expect(a).toContain('-r 30 -g 60 -keyint_min 60');
    expect(a).toContain('nal-hrd=cbr');
    expect(a).toContain('-ar 44100');
    expect(a.endsWith('-f flv rtmps://edgetee-upload-ams.xx.fbcdn.net:443/rtmp/ig-key-1')).toBe(true);
    const x = ffmpegArgs('rtsp://x/live/k', spec({ platform: 'x', orientation: 'landscape', fps: 30 }), h264).join(' ');
    expect(x).toContain('-g 90');
    expect(x).toContain("scale=-2:'min(720,ih)'");
  });

  it('builds the fallback image output in the size the destination carried', () => {
    const a = fallbackArgs('/srv/fallback.png', spec({ platform: 'youtube', serverUrl: 'rtmps://a.rtmps.youtube.com/live2', mode: 'copy', orientation: 'landscape', videoBitrate: 9000 }), { height: 1080, fps: 50 }).join(' ');
    expect(a).toContain('-re -loop 1 -framerate 50 -i /srv/fallback.png');
    expect(a).toContain('anullsrc=channel_layout=stereo:sample_rate=48000');
    expect(a).toContain('scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080');
    expect(a).toContain('-b:v 2500k');
    const ig = fallbackArgs('/srv/f.png', spec(), { height: 1080, fps: 50 }).join(' ');
    expect(ig).toContain('pad=720:1280');
    expect(ig).toContain('-framerate 30');
  });
});

describe('source selection (failover)', () => {
  const online = (height = 1080): IngestState => ({ ...offline, online: true, video: { codec: 'H264', width: null, height } });
  const row = { id: 's1', enabled: true, switch_back_seconds: 10, fallback_minutes: 1 } as never;
  type Internals = { ingest: Map<string, IngestState>; backupIngest: Map<string, IngestState>; pickSource: (s: never, now: number, anyLive: boolean, img: boolean) => { active: string } };
  const sup = new MediaSupervisor(null as never, { info() {}, warn() {}, error() {}, debug() {} } as never) as unknown as Internals;
  const pick = (now: number, main: boolean, backup: boolean, anyLive = true, img = true) => {
    sup.ingest.set('s1', main ? online() : offline);
    sup.backupIngest.set('s1', backup ? online() : offline);
    return sup.pickSource(row, now, anyLive, img).active;
  };

  it('fails over to the backup, then the fallback image, and back', () => {
    expect(pick(0, false, false)).toBe('none');
    expect(pick(1000, true, true)).toBe('main');
    expect(pick(2000, false, true)).toBe('backup');
    // The main feed is back but not yet stable for 10 s: stay on the backup.
    expect(pick(3000, true, true)).toBe('backup');
    expect(pick(12_000, true, true)).toBe('backup');
    expect(pick(13_000, true, true)).toBe('main');
    // Both feeds gone while live: fallback image, for at most a minute.
    expect(pick(14_000, false, false)).toBe('fallback');
    expect(pick(60_000, false, false)).toBe('fallback');
    expect(pick(75_000, false, false)).toBe('none');
    expect(pick(80_000, false, false)).toBe('none');
    // A feed coming back ends it right away (also from the fallback, no waiting).
    expect(pick(81_000, true, false)).toBe('main');
  });

  it('does not show the fallback image when nothing is live or there is no image', () => {
    expect(pick(100_000, true, false)).toBe('main');
    expect(pick(101_000, false, false, false)).toBe('none');
    expect(pick(102_000, true, false)).toBe('main');
    expect(pick(103_000, false, false, true, false)).toBe('none');
  });
});

describe('webhook and API key rules', () => {
  it('refuses calls to this machine, link-local and metadata addresses', () => {
    expect(addressBlocked('169.254.169.254')).toBe(true);
    expect(addressBlocked('0.0.0.0')).toBe(true);
    expect(addressBlocked('fe80::1')).toBe(true);
    expect(addressBlocked('192.168.1.10')).toBe(false);
    expect(addressBlocked('::ffff:169.254.1.1')).toBe(true);
    expect(webhookUrlProblem('http://169.254.169.254/latest')).toBe('url_not_allowed');
    expect(webhookUrlProblem('ftp://example.com/')).toBe('invalid_url');
    expect(webhookUrlProblem('https://user:pw@example.com/')).toBe('invalid_url');
    expect(webhookUrlProblem('https://hooks.example.com/restream')).toBeNull();
  });

  it('keeps API keys away from sign-in, users, keys and restore', () => {
    expect(apiKeyForbidden('POST', '/api/auth/password')).toBe(true);
    expect(apiKeyForbidden('GET', '/api/auth/me')).toBe(false);
    expect(apiKeyForbidden('GET', '/api/users')).toBe(true);
    expect(apiKeyForbidden('POST', '/api/api-keys')).toBe(true);
    expect(apiKeyForbidden('POST', '/api/backups/restore')).toBe(true);
    expect(apiKeyForbidden('GET', '/api/accounts/oauth/youtube/start')).toBe(true);
    expect(apiKeyForbidden('POST', '/api/streams/x/live')).toBe(false);
  });
});

describe('phase 5 API', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let admin: Client;
  let op: Client;
  let streamId = '';
  const hook = (path: string) => ctx.app.inject({ method: 'POST', url: '/api/internal/mediamtx/auth', payload: { action: 'publish', path, protocol: 'rtmp', ip: '203.0.113.9' }, remoteAddress: '127.0.0.1' });

  beforeAll(async () => {
    ctx = await setup();
    await addUser(ctx.sql, 'admin@example.com', 'correct horse battery', 'admin');
    await addUser(ctx.sql, 'op@example.com', 'correct horse battery', 'operator');
    admin = new Client(ctx.app);
    op = new Client(ctx.app);
    await loginWithEnrolment(admin, 'admin@example.com', 'correct horse battery');
    await loginWithEnrolment(op, 'op@example.com', 'correct horse battery');
    streamId = (await op.post('/api/streams', { name: 'Main' })).json().id;
  });
  afterAll(async () => { await ctx.app.close(); await ctx.sql.end(); });

  it('adds Instagram, Kick, X and LinkedIn destinations', async () => {
    const ig = await op.post(`/api/streams/${streamId}/destinations`, { name: 'Instagram', platform: 'instagram', streamKey: 'ig-key-1234' });
    expect(ig.json().error).toBe('server_required');
    const ok = await op.post(`/api/streams/${streamId}/destinations`, {
      name: 'Instagram', platform: 'instagram', serverUrl: 'rtmps://edgetee-upload-ams.xx.fbcdn.net:443/rtmp/', streamKey: 'ig-key-1234',
      mode: 'transcode', maxHeight: 720, fps: 30, videoBitrate: 4000, orientation: 'portrait',
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await op.post(`/api/streams/${streamId}/destinations`, { name: 'Kick', platform: 'kick', serverUrl: 'rtmps://x.global-contribute.live-video.net:443/app', streamKey: 'sk_us-west' })).statusCode).toBe(200);
    expect((await op.post(`/api/streams/${streamId}/destinations`, { name: 'X', platform: 'x', serverUrl: 'rtmps://va.pscp.tv:443/x', streamKey: 'xkey' })).statusCode).toBe(200);
    expect((await op.post(`/api/streams/${streamId}/destinations`, { name: 'Kick', platform: 'kick', serverUrl: 'rtmps://li.example.net:443/live', streamKey: 'likey', auth: 'account', accountId: '00000000-0000-0000-0000-000000000000' })).json().error).toBe('account_not_supported');
    const d = (await op.get('/api/streams')).json().streams[0].destinations;
    expect(d.map((x: { platform: string }) => x.platform)).toEqual(['instagram', 'kick', 'x']);
    expect(d[0]).toMatchObject({ orientation: 'portrait', maxHeight: 720, fps: 30 });
    expect((await op.get('/api/platforms')).json().instagram.serverRequired).toBe(true);
  });

  it('creates a backup ingest key that MediaMTX accepts, and removes it', async () => {
    expect((await op.post(`/api/streams/${streamId}/backup-key`, { enabled: true })).statusCode).toBe(200);
    let s = (await op.get('/api/streams')).json().streams[0];
    const bkey = s.backupIngest.streamKey;
    expect(bkey).toMatch(/^rs[A-Za-z0-9]{30}$/);
    expect(bkey).not.toBe(s.ingest.streamKey);
    expect(s.backupIngest.rtmpUrl).toContain(bkey);
    expect(s.source).toMatchObject({ active: 'none', backupConfigured: true });
    expect((await hook(`live/${bkey}`)).statusCode).toBe(200);
    expect((await hook(`live/${s.ingest.streamKey}`)).statusCode).toBe(200);
    await op.post(`/api/streams/${streamId}/backup-key`, { enabled: false });
    s = (await op.get('/api/streams')).json().streams[0];
    expect(s.backupIngest).toMatchObject({ configured: false, streamKey: null });
    expect((await hook(`live/${bkey}`)).statusCode).toBe(401);
  });

  it('stores fallback settings and an uploaded image', async () => {
    expect((await op.req('PATCH', `/api/streams/${streamId}`, { fallbackMode: 'image' })).json().error).toBe('fallback_image_missing');
    expect((await op.req('PATCH', `/api/streams/${streamId}`, { fallbackMode: 'standard', fallbackMinutes: 15, switchBackSeconds: 20 })).statusCode).toBe(200);
    const std = await op.get(`/api/streams/${streamId}/fallback-image`);
    expect(std.statusCode).toBe(200);
    expect(std.headers['content-type']).toBe('image/png');

    const bad = await ctx.app.inject({ method: 'PUT', url: `/api/streams/${streamId}/fallback-image`, payload: Buffer.from('GIF89a....'), headers: { 'content-type': 'image/png', 'x-restream': '1', cookie: op.cookie } });
    expect(bad.json().error).toBe('invalid_image');
    const up = await ctx.app.inject({ method: 'PUT', url: `/api/streams/${streamId}/fallback-image`, payload: png, headers: { 'content-type': 'image/png', 'x-restream': '1', cookie: op.cookie } });
    expect(up.statusCode, up.body).toBe(200);
    let s = (await op.get('/api/streams')).json().streams[0];
    expect(s.fallback).toEqual({ mode: 'image', imageSet: true, minutes: 15, switchBackSeconds: 20 });
    expect((await op.get(`/api/streams/${streamId}/fallback-image`)).rawPayload.equals(png)).toBe(true);
    await op.req('DELETE', `/api/streams/${streamId}/fallback-image`);
    s = (await op.get('/api/streams')).json().streams[0];
    expect(s.fallback).toMatchObject({ mode: 'standard', imageSet: false });
  });

  it('lets other projects use the API with a key, within its role', async () => {
    expect((await op.post('/api/api-keys', { name: 'x' })).statusCode).toBe(403);
    const created = await admin.post('/api/api-keys', { name: 'Website', role: 'operator', expiresInDays: 30 });
    expect(created.statusCode).toBe(200);
    const token = created.json().token as string;
    expect(token).toMatch(/^rsk_/);
    const list = (await admin.get('/api/api-keys')).json();
    expect(list[0]).toMatchObject({ name: 'Website', role: 'operator', active: true, prefix: token.slice(0, 10) });
    expect(JSON.stringify(list)).not.toContain(token);

    const call = (method: string, url: string, payload?: object, t = token) => ctx.app.inject({ method: method as 'GET', url, payload, headers: { authorization: `Bearer ${t}` } });
    expect((await call('GET', '/api/streams')).json().streams).toHaveLength(1);
    // No CSRF header needed with a key.
    const live = await call('POST', `/api/streams/${streamId}/live`, { live: false });
    expect(live.statusCode, live.body).toBe(200);
    expect((await call('GET', '/api/users')).json().error).toBe('not_allowed_with_api_key');
    expect((await call('GET', '/api/settings')).statusCode).toBe(403);
    expect((await call('GET', '/api/auth/me')).json().user.name).toBe('Website (API)');
    expect((await call('GET', '/api/streams', undefined, 'rsk_wrongwrongwrongwrongwrongwrong')).json().error).toBe('invalid_api_key');
    const [a] = await ctx.sql<{ details: { apiKey?: string } }[]>`SELECT details FROM audit_log WHERE action = 'stream.stopped' ORDER BY created_at DESC LIMIT 1`;
    expect(a.details.apiKey).toBe('Website');

    await admin.req('DELETE', `/api/api-keys/${list[0].id}`);
    expect((await call('GET', '/api/streams')).statusCode).toBe(401);
  });

  it('delivers signed webhooks and retries failures', async () => {
    const got: { headers: http.IncomingHttpHeaders; body: string }[] = [];
    let fail = false;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { got.push({ headers: req.headers, body }); res.statusCode = fail ? 500 : 204; res.end(); });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    try {
      expect((await admin.post('/api/webhooks', { name: 'Bad', url: 'http://169.254.169.254/' })).json().error).toBe('url_not_allowed');
      const id = (await admin.post('/api/webhooks', { name: 'Site', url, events: ['stream.source.changed', 'output.live'] })).json().id;
      const hooks = (await admin.get('/api/webhooks')).json();
      const secret = hooks[0].secret as string;
      expect(secret).toMatch(/^whsec_/);

      const t = (await admin.post(`/api/webhooks/${id}/test`)).json();
      expect(t).toMatchObject({ ok: true, status: 204 });
      const ping = got.pop()!;
      expect(ping.headers['x-restream-event']).toBe('ping');
      const [, ts] = /t=(\d+)/.exec(String(ping.headers['x-restream-signature']))!;
      expect(ping.headers['x-restream-signature']).toBe(sign(secret, ping.body, Number(ts)));
      expect(String(ping.headers['x-restream-signature'])).toContain(createHmac('sha256', secret).update(`${ts}.${ping.body}`).digest('hex'));

      ctx.app.webhooks.start(60_000);
      bus.publish('output.stopped', { not: 'subscribed' });
      bus.publish('stream.source.changed', { stream: { id: streamId, name: 'Main' }, from: 'main', to: 'backup' });
      await ctx.app.webhooks.flush();
      expect(got).toHaveLength(1);
      const body = JSON.parse(got[0].body);
      expect(body).toMatchObject({ type: 'stream.source.changed', data: { from: 'main', to: 'backup' }, instance: { name: 'Restream' } });

      fail = true;
      bus.publish('output.live', { destination: { id: 'd1' } });
      await ctx.app.webhooks.flush();
      const deliveries = (await admin.get(`/api/webhooks/${id}/deliveries`)).json();
      expect(deliveries[0]).toMatchObject({ event: 'output.live', status: 'pending', attempts: 1, responseCode: 500, error: 'HTTP 500' });
      expect(new Date(deliveries[0].nextAttemptAt).getTime()).toBeGreaterThan(Date.now() + 20_000);

      fail = false;
      const again = await admin.post(`/api/webhooks/deliveries/${deliveries[0].id}/redeliver`);
      expect(again.statusCode).toBe(200);
      await ctx.app.webhooks.flush();
      const after = (await admin.get(`/api/webhooks/${id}/deliveries`)).json();
      expect(after[0]).toMatchObject({ event: 'output.live', status: 'delivered', eventId: deliveries[0].eventId });
    } finally {
      server.close();
    }
  });
});

describe('failover with real processes', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let op: Client;
  const dir = path.join(tmpdir(), `restream-failover-${process.pid}`);
  const log = path.join(dir, 'ffmpeg.log');
  let paths: object[] = [];
  let mtx: http.Server;
  const saved = { ...config.media };

  const feed = (key: string) => ({
    name: `live/${key}`, online: true, onlineTime: new Date().toISOString(), source: { type: 'rtmpConn', id: key },
    tracks2: [{ codec: 'H264', codecProps: { width: 1920, height: 1080 } }, { codec: 'MPEG-4 Audio', codecProps: { sampleRate: 48000, channelCount: 2 } }],
    readers: [], inboundBytes: 1000,
  });
  const launches = () => { try { return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
  async function until(check: () => boolean, what: string) {
    for (let i = 0; i < 100; i++) {
      await ctx.app.media.tick();
      if (check()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  beforeAll(async () => {
    mkdirSync(dir, { recursive: true });
    // Stands in for FFmpeg: logs its arguments and reports progress until it is stopped.
    const fake = path.join(dir, 'ffmpeg');
    writeFileSync(fake, `#!/bin/sh\necho "$@" >> ${log}\nwhile true; do printf 'fps=50\\nbitrate=6000.0kbits/s\\ntotal_size=1000\\nprogress=continue\\n'; sleep 0.2; done\n`);
    chmodSync(fake, 0o755);
    mtx = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ pageCount: 1, items: paths })); });
    await new Promise<void>((r) => mtx.listen(0, '127.0.0.1', r));
    Object.assign(config.media, { enabled: true, apiUrl: `http://127.0.0.1:${(mtx.address() as AddressInfo).port}`, ffmpegPath: fake, rtspUrl: 'rtsp://127.0.0.1:8554' });

    ctx = await setup();
    await addUser(ctx.sql, 'op@example.com', 'correct horse battery', 'operator');
    op = new Client(ctx.app);
    await loginWithEnrolment(op, 'op@example.com', 'correct horse battery');
  });
  afterAll(async () => {
    await ctx.app.close();
    await ctx.sql.end();
    mtx.close();
    Object.assign(config.media, saved);
  });

  it('moves the live output from main to backup to the fallback image and back', async () => {
    const id = (await op.post('/api/streams', { name: 'Main' })).json().id;
    await op.post(`/api/streams/${id}/backup-key`, { enabled: true });
    await op.req('PATCH', `/api/streams/${id}`, { fallbackMode: 'standard', switchBackSeconds: 0 });
    await op.post(`/api/streams/${id}/destinations`, { name: 'YouTube', platform: 'youtube', streamKey: 'yt-key-1234' });
    const s = (await op.get('/api/streams')).json().streams[0];
    const main = s.ingest.streamKey as string;
    const backup = s.backupIngest.streamKey as string;
    const dest = s.destinations[0].id as string;
    const events: BusEvent[] = [];
    const listen = (e: BusEvent) => { if (e.type === 'stream.source.changed') events.push(e); };
    bus.on('event', listen);
    const media = ctx.app.media;
    const live = () => media.outputState(dest).state === 'live';
    try {
      paths = [feed(main), feed(backup)];
      await op.post(`/api/streams/${id}/live`, { live: true });
      await until(() => live() && launches().length === 1, 'main on air');
      expect(launches()[0]).toContain(`rtsp://127.0.0.1:8554/live/${main} `);
      expect(launches()[0]).toContain('rtmps://a.rtmps.youtube.com/live2/yt-key-1234');
      expect(media.sourceState(id)).toMatchObject({ active: 'main', backupConfigured: true, backup: { online: true } });

      paths = [feed(backup)];
      await until(() => live() && launches().length === 2, 'backup on air');
      expect(launches()[1]).toContain(`/live/${backup} `);
      expect(media.sourceState(id).active).toBe('backup');
      // A feed switch is not a failure.
      expect(media.outputState(dest).attempts).toBe(0);

      paths = [];
      await until(() => live() && launches().length === 3, 'fallback image on air');
      expect(launches()[2]).toMatch(/-loop 1 -framerate 50 -i \S+fallback\.png/);
      expect(media.sourceState(id).fallbackEndsAt).toBeTruthy();

      paths = [feed(main)];
      await until(() => live() && launches().length === 4, 'main back on air');
      expect(launches()[3]).toContain(`/live/${main} `);
      expect(events.map((e) => `${e.data.from}>${e.data.to}`)).toEqual(['none>main', 'main>backup', 'backup>fallback', 'fallback>main']);

      await op.post(`/api/streams/${id}/live`, { live: false });
      await until(() => media.outputState(dest).state === 'off', 'stopped');
    } finally {
      bus.off('event', listen);
    }
  });
});
