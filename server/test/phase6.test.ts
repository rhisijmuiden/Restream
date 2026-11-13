import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { Client, addUser, loginWithEnrolment, setup } from './helpers.js';
import { startFakePlatforms } from './fakePlatforms.js';
import { encrypt } from '../src/lib/crypto.js';
import { FrameStats, nominalFps } from '../src/health/frames.js';
import { IssueTracker, evaluate, type EvalInput, type FeedPoint, type Issue } from '../src/health/monitor.js';
import { sourceApi } from '../src/media/mediamtx.js';
import { probeArgs } from '../src/media/ffmpeg.js';
import { transcodeCores } from '../src/health/preflight.js';
import { issueRow } from '../src/lib/notify.js';
import type { ServerSample } from '../src/health/system.js';
import { HealthMonitor } from '../src/health/monitor.js';
import { config } from '../src/config.js';
import { offline, type MediaSupervisor } from '../src/media/supervisor.js';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const server = (over: Partial<ServerSample> = {}): ServerSample => ({
  at: 0, cpuPercent: 20, cores: 4, memory: { totalBytes: 8e9, usedBytes: 2e9 }, uploadKbps: 10_000, downloadKbps: 8_000,
  disk: { totalBytes: 80e9, freeBytes: 50 * 1024 ** 3 }, load1: 0.5, ...over,
});

describe('health probe: framecrc lines', () => {
  it('counts frames, key-frame interval and time stamps going back', () => {
    const f = new FrameStats();
    const lines = ['#tb 0: 1/1000', '#media_type 0: video'];
    // 25 fps, a key frame every 2 s (50 frames), one frame whose dts goes back.
    for (let i = 0; i < 120; i++) lines.push(`0, ${i * 40}, ${i * 40}, 40, 5000, 0xabcdef01${i % 50 === 0 ? '' : ', F=0x0'}`);
    lines.push('0, 4000, 4000, 40, 5000, 0x00000000, F=0x0');
    // Lines may arrive split anywhere.
    const text = `${lines.join('\n')}\n`;
    f.push(text.slice(0, 333));
    f.push(text.slice(333));
    const w = f.take();
    expect(w.frames).toBe(121);
    expect(w.bytes).toBe(121 * 5000);
    expect(w.keyframeSeconds).toBe(2);
    expect(w.timestampErrors).toBe(1);
    expect(f.take()).toMatchObject({ frames: 0, timestampErrors: 0, keyframeSeconds: 2 });
  });

  it('reads the time base and NOPTS', () => {
    const f = new FrameStats();
    f.push('#tb 0: 1/90000\n0, -9223372036854775808, 0, 3600, 100, 0x1\n0, 3600, 3600, 3600, 100, 0x2, F=0x0\n0, 360000, 360000, 3600, 100, 0x3\n');
    expect(f.take()).toMatchObject({ frames: 3, keyframeSeconds: 4, timestampErrors: 0 });
  });

  it('rounds a measured frame rate to the common one', () => {
    expect(nominalFps([49.5, 50, 50.2, 49.9])).toBe(50);
    expect(nominalFps([29.9, 30.1, 29.97])).toBe(29.97);
    expect(nominalFps([12, 12, 12])).toBe(12);
    expect(nominalFps([50])).toBeNull();
  });

  it('copies video only, flushing every packet, without decoding', () => {
    const a = probeArgs('rtsp://127.0.0.1:8554/live/k').join(' ');
    expect(a).toContain('-map 0:v:0 -c copy -flush_packets 1 -f framecrc -');
    expect(a).not.toContain('libx264');
  });

  it('uses the MediaMTX v1.21 routes for connections', () => {
    expect(sourceApi('rtmpConn', 'kick')).toBe('rtmp/conns/kick');
    expect(sourceApi('rtmpsConn', 'kick')).toBe('rtmps/conns/kick');
    expect(sourceApi('srtConn', 'get')).toBe('srt/conns/get');
    expect(sourceApi('webRTCSession', 'kick')).toBe('webrtc/sessions/kick');
    expect(sourceApi('hlsSource', 'kick')).toBeNull();
  });
});

