import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, addUser, loginWithEnrolment, setup } from './helpers.js';
import { ffmpegArgs, parseProgress, redact, type OutputSpec } from '../src/media/ffmpeg.js';
import { publishUrl, serverUrlProblem } from '../src/media/platforms.js';
import { ingestFromPath } from '../src/media/supervisor.js';

const spec = (o: Partial<OutputSpec> = {}): OutputSpec => ({
  platform: 'youtube', serverUrl: 'rtmps://a.rtmps.youtube.com/live2', streamKey: 'abcd-efgh', passphrase: '',
  mode: 'copy', videoBitrate: 6000, audioBitrate: 160, maxHeight: 1080, fps: null, ...o,
});

describe('platforms', () => {
  it('builds publish URLs', () => {
    expect(publishUrl('youtube', 'rtmps://a.rtmps.youtube.com/live2/', 'k-1')).toBe('rtmps://a.rtmps.youtube.com/live2/k-1');
    expect(publishUrl('rtmp', 'rtmp://example.com/app', '')).toBe('rtmp://example.com/app');
    expect(publishUrl('srt', 'srt://example.com:9000', 'publish:live/abc', 'secretsecret'))
      .toBe('srt://example.com:9000?streamid=publish:live/abc&passphrase=secretsecret&pkt_size=1316');
    expect(publishUrl('srt', 'srt://example.com:9000?latency=200000', '')).toBe('srt://example.com:9000?latency=200000&pkt_size=1316');
  });

  it('refuses unusable server URLs', () => {
    expect(serverUrlProblem('youtube', 'rtmps://a.rtmps.youtube.com/live2')).toBeNull();
    expect(serverUrlProblem('facebook', 'rtmp://live-api-s.facebook.com/rtmp')).toBe('invalid_server_url');
    expect(serverUrlProblem('rtmp', 'file:///etc/passwd')).toBe('invalid_server_url');
    expect(serverUrlProblem('rtmp', 'rtmp://user:pw@host/app')).toBe('invalid_server_url');
    expect(serverUrlProblem('srt', 'rtmp://host/app')).toBe('invalid_server_url');
    expect(serverUrlProblem('rtmp', 'not a url')).toBe('invalid_server_url');
  });
});

describe('ffmpeg arguments', () => {
  const input = 'rtsp://127.0.0.1:8554/live/key';
  it('passes H.264/AAC through untouched', () => {
    const a = ffmpegArgs(input, spec(), { videoCodec: 'H264', audioCodec: 'MPEG-4 Audio' });
    expect(a.join(' ')).toContain('-c:v copy');
    expect(a.join(' ')).toContain('-c:a copy');
    expect(a.slice(-3)).toEqual(['-f', 'flv', 'rtmps://a.rtmps.youtube.com/live2/abcd-efgh']);
  });

  it('converts audio that RTMP cannot carry', () => {
    const a = ffmpegArgs(input, spec(), { videoCodec: 'H264', audioCodec: 'Opus' }).join(' ');
    expect(a).toContain('-c:v copy');
    expect(a).toContain('-c:a aac');
  });

  it('transcodes with the destination settings', () => {
    const a = ffmpegArgs(input, spec({ mode: 'transcode', videoBitrate: 4500, maxHeight: 720, fps: 30 }), { videoCodec: 'H264', audioCodec: 'MPEG-4 Audio' }).join(' ');
    expect(a).toContain('-c:v libx264');
    expect(a).toContain('-b:v 4500k -maxrate 4500k -bufsize 9000k');
    expect(a).toContain("scale=-2:'min(720,ih)'");
    expect(a).toContain('-r 30 -g 60');
  });

  it('uses MPEG-TS for SRT', () => {
    const a = ffmpegArgs(input, spec({ platform: 'srt', serverUrl: 'srt://h:1', streamKey: '' }), { videoCodec: 'H265', audioCodec: 'Opus' });
    expect(a.join(' ')).toContain('-c:v copy');
    expect(a.slice(-3)).toEqual(['-f', 'mpegts', 'srt://h:1?pkt_size=1316']);
  });

  it('parses progress and redacts secrets', () => {
    expect(parseProgress('fps=50.0\nbitrate=6012.3kbits/s\ntotal_size=1000\nspeed=1.01x\nprogress=continue\n'))
      .toEqual({ fps: 50, bitrateKbps: 6012, totalBytes: 1000, speed: 1.01 });
    expect(parseProgress('bitrate=N/A\nspeed=N/A\n').bitrateKbps).toBeNull();
    expect(redact('Error opening rtmp://x/app/abcd-efgh', ['abcd-efgh'])).toBe('Error opening rtmp://x/app/••••');
  });

  it('reads ingest details from MediaMTX', () => {
    const p = {
      name: 'live/k', online: true, onlineTime: '2026-11-12T10:00:00Z', source: { type: 'srtConn', id: '1' },
      tracks2: [{ codec: 'H264', codecProps: { width: 2560, height: 1440 } }, { codec: 'MPEG-4 Audio', codecProps: { sampleRate: 48000, channelCount: 2 } }],
      readers: [{ type: 'rtspSession', id: '2' }], inboundBytes: 2_000_000,
    };
    const s = ingestFromPath(p, { bytes: 1_000_000, at: 0 }, 2000);
    expect(s).toMatchObject({ online: true, protocol: 'SRT', bitrateKbps: 4000, readers: 1, overLimit: true, audio: { channels: 2 } });
    expect(ingestFromPath(undefined, undefined, 0).online).toBe(false);
  });
});