describe('health rules', () => {
  const feedHistory = (now: number, values: [number, number | null, number | null][]): FeedPoint[] =>
    values.map(([ago, kbps, fps]) => ({ t: now - ago, kbps, fps }));
  const steady = (now: number, kbps: number, fps: number, from = 60_000, to = 0) => {
    const out: [number, number | null, number | null][] = [];
    for (let ago = from; ago >= to; ago -= 2000) out.push([ago, kbps, fps]);
    return out;
  };
  const input = (now: number, over: Partial<EvalInput> = {}): EvalInput => ({ now, server: server(), uploadCapacityKbps: null, feeds: [], outputs: [], ...over });

  it('raises a bitrate drop after the grace time and clears it when the bitrate is back', () => {
    const raised: Issue[] = []; const cleared: Issue[] = [];
    const tr = new IssueTracker(6000, (i) => raised.push(i), (i) => cleared.push(i));
    const feed = (now: number, recentKbps: number) => ({
      streamId: 's1', streamName: 'Kerkdienst', input: 'main' as const, keyframeSeconds: 2, errors: 0, srtDrops: 0,
      history: feedHistory(now, [...steady(now, 6000, 50, 60_000, 8_000), ...steady(now, recentKbps, 50, 6_000, 0)]),
    });
    let now = 1_000_000;
    evaluate(tr, input(now, { feeds: [feed(now, 1500)] }));
    expect(tr.list()).toHaveLength(0);
    now += 4000;
    evaluate(tr, input(now, { feeds: [feed(now, 1500)] }));
    expect(tr.list()).toMatchObject([{ code: 'feed_bitrate_drop', severity: 'warn', streamName: 'Kerkdienst', params: { now: 1500, before: 6000 } }]);
    expect(raised).toHaveLength(1);
    // Far below: danger.
    now += 2000;
    evaluate(tr, input(now, { feeds: [feed(now, 800)] }));
    expect(tr.list()[0].severity).toBe('danger');
    // Back to normal: cleared after the hold time, not at once.
    now += 2000;
    evaluate(tr, input(now, { feeds: [feed(now, 6000)] }));
    expect(tr.list()).toHaveLength(1);
    now += 6000;
    evaluate(tr, input(now, { feeds: [feed(now, 6000)] }));
    expect(tr.list()).toHaveLength(0);
    expect(cleared).toHaveLength(1);
  });

  it('warns about missing frames, slow key frames, errors and SRT drops', () => {
    const tr = new IssueTracker();
    let now = 2_000_000;
    const feed = (n: number) => ({
      streamId: 's1', streamName: 'S', input: 'backup' as const, keyframeSeconds: 6, errors: 7, srtDrops: 25,
      history: feedHistory(n, [...steady(n, 4000, 50, 60_000, 8_000), ...steady(n, 4000, 38, 6_000, 0)]),
    });
    evaluate(tr, input(now, { feeds: [feed(now)] }));
    now += 10_000;
    evaluate(tr, input(now, { feeds: [feed(now)] }));
    const codes = tr.list().map((i) => i.code).sort();
    expect(codes).toEqual(['feed_errors', 'feed_fps_low', 'feed_keyframes', 'feed_srt_drops']);
    expect(tr.list().find((i) => i.code === 'feed_fps_low')!.params).toMatchObject({ now: 38, expected: 50 });
    // The feed goes offline: its issues are swept away.
    const seen = evaluate(tr, input(now + 2000));
    tr.sweep(seen);
    expect(tr.list()).toHaveLength(0);
  });

  it('warns when a destination delivers slower than real time, and about the server', () => {
    const tr = new IssueTracker();
    let now = 3_000_000;
    const out = (n: number, speed: number) => ({
      destinationId: 'd1', destinationName: 'YouTube', streamId: 's1', streamName: 'S', live: true, state: 'live' as const,
      history: [0, 2000, 4000, 6000, 8000].map((ago) => ({ t: n - ago, kbps: 6000, speed, cpu: 40 })),
    });
    const srv = server({ cpuPercent: 98, uploadKbps: 95_000, disk: { totalBytes: 80e9, freeBytes: 0.5 * 1024 ** 3 } });
    evaluate(tr, input(now, { server: srv, uploadCapacityKbps: 100_000, outputs: [out(now, 0.7)] }));
    expect(tr.list().map((i) => i.code)).toEqual(['server_disk']);
    now += 20_000;
    evaluate(tr, input(now, { server: srv, uploadCapacityKbps: 100_000, outputs: [out(now, 0.7)] }));
    const by = Object.fromEntries(tr.list().map((i) => [i.code, i]));
    expect(by.output_slow).toMatchObject({ severity: 'danger', destinationName: 'YouTube', params: { speed: 0.7 } });
    expect(by.server_cpu).toMatchObject({ severity: 'danger', params: { percent: 98, cores: 4 } });
    expect(by.server_upload).toMatchObject({ params: { percent: 95, mbps: 95, capacityMbps: 100 } });
    expect(by.server_disk).toMatchObject({ severity: 'danger', params: { freeGb: 0.5 } });
    // Without a known capacity the upload is never judged.
    const tr2 = new IssueTracker();
    evaluate(tr2, input(now, { server: server({ uploadKbps: 1e6 }) }));
    evaluate(tr2, input(now + 20_000, { server: server({ uploadKbps: 1e6 }) }));
    expect(tr2.list()).toHaveLength(0);
  });

  it('words issues for the mail in both languages', () => {
    const i: Issue = {
      key: 'k', code: 'feed_keyframes', severity: 'warn', since: '', streamId: 's', streamName: 'Kerkdienst', input: 'main',
      destinationId: null, destinationName: null, params: { seconds: 8 },
    };
    expect(issueRow('en', i)).toEqual(['Key frames too far apart · Kerkdienst (main feed)', expect.stringContaining('every 8 s')]);
    expect(issueRow('nl', i)[0]).toBe('Keyframes te ver uit elkaar · Kerkdienst (hoofdfeed)');
  });

  it('estimates transcoding cost', () => {
    expect(transcodeCores(1080, 30)).toBe(1.5);
    expect(transcodeCores(720, 30)).toBe(0.7);
    expect(transcodeCores(1080, 60)).toBe(3);
  });
});

describe('phase 6: health API, check before Go live and broadcast info', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let admin: Client;
  let viewer: Client;
  let fake: Awaited<ReturnType<typeof startFakePlatforms>>;
  let listener: Server;
  let openPort = 0;
  let closedPort = 0;
  let streamId = '';
  const dest: Record<string, string> = {};

  beforeAll(async () => {
    ctx = await setup();
    fake = await startFakePlatforms();
    listener = createServer((s) => s.destroy());
    await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
    openPort = (listener.address() as AddressInfo).port;
    const tmp = createServer();
    await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r));
    closedPort = (tmp.address() as AddressInfo).port;
    await new Promise((r) => tmp.close(r));

    await addUser(ctx.sql, 'admin@example.com', 'correct horse battery', 'admin');
    await addUser(ctx.sql, 'view@example.com', 'correct horse battery', 'viewer');
    admin = new Client(ctx.app); viewer = new Client(ctx.app);
    await loginWithEnrolment(admin, 'admin@example.com', 'correct horse battery');
    await loginWithEnrolment(viewer, 'view@example.com', 'correct horse battery');
    for (const p of ['youtube', 'facebook', 'twitch']) await admin.req('PUT', `/api/accounts/apps/${p}`, { clientId: `${p}-client`, clientSecret: `${p}-secret` });
    streamId = (await admin.post('/api/streams', { name: 'Kerkdienst' })).json().id;

    const acc = async (provider: string, ext: string, name: string) => (await ctx.sql<{ id: string }[]>`
      INSERT INTO platform_accounts (provider, external_id, name, handle, access_token_enc, scopes)
      VALUES (${provider}, ${ext}, ${name}, '', ${encrypt(`${provider}-token`)}, '') RETURNING id`)[0].id;
    const yt = await acc('youtube', 'UC1', 'Kerk TV');
    const fb = await acc('facebook', 'page-1', 'Kerk Pagina');
    const tw = await acc('twitch', 'tw-1', 'kerktv');
    const add = async (name: string, platform: string, o: { account?: string; server?: string; key?: string; remote?: string; live?: boolean; mode?: string }) => (await ctx.sql<{ id: string }[]>`
      INSERT INTO destinations (stream_id, name, platform, server_url, stream_key_enc, auth, account_id, remote_id, live, mode)
      VALUES (${streamId}, ${name}, ${platform}, ${o.server ?? ''}, ${o.key ? encrypt(o.key) : ''}, ${o.account ? 'account' : 'key'}, ${o.account ?? null},
              ${o.remote ?? null}, ${o.live ?? false}, ${o.mode ?? 'copy'})
      RETURNING id`)[0].id;
    dest.yt = await add('YouTube', 'youtube', { account: yt, remote: 'bc-7', live: true });
    dest.fb = await add('Facebook', 'facebook', { account: fb, remote: 'lv-7', live: true });
    dest.tw = await add('Twitch', 'twitch', { account: tw, live: true });
    dest.own = await add('Eigen server', 'rtmp', { server: `rtmp://127.0.0.1:${openPort}/live`, key: 'abc', live: true });
    dest.down = await add('Kapotte server', 'rtmp', { server: `rtmp://127.0.0.1:${closedPort}/live`, key: 'abc', mode: 'transcode' });
    dest.nokey = await add('Kick', 'kick', { server: 'rtmps://127.0.0.1:1/app' });
    dest.dns = await add('Onbekend', 'rtmp', { server: 'rtmp://does-not-exist.invalid/live', key: 'abc' });
  });
  afterAll(async () => {
    await ctx.app.close(); await fake.close(); await new Promise((r) => listener.close(r)); await ctx.sql.end();
  });

  it('serves the health snapshot to every role', async () => {
    const r = await viewer.get('/api/monitor');
    expect(r.statusCode).toBe(200);
    const h = r.json();
    expect(h).toMatchObject({ enabled: false, feeds: [], outputs: [], issues: [] });
    expect(h.server.cores).toBeGreaterThan(0);
    expect((await viewer.get('/api/monitor?history=0')).json().server.history).toEqual([]);
  });

  it('stores the upload capacity in the settings', async () => {
    expect((await admin.req('PUT', '/api/settings', { health: { uploadMbps: 5 } })).statusCode).toBe(200);
    expect((await admin.get('/api/settings')).json().health).toEqual({ uploadMbps: 5 });
    expect((await viewer.req('PUT', '/api/settings', { health: { uploadMbps: 1 } })).statusCode).toBe(403);
  });

  it('checks everything before Go live without changing anything', async () => {
    expect((await viewer.post(`/api/streams/${streamId}/preflight`)).statusCode).toBe(403);
    const r = await admin.post(`/api/streams/${streamId}/preflight`);
    expect(r.statusCode).toBe(200);
    const res = r.json();
    const find = (code: string, destId?: string) => res.checks.find((c: { code: string; destinationId?: string }) => c.code === code && (!destId || c.destinationId === destId));
    expect(find('ingest_offline').status).toBe('warn');
    expect(find('backup_none').status).toBe('info');
    expect(find('dest_account_ok', dest.yt)).toMatchObject({ status: 'ok', params: { account: 'Kerk TV' }, platform: 'youtube' });
    expect(find('dest_account_ok', dest.fb)).toBeTruthy();
    expect(find('dest_account_ok', dest.tw)).toBeTruthy();
    expect(find('dest_reachable', dest.own)).toMatchObject({ status: 'ok', params: { host: '127.0.0.1' } });
    expect(find('dest_unreachable', dest.down)).toMatchObject({ status: 'fail', params: { reason: 'refused' } });
    expect(find('dest_no_key', dest.nokey).status).toBe('fail');
    expect(find('dest_dns', dest.dns).status).toBe('fail');
    // One transcoded destination (1080p30 ≈ 1.5 cores) and the upload against the 5 Mbit/s set above.
    expect(find('cpu_ok') ?? find('cpu_tight')).toMatchObject({ params: { needed: 1.5 } });
    // 6000 + 160 kbit/s for the transcoded destination plus 5 % overhead does not fit in 5 Mbit/s.
    expect(find('upload_over')).toMatchObject({ status: 'fail', params: { mbps: 6.5, capacity: 5, percent: 130 } });
    expect(res).toMatchObject({ ok: false, fails: 4 });
    // Failures first, then warnings.
    expect(res.checks[0].status).toBe('fail');
    // Nothing went live.
    const [{ n }] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM destinations WHERE live AND id IN (${dest.down}, ${dest.nokey}, ${dest.dns})`;
    expect(n).toBe(0);
    // YouTube was asked who the channel is, once.
    expect(fake.find('GET', '/youtube/channels').length).toBe(1);
  });

  it('reports an account the platform refuses', async () => {
    fake.fail.add('GET /youtube/channels');
    const res = (await admin.post(`/api/streams/${streamId}/preflight`)).json();
    fake.fail.delete('GET /youtube/channels');
    const c = res.checks.find((x: { code: string }) => x.code === 'dest_account_error');
    expect(c).toMatchObject({ status: 'fail', destinationId: dest.yt, params: { account: 'Kerk TV' } });
    expect(c.params.error).toContain('forbidden by test');
  });

  it('pushes a new title to YouTube, Facebook and Twitch while live', async () => {
    const r = await admin.req('PUT', `/api/streams/${streamId}/broadcast-info`, { title: 'Kerstnachtdienst', description: 'Live vanuit de kerk' });
    expect(r.statusCode).toBe(200);
    const by = Object.fromEntries(r.json().results.map((x: { destinationId: string }) => [x.destinationId, x]));
    expect(by[dest.yt]).toMatchObject({ result: 'updated', thumbnail: null });
    expect(by[dest.fb]).toMatchObject({ result: 'updated' });
    expect(by[dest.tw]).toMatchObject({ result: 'updated' });
    expect(by[dest.own]).toMatchObject({ result: 'manual' });
    expect(by[dest.down]).toMatchObject({ result: 'next' });

    const put = fake.find('PUT', '/youtube/liveBroadcasts').at(-1)!;
    expect(put.query.part).toBe('snippet');
    // The planned start YouTube had is sent back, privacy is left alone.
    expect(put.body).toMatchObject({ id: 'bc-7', snippet: { title: 'Kerstnachtdienst', description: 'Live vanuit de kerk', scheduledStartTime: '2026-11-13T18:00:00Z' } });
    expect(put.body).not.toHaveProperty('status');
    expect(fake.find('POST', '/graph/lv-7').at(-1)!.body).toEqual({ title: 'Kerstnachtdienst', description: 'Live vanuit de kerk' });
    expect(fake.find('PATCH', '/helix/channels').at(-1)!.body).toEqual({ title: 'Kerstnachtdienst' });

    const s = (await admin.get('/api/streams')).json().streams[0];
    expect(s).toMatchObject({ title: 'Kerstnachtdienst', description: 'Live vanuit de kerk', thumbnailSet: false, liveEvent: null });
  });

  it('says why a platform refused the new title', async () => {
    fake.fail.add('POST /graph/lv-7');
    const r = await admin.req('PUT', `/api/streams/${streamId}/broadcast-info`, { title: 'Nieuw', description: '' });
    fake.fail.delete('POST /graph/lv-7');
    const fb = r.json().results.find((x: { destinationId: string }) => x.destinationId === dest.fb);
    expect(fb).toMatchObject({ result: 'failed' });
    expect(fb.error).toContain('forbidden by test');
  });

  it('stores a thumbnail and sets it on the live YouTube broadcast', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2000, 7)]);
    const big = Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]);
    const up = (body: Buffer) => ctx.app.inject({ method: 'PUT', url: `/api/streams/${streamId}/thumbnail`, payload: body, headers: { 'content-type': 'image/png', 'x-restream': '1', cookie: admin.cookie } });
    expect((await up(big)).json()).toMatchObject({ error: 'thumbnail_too_large' });
    expect((await up(Buffer.from('not an image'))).json()).toMatchObject({ error: 'invalid_image' });
    const r = await up(png);
    expect(r.statusCode).toBe(200);
    expect(r.json().results).toEqual([expect.objectContaining({ destinationId: dest.yt, result: 'updated', thumbnail: 'updated' })]);
    const set = fake.find('POST', '/yt-upload/thumbnails/set').at(-1)!;
    expect(set.query).toMatchObject({ videoId: 'bc-7' });
    expect(set.body).toEqual({ contentType: 'image/png', bytes: png.length });

    const img = await viewer.get(`/api/streams/${streamId}/thumbnail`);
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect((await admin.get('/api/streams')).json().streams[0].thumbnailSet).toBe(true);
    expect((await admin.req('DELETE', `/api/streams/${streamId}/thumbnail`)).statusCode).toBe(200);
    expect((await viewer.get(`/api/streams/${streamId}/thumbnail`)).statusCode).toBe(404);
  });

  it('also renames the live event, which is what the platforms show', async () => {
    const [ev] = await ctx.sql<{ id: string }[]>`
      INSERT INTO events (stream_id, title, starts_at, status, started_at) VALUES (${streamId}, 'Dienst', now(), 'live', now()) RETURNING id`;
    await admin.req('PUT', `/api/streams/${streamId}/broadcast-info`, { title: 'Avonddienst', description: 'Met koor' });
    const [row] = await ctx.sql<{ title: string; description: string }[]>`SELECT title, description FROM events WHERE id = ${ev.id}`;
    expect(row).toEqual({ title: 'Avonddienst', description: 'Met koor' });
    expect((await admin.get('/api/streams')).json().streams[0].liveEvent).toMatchObject({ id: ev.id, title: 'Avonddienst' });
  });

  it('measures a live feed with a light FFmpeg probe', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rs-probe-'));
    const fake = path.join(dir, 'ffmpeg');
    // 25 frames per second, time stamps 6x faster (so a key frame every 25 frames is 6 s apart), one damaged packet.
    writeFileSync(fake, `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'args'))}, process.argv.slice(2).join(' '));