describe('streams API', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let op: Client;
  let viewer: Client;
  let streamId = '';
  let key = '';
  let pid = '';

  const hook = (body: object, remoteAddress = '127.0.0.1', headers: Record<string, string> = {}) =>
    ctx.app.inject({ method: 'POST', url: '/api/internal/mediamtx/auth', payload: body, remoteAddress, headers });

  beforeAll(async () => {
    ctx = await setup();
    await addUser(ctx.sql, 'op@example.com', 'correct horse battery', 'operator');
    await addUser(ctx.sql, 'view@example.com', 'correct horse battery', 'viewer');
    op = new Client(ctx.app);
    viewer = new Client(ctx.app);
    await loginWithEnrolment(op, 'op@example.com', 'correct horse battery');
    await loginWithEnrolment(viewer, 'view@example.com', 'correct horse battery');
  });
  afterAll(async () => { await ctx.app.close(); await ctx.sql.end(); });

  it('creates a stream with a secret ingest key', async () => {
    const r = await op.post('/api/streams', { name: 'Main' });
    expect(r.statusCode).toBe(200);
    streamId = r.json().id;
    const s = (await op.get('/api/streams')).json().streams[0];
    key = s.ingest.streamKey;
    pid = s.playbackId;
    expect(key).toMatch(/^rs[A-Za-z0-9]{30}$/);
    expect(s.ingest.srtUrl).toContain(`streamid=publish:live/${key}`);
    expect(s.playback.hls).toContain(`/live/${pid}/index.m3u8`);
    expect(s.playback.hls).not.toContain(key);
    expect(s.status.online).toBe(false);
  });

  it('hides keys from viewers and keeps them from operating', async () => {
    const s = (await viewer.get('/api/streams')).json().streams[0];
    expect(s.ingest.streamKey).toBeNull();
    expect(JSON.stringify(s)).not.toContain(key);
    expect((await viewer.post('/api/streams', { name: 'x' })).statusCode).toBe(403);
    expect((await viewer.post(`/api/streams/${streamId}/live`, { live: true })).statusCode).toBe(403);
  });

  it('lets MediaMTX accept only valid stream keys', async () => {
    expect((await hook({ action: 'publish', path: `live/${key}`, protocol: 'srt', ip: '203.0.113.9' })).statusCode).toBe(200);
    expect((await hook({ action: 'publish', path: `live/${key}`, protocol: 'rtmp', ip: '203.0.113.9' })).statusCode).toBe(200);
    expect((await hook({ action: 'publish', path: 'live/rsWrongWrongWrongWrongWrongWrong12', protocol: 'rtmp' })).statusCode).toBe(401);
    expect((await hook({ action: 'publish', path: `other/${key}`, protocol: 'rtmp' })).statusCode).toBe(401);
    expect((await hook({ action: 'publish', path: `live/${key}`, protocol: 'webrtc' })).statusCode).toBe(401);
    // Reading the raw ingest is only for local processes (FFmpeg outputs, the playback proxy).
    expect((await hook({ action: 'read', path: `live/${key}`, protocol: 'rtsp', ip: '127.0.0.1' })).statusCode).toBe(200);
    expect((await hook({ action: 'read', path: `live/${key}`, protocol: 'rtmp', ip: '203.0.113.9' })).statusCode).toBe(401);
    // The hook is not reachable from outside, also not through nginx.
    expect((await hook({ action: 'publish', path: `live/${key}`, protocol: 'rtmp' }, '203.0.113.9')).statusCode).toBe(404);
    expect((await hook({ action: 'publish', path: `live/${key}`, protocol: 'rtmp' }, '127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })).statusCode).toBe(404);
  });

  it('refuses a disabled stream and an old key after rotation', async () => {
    await op.req('PATCH', `/api/streams/${streamId}`, { enabled: false });
    expect((await hook({ action: 'publish', path: `live/${key}`, protocol: 'rtmp' })).statusCode).toBe(401);
    await op.req('PATCH', `/api/streams/${streamId}`, { enabled: true });
    expect((await op.post(`/api/streams/${streamId}/rotate-key`)).statusCode).toBe(200);
    expect((await hook({ action: 'publish', path: `live/${key}`, protocol: 'rtmp' })).statusCode).toBe(401);
    key = (await op.get('/api/streams')).json().streams[0].ingest.streamKey;
    expect((await hook({ action: 'publish', path: `live/${key}`, protocol: 'rtmp' })).statusCode).toBe(200);
  });

  it('manages destinations without ever returning their keys', async () => {
    expect((await op.post(`/api/streams/${streamId}/destinations`, { name: 'YT', platform: 'youtube' })).json().error).toBe('stream_key_required');
    expect((await op.post(`/api/streams/${streamId}/destinations`, { name: 'Bad', platform: 'rtmp', serverUrl: 'file:///etc/passwd' })).json().error).toBe('invalid_server_url');
    expect((await op.post(`/api/streams/${streamId}/destinations`, { name: 'Bad', platform: 'srt', serverUrl: 'srt://h:1', streamKey: 'a&b' })).statusCode).toBe(400);
    const yt = await op.post(`/api/streams/${streamId}/destinations`, { name: 'YouTube', platform: 'youtube', streamKey: 'yt-secret-key-1234' });
    expect(yt.statusCode).toBe(200);
    const srt = await op.post(`/api/streams/${streamId}/destinations`, {
      name: 'Studio', platform: 'srt', serverUrl: 'srt://studio.example.com:9000', passphrase: 'long-enough-phrase', enabled: false,
      mode: 'transcode', videoBitrate: 3000, maxHeight: 720, fps: 25,
    });
    expect(srt.statusCode, srt.body).toBe(200);
    const s = (await op.get('/api/streams')).json().streams[0];
    expect(s.destinations).toHaveLength(2);
    expect(s.destinations[0]).toMatchObject({ name: 'YouTube', serverUrl: 'rtmps://a.rtmps.youtube.com/live2', streamKeyMasked: '••••1234', live: false });
    expect(s.destinations[1]).toMatchObject({ passphraseSet: true, mode: 'transcode', maxHeight: 720, fps: 25 });
    const json = JSON.stringify(s);
    expect(json).not.toContain('yt-secret-key');
    expect(json).not.toContain('long-enough-phrase');

    // Editing without a key keeps the stored one.
    const id = yt.json().id;
    const put = await op.req('PUT', `/api/destinations/${id}`, { name: 'YouTube main', platform: 'youtube', mode: 'copy' });
    expect(put.statusCode).toBe(200);
    expect((await op.get('/api/streams')).json().streams[0].destinations[0]).toMatchObject({ name: 'YouTube main', streamKeyMasked: '••••1234' });
    expect((await op.req('PUT', `/api/destinations/${id}`, { name: 'x', platform: 'twitch', streamKey: 'k' })).json().error).toBe('platform_change');
  });

  it('goes live with the included destinations and stops again', async () => {
    expect((await op.post(`/api/streams/${streamId}/live`, { live: true })).json().changed).toBe(1);
    let d = (await op.get('/api/streams')).json().streams[0].destinations;
    expect(d.map((x: { live: boolean }) => x.live)).toEqual([true, false]);
    // Without an ingest the output waits (the media engine is off in tests, so the state stays as reported).
    await op.post(`/api/destinations/${d[1].id}/live`, { live: true });
    d = (await op.get('/api/streams')).json().streams[0].destinations;
    expect(d.every((x: { live: boolean }) => x.live)).toBe(true);
    expect((await op.post(`/api/streams/${streamId}/live`, { live: false })).json().changed).toBe(2);
    const rows = (await op.get('/api/streams')).json().streams[0].destinations;
    expect(rows.every((x: { live: boolean; liveSince: string | null }) => !x.live && !x.liveSince)).toBe(true);
  });

  it('serves playback only for known, enabled playback ids', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/live/zzzzzzzzzzzz/index.m3u8' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    await op.req('PATCH', `/api/streams/${streamId}`, { playbackEnabled: false });
    await new Promise((r) => setTimeout(r, 5100)); // playback lookups are cached for 5 seconds
    expect((await ctx.app.inject({ method: 'GET', url: `/live/${pid}/index.m3u8` })).statusCode).toBe(404);
  });

  it('only lets admins delete streams', async () => {
    expect((await op.req('DELETE', `/api/streams/${streamId}`)).statusCode).toBe(403);
  });
});