process.stdout.write('#tb 0: 1/1000\\n#media_type 0: video\\n');
let i = 0;
setInterval(() => {
  process.stdout.write('0, ' + i * 240 + ', ' + i * 240 + ', 240, 4000, 0x1' + (i % 25 === 0 ? '' : ', F=0x0') + '\\n');
  if (i === 5) process.stderr.write('[h264 @ 0x1] corrupt input packet in stream 0\\n');
  i++;
}, 40);
process.on('SIGTERM', () => process.exit(0));
`);
    chmodSync(fake, 0o755);
    const saved = { ...config.media };
    Object.assign(config.media, { enabled: true, ffmpegPath: fake });
    let probed = new Set<string>();
    const media = {
      feeds: () => [{
        streamId, input: 'main', path: 'live/rskey', framesInError: 0, source: { type: 'rtmpConn', id: 'c1' },
        state: { ...offline, online: true, protocol: 'RTMP', bitrateKbps: 5000, video: { codec: 'H264', width: 1920, height: 1080 } },
      }],
      setProbed: (p: Set<string>) => { probed = p; },
      outputPids: () => new Map(),
      outputState: () => ({ state: 'off', since: null, bitrateKbps: null, fps: null, speed: null, attempts: 0, lastError: null, errorCode: null, nextRetryAt: null }),
    } as unknown as MediaSupervisor;
    const mon = new HealthMonitor(ctx.sql, media, ctx.app.log, 500);
    try {
      await mon.tick();
      expect(probed).toEqual(new Set(['live/rskey']));
      for (let i = 0; i < 4; i++) { await new Promise((r) => setTimeout(r, 450)); await mon.tick(); }
      const f = mon.snapshot().feeds[0];
      expect(f).toMatchObject({ streamId, input: 'main', protocol: 'RTMP', bitrateKbps: 5000, keyframeSeconds: 6 });
      expect(f.fps).toBeGreaterThan(18);
      expect(f.fps).toBeLessThan(30);
      expect(f.errors).toBe(1);
      expect(readFileSync(path.join(dir, 'args'), 'utf8')).toContain('rtsp://127.0.0.1:8554/live/rskey -map 0:v:0 -c copy -flush_packets 1 -f framecrc -');
      // Key frames 6 s apart: a warning once it lasts 10 s.
      const later = Date.now() + 11_000;
      const tr = mon.tracker;
      tr.observe(`feed_keyframes:${streamId}:main`, true, 10_000, later, () => ({
        code: 'feed_keyframes', severity: 'warn', streamId, streamName: 'Kerkdienst', input: 'main', destinationId: null, destinationName: null, params: { seconds: 6 },
      }));
      expect(mon.issues().some((i) => i.code === 'feed_keyframes')).toBe(true);
    } finally {
      await mon.stop();
      Object.assign(config.media, saved);
    }
  });

  it('mails new health issues once per 15 minutes, several in one message', async () => {
    const sent: string[][] = [];
    const n = ctx.app.notifier;
    const issues: Issue[] = [
      { key: 'server_cpu', code: 'server_cpu', severity: 'danger', since: '', streamId: null, streamName: null, input: null, destinationId: null, destinationName: null, params: { percent: 99, cores: 2 } },
      { key: `output_slow:${dest.yt}`, code: 'output_slow', severity: 'warn', since: '', streamId, streamName: 'Kerkdienst', input: null, destinationId: dest.yt, destinationName: 'YouTube', params: { speed: 0.9 } },
    ];
    const orig = n.send.bind(n);
    n.send = (async (_ev: string, build: (t: unknown) => { rows?: [string, string][] }) => {
      const { texts } = await import('../src/lib/notify.js');
      sent.push((build(texts('en')).rows ?? []).map((r) => r[0]));
      return true;
    }) as typeof n.send;
    const health = n.health!;
    const realIssues = health.issues.bind(health);
    health.issues = () => issues;
    const s = (await import('../src/lib/settings.js')).getSettings;
    const settings = await s(ctx.sql);
    await n.checkHealth(settings, 1_000_000);
    await n.checkHealth(settings, 1_000_000 + 60_000);
    await n.checkHealth(settings, 1_000_000 + 16 * 60_000);
    health.issues = realIssues;
    n.send = orig;
    expect(sent).toEqual([
      ['Server CPU is full · Server', 'Destination cannot keep up · Kerkdienst › YouTube'],
      ['Server CPU is full · Server', 'Destination cannot keep up · Kerkdienst › YouTube'],
    ]);
  });
});
