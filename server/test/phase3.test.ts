import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { Client, addUser, loginWithEnrolment, setup } from './helpers.js';
import { startFakePlatforms } from './fakePlatforms.js';
import { createPlaybackToken, hostAllowed, normaliseDomain, verifyPlaybackToken } from '../src/lib/playback.js';
import { recordArgs } from '../src/media/ffmpeg.js';
import { recordingsDir } from '../src/lib/recordings.js';
import { decrypt } from '../src/lib/crypto.js';

describe('playback tokens and domains', () => {
  it('signs, expires and revokes tokens', () => {
    const t = createPlaybackToken('abcdefgh', 'secret-1', new Date(Date.now() + 60_000));
    expect(verifyPlaybackToken('abcdefgh', 'secret-1', t)).toBe(true);
    expect(verifyPlaybackToken('abcdefgx', 'secret-1', t)).toBe(false);
    expect(verifyPlaybackToken('abcdefgh', 'secret-2', t)).toBe(false); // revoked
    expect(verifyPlaybackToken('abcdefgh', 'secret-1', t, Date.now() + 120_000)).toBe(false); // expired
    const forever = createPlaybackToken('abcdefgh', 'secret-1', null);
    expect(forever.startsWith('0.')).toBe(true);
    expect(verifyPlaybackToken('abcdefgh', 'secret-1', forever, Date.now() + 1e12)).toBe(true);
    expect(verifyPlaybackToken('abcdefgh', 'secret-1', `${forever.slice(0, -1)}A`)).toBe(false);
  });

  it('normalises and matches domains', () => {
    expect(normaliseDomain('https://www.Example.com/page?x=1')).toBe('www.example.com');
    expect(normaliseDomain('*.example.com')).toBe('*.example.com');
    expect(normaliseDomain('example.com:8443')).toBe('example.com');
    expect(normaliseDomain('not a domain')).toBeNull();
    expect(normaliseDomain('*')).toBeNull();
    expect(hostAllowed('www.example.com', ['*.example.com'])).toBe(true);
    expect(hostAllowed('example.com', ['*.example.com'])).toBe(true);
    expect(hostAllowed('evil-example.com', ['*.example.com'])).toBe(false);
    expect(hostAllowed('example.com.evil.io', ['example.com'])).toBe(false);
  });

  it('records the ingest into a fragmented MP4', () => {
    const a = recordArgs('rtsp://127.0.0.1:8554/live/k', { videoCodec: 'H265', audioCodec: 'MPEG-4 Audio' }, '/r/x.mp4').join(' ');
    expect(a).toContain('-c:v copy -tag:v hvc1 -c:a copy');
    expect(a).toContain('-movflags +frag_keyframe+empty_moov+default_base_moof');
    expect(recordArgs('i', { videoCodec: 'H264', audioCodec: 'G711' }, 'f').join(' ')).toContain('-c:a aac');
  });
});

describe('phase 3 API', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let admin: Client;
  let op: Client;
  let viewer: Client;
  let fake: Awaited<ReturnType<typeof startFakePlatforms>>;
  let streamId = '';
  let pid = '';

  beforeAll(async () => {
    ctx = await setup();
    fake = await startFakePlatforms();
    await addUser(ctx.sql, 'admin@example.com', 'correct horse battery', 'admin');
    await addUser(ctx.sql, 'op@example.com', 'correct horse battery', 'operator');
    await addUser(ctx.sql, 'view@example.com', 'correct horse battery', 'viewer');
    admin = new Client(ctx.app); op = new Client(ctx.app); viewer = new Client(ctx.app);
    await loginWithEnrolment(admin, 'admin@example.com', 'correct horse battery');
    await loginWithEnrolment(op, 'op@example.com', 'correct horse battery');
    await loginWithEnrolment(viewer, 'view@example.com', 'correct horse battery');
    await admin.req('PUT', '/api/settings', { publicUrl: 'https://stream.example.com' });
    streamId = (await op.post('/api/streams', { name: 'Kerkdienst' })).json().id;
    pid = (await op.get('/api/streams')).json().streams[0].playbackId;
  });
  afterAll(async () => { await fake.close(); await ctx.app.close(); await ctx.sql.end(); });

  const get = (url: string, headers: Record<string, string> = {}) => ctx.app.inject({ method: 'GET', url, headers });

  describe('embed player and playback access', () => {
    it('embeds anywhere by default', async () => {
      const s = (await op.get('/api/streams')).json().streams[0];
      expect(s.playback.embed).toBe(`https://stream.example.com/embed/${pid}`);
      const r = await get(`/embed/${pid}`, { referer: 'https://anything.example.org/' });
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-security-policy']).toContain('frame-ancestors *');
      expect(r.headers['x-frame-options']).toBeUndefined();
      const cfg = JSON.parse(/name="restream-embed" content="([^"]+)"/.exec(r.body)![1].replace(/&quot;/g, '"'));
      expect(cfg).toMatchObject({ state: 'ok', mediaBase: `/live/${pid}/`, title: 'Kerkdienst', reloadAt: 0 });
      expect((await get('/embed/zzzzzzzzzzzz')).statusCode).toBe(404);
    });

    it('limits embedding and playback to allowed domains', async () => {
      const bad = await op.req('PATCH', `/api/streams/${streamId}`, { allowedDomains: ['example.com', 'no way'] });
      expect(bad.json()).toMatchObject({ error: 'invalid_domain', detail: 'no way' });
      expect((await op.req('PATCH', `/api/streams/${streamId}`, { allowedDomains: ['https://www.kerk.nl/live', '*.example.com', ''] })).statusCode).toBe(200);
      expect((await op.get('/api/streams')).json().streams[0].allowedDomains).toEqual(['www.kerk.nl', '*.example.com']);

      const ok = await get(`/embed/${pid}`, { referer: 'https://www.kerk.nl/live', 'sec-fetch-dest': 'iframe' });
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['content-security-policy']).toContain("frame-ancestors 'self' www.kerk.nl *.example.com");
      const cfg = JSON.parse(/content="([^"]+)"><\/head>/.exec(ok.body)![1].replace(/&quot;/g, '"'));
      expect(cfg.mediaBase).toMatch(new RegExp(`^/live/${pid}~[0-9a-z]+\\.[A-Za-z0-9_-]{22}/$`));
      expect(cfg.reloadAt).toBeGreaterThan(Date.now());

      expect((await get(`/embed/${pid}`, { referer: 'https://evil.io/' })).statusCode).toBe(403);
      expect((await get(`/embed/${pid}`, { 'sec-fetch-dest': 'document' })).statusCode).toBe(403);
      expect((await get(`/embed/${pid}`, { 'sec-fetch-dest': 'iframe' })).statusCode).toBe(200); // no referer sent: the browser enforces frame-ancestors

      // Direct hotlinks: only from allowed sites, or with the embed's token. MediaMTX is not running in tests (502 = let through).
      expect((await get(`/live/${pid}/index.m3u8`)).statusCode).toBe(403);
      expect((await get(`/live/${pid}/index.m3u8`, { origin: 'https://evil.io' })).statusCode).toBe(403);
      const fromSite = await get(`/live/${pid}/index.m3u8`, { origin: 'https://cdn.example.com' });
      expect(fromSite.statusCode).toBe(502);
      expect(fromSite.headers['access-control-allow-origin']).toBe('https://cdn.example.com');
      expect((await get(`${cfg.mediaBase}index.m3u8`)).statusCode).toBe(502);
      expect((await get(`/live/${pid}~0.AAAAAAAAAAAAAAAAAAAAAA/index.m3u8`)).statusCode).toBe(403);
    });

    it('requires a token when asked and revokes tokens', async () => {
      await op.req('PATCH', `/api/streams/${streamId}`, { allowedDomains: [], requireToken: true });
      expect((await get(`/embed/${pid}`)).statusCode).toBe(403);
      expect((await get(`/live/${pid}/index.m3u8`, { origin: 'https://www.kerk.nl' })).statusCode).toBe(403);
      expect((await viewer.post(`/api/streams/${streamId}/playback-token`, { days: 7 })).statusCode).toBe(403);
      const tok = (await op.post(`/api/streams/${streamId}/playback-token`, { days: 7 })).json();
      expect(tok.embed).toBe(`https://stream.example.com/embed/${pid}?token=${tok.token}`);
      expect(new Date(tok.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
      expect((await get(`/embed/${pid}?token=${tok.token}`)).statusCode).toBe(200);
      expect((await get(new URL(tok.hls).pathname)).statusCode).toBe(502);
      expect((await op.post(`/api/streams/${streamId}/revoke-tokens`)).statusCode).toBe(200);
      expect((await get(`/embed/${pid}?token=${tok.token}`)).statusCode).toBe(403);
      expect((await get(new URL(tok.hls).pathname)).statusCode).toBe(403);
      await op.req('PATCH', `/api/streams/${streamId}`, { requireToken: false });
      expect((await get(`/live/${pid}/index.m3u8`)).statusCode).toBe(502);
    });
  });

  describe('recordings', () => {
    it('starts and stops recording on request and with Go live', async () => {
      expect((await viewer.post(`/api/streams/${streamId}/record`, { record: true })).statusCode).toBe(403);
      expect((await op.post(`/api/streams/${streamId}/record`, { record: true })).statusCode).toBe(200);
      let s = (await op.get('/api/streams')).json().streams[0];
      expect(s.record).toBe(true);
      expect(s.recording.state).toBe('off'); // the media engine is off in tests
      await op.post(`/api/streams/${streamId}/record`, { record: false });
      await op.req('PATCH', `/api/streams/${streamId}`, { autoRecord: true });
      await op.post(`/api/streams/${streamId}/live`, { live: true });
      expect((await op.get('/api/streams')).json().streams[0].record).toBe(true);
      await op.post(`/api/streams/${streamId}/live`, { live: false });
      s = (await op.get('/api/streams')).json().streams[0];
      expect(s).toMatchObject({ record: false, autoRecord: true });
    });

    it('lists, streams with ranges, downloads and deletes recordings', async () => {
      mkdirSync(recordingsDir(), { recursive: true });
      const file = '2026-11-12-test.mp4';
      writeFileSync(path.join(recordingsDir(), file), Buffer.from('0123456789'));
      const [r] = await ctx.sql<{ id: string }[]>`
        INSERT INTO recordings (stream_id, stream_name, title, file, status, size_bytes, duration_seconds, started_at, ended_at)
        VALUES (${streamId}, 'Kerkdienst', 'Zondag "ochtend"', ${file}, 'finished', 10, 3600, '2026-11-08T09:30:00Z', '2026-11-08T10:30:00Z') RETURNING id`;
      const list = (await viewer.get('/api/recordings')).json();
      expect(list.recordings[0]).toMatchObject({ id: r.id, title: 'Zondag "ochtend"', sizeBytes: 10, durationSeconds: 3600, fileName: 'Zondag ochtend 2026-11-08 09h30.mp4' });
      expect(list.disk.freeBytes).toBeGreaterThan(0);

      const part = await viewer.req('GET', `/api/recordings/${r.id}/file`, undefined, { range: 'bytes=2-5' });
      expect(part.statusCode).toBe(206);
      expect(part.body).toBe('2345');
      expect(part.headers['content-range']).toBe('bytes 2-5/10');
      const tail = await viewer.req('GET', `/api/recordings/${r.id}/file`, undefined, { range: 'bytes=-3' });
      expect(tail.body).toBe('789');
      const dl = await viewer.get(`/api/recordings/${r.id}/file?download=1`);
      expect(dl.statusCode).toBe(200);
      expect(dl.body).toBe('0123456789');
      expect(dl.headers['content-disposition']).toContain('attachment');
      expect(dl.headers['content-disposition']).toContain("filename*=UTF-8''Zondag%20ochtend");
      expect((await ctx.app.inject({ method: 'GET', url: `/api/recordings/${r.id}/file` })).statusCode).toBe(401);

      expect((await viewer.req('DELETE', `/api/recordings/${r.id}`)).statusCode).toBe(403);
      expect((await op.req('PATCH', `/api/recordings/${r.id}`, { title: 'Zondag' })).statusCode).toBe(200);
      expect((await op.req('DELETE', `/api/recordings/${r.id}`)).statusCode).toBe(200);
      expect(existsSync(path.join(recordingsDir(), file))).toBe(false);
      expect((await admin.req('PUT', '/api/recordings/settings', { retentionDays: 90 })).statusCode).toBe(200);
      expect((await viewer.get('/api/recordings')).json().retentionDays).toBe(90);
    });
  });

  describe('connected accounts', () => {
    async function connect(provider: string) {
      const start = await op.get(`/api/accounts/oauth/${provider}/start`);
      expect(start.statusCode, start.body).toBe(302);
      const loc = new URL(start.headers.location as string);
      const flow = start.cookies.find((c) => c.name === 'restream_oauth')!;
      expect(flow.sameSite).toBe('Lax');
      // The platform redirects back without the (SameSite=Strict) session cookie.
      return ctx.app.inject({
        method: 'GET', url: `/api/accounts/oauth/${provider}/callback?code=c0de&state=${loc.searchParams.get('state')}`,
        cookies: { restream_oauth: flow.value },
      }).then((r) => ({ r, loc }));
    }

    it('needs the OAuth app first', async () => {
      const r = await op.get('/api/accounts/oauth/youtube/start');
      expect(r.headers.location).toBe('/accounts?error=app_not_configured');
      expect((await op.req('PUT', '/api/accounts/apps/youtube', { clientId: 'x' })).statusCode).toBe(403);
      for (const p of ['youtube', 'facebook', 'twitch']) {
        expect((await admin.req('PUT', `/api/accounts/apps/${p}`, { clientId: `${p}-client`, clientSecret: `${p}-secret` })).statusCode).toBe(200);
      }
      const apps = (await admin.get('/api/accounts/apps')).json();
      expect(apps.youtube).toEqual({ clientId: 'youtube-client', clientSecretSet: true, redirectUri: 'https://stream.example.com/api/accounts/oauth/youtube/callback' });
      expect(JSON.stringify(apps)).not.toContain('youtube-secret');
    });

    it('connects YouTube, Facebook pages and Twitch', async () => {
      const yt = await connect('youtube');
      expect(yt.loc.searchParams.get('code_challenge_method')).toBe('S256');
      expect(yt.loc.searchParams.get('access_type')).toBe('offline');
      expect(yt.r.headers.location).toBe('/accounts?connected=1');
      const tokenCall = fake.find('POST', '/google/token')[0];
      expect(tokenCall.body).toMatchObject({ code: 'c0de', client_secret: 'youtube-secret', redirect_uri: 'https://stream.example.com/api/accounts/oauth/youtube/callback' });
      expect(tokenCall.body.code_verifier).toBeTruthy();
      expect((await connect('facebook')).r.headers.location).toBe('/accounts?connected=2');
      expect((await connect('twitch')).r.headers.location).toBe('/accounts?connected=1');

      const list = (await viewer.get('/api/accounts')).json();
      expect(list.accounts.map((a: { provider: string; name: string }) => `${a.provider}:${a.name}`))
        .toEqual(['facebook:Kerk Pagina', 'facebook:Tweede', 'twitch:KerkTV', 'youtube:Kerk TV']);
      expect(JSON.stringify(list)).not.toMatch(/yt-access|page-token|tw-access|refresh/);
      const [row] = await ctx.sql<{ refresh_token_enc: string }[]>`SELECT refresh_token_enc FROM platform_accounts WHERE provider = 'youtube'`;
      expect(decrypt(row.refresh_token_enc)).toBe('yt-refresh');
    });

    it('refuses a callback without a valid flow', async () => {
      const r = await ctx.app.inject({ method: 'GET', url: '/api/accounts/oauth/youtube/callback?code=x&state=y' });
      expect(r.headers.location).toBe('/accounts?error=oauth_failed');
      const start = await op.get('/api/accounts/oauth/youtube/start');
      const flow = start.cookies.find((c) => c.name === 'restream_oauth')!;
      const wrongState = await ctx.app.inject({ method: 'GET', url: '/api/accounts/oauth/youtube/callback?code=x&state=nope', cookies: { restream_oauth: flow.value } });
      expect(wrongState.headers.location).toBe('/accounts?error=oauth_failed');
      const denied = await ctx.app.inject({
        method: 'GET', url: `/api/accounts/oauth/youtube/callback?error=access_denied&state=${new URL(start.headers.location as string).searchParams.get('state')}`,
        cookies: { restream_oauth: flow.value },
      });
      expect(denied.headers.location).toBe('/accounts?error=oauth_denied');
    });
  });

  describe('going live on connected accounts', () => {
    const accounts: Record<string, string> = {};
    const dests: Record<string, string> = {};
    const destRow = async (id: string) => (await ctx.sql<{ remote_url_enc: string | null; remote_id: string | null; remote_stream_id: string | null; watch_url: string | null; prepare_error: string | null }[]>`
      SELECT remote_url_enc, remote_id, remote_stream_id, watch_url, prepare_error FROM destinations WHERE id = ${id}`)[0];

    beforeAll(async () => {
      for (const a of (await op.get('/api/accounts')).json().accounts) accounts[`${a.provider}:${a.name}`] = a.id;
      const add = async (name: string, platform: string, accountId: string, extra = {}) => {
        const r = await op.post(`/api/streams/${streamId}/destinations`, { name, platform, auth: 'account', accountId, ...extra });
        expect(r.statusCode, r.body).toBe(200);
        return r.json().id as string;
      };
      expect((await op.post(`/api/streams/${streamId}/destinations`, { name: 'x', platform: 'youtube', auth: 'account', accountId: accounts['twitch:KerkTV'] })).json().error).toBe('account_required');
      expect((await op.post(`/api/streams/${streamId}/destinations`, { name: 'x', platform: 'rtmp', serverUrl: 'rtmp://h/app', auth: 'account', accountId: accounts['twitch:KerkTV'] })).json().error).toBe('account_not_supported');
      dests.yt = await add('YouTube', 'youtube', accounts['youtube:Kerk TV'], { privacy: 'unlisted' });
      dests.fb = await add('Facebook', 'facebook', accounts['facebook:Kerk Pagina']);
      dests.tw = await add('Twitch', 'twitch', accounts['twitch:KerkTV']);
      await op.req('PATCH', `/api/streams/${streamId}`, { title: 'Zondagdienst', description: 'Live vanuit de kerk', autoRecord: false });
    });

    it('creates broadcasts on Go live and ends them on Stop', async () => {
      fake.calls.length = 0;
      await op.post(`/api/streams/${streamId}/live`, { live: true });
      await ctx.app.provisioner.tick();
      const yt = await destRow(dests.yt);
      expect(decrypt(yt.remote_url_enc!)).toBe('rtmps://a.rtmps.youtube.com/live2/yt-key-1');
      expect(yt).toMatchObject({ remote_stream_id: 'ls-1', prepare_error: null });
      expect(yt.watch_url).toBe(`https://www.youtube.com/watch?v=${yt.remote_id}`);
      const insert = fake.find('POST', '/youtube/liveBroadcasts')[0];
      expect(insert.body).toMatchObject({ snippet: { title: 'Zondagdienst', description: 'Live vanuit de kerk' }, status: { privacyStatus: 'unlisted' }, contentDetails: { enableAutoStart: true, enableAutoStop: true } });
      expect(fake.find('POST', '/youtube/liveBroadcasts/bind')[0].query).toMatchObject({ id: yt.remote_id, streamId: 'ls-1' });

      const fb = await destRow(dests.fb);
      expect(decrypt(fb.remote_url_enc!)).toMatch(/^rtmps:\/\/live-api-s\.facebook\.com:443\/rtmp\/FB-/);
      expect(fake.find('POST', '/graph/page-1/live_videos')[0]).toMatchObject({ auth: 'Bearer page-token-1', body: { status: 'LIVE_NOW', title: 'Zondagdienst' } });
      const tw = await destRow(dests.tw);
      expect(decrypt(tw.remote_url_enc!)).toBe('rtmps://live.twitch.tv/app/live_tw_key');
      expect(tw.watch_url).toBe('https://www.twitch.tv/kerktv');

      const view = (await viewer.get('/api/streams')).json().streams[0].destinations.find((d: { id: string }) => d.id === dests.yt);
      expect(view).toMatchObject({ auth: 'account', account: { name: 'Kerk TV' }, privacy: 'unlisted', watchUrl: yt.watch_url });
      expect(JSON.stringify(view)).not.toContain('yt-key-1');

      await op.post(`/api/streams/${streamId}/live`, { live: false });
      await ctx.app.provisioner.tick();
      expect(fake.find('POST', '/youtube/liveBroadcasts/transition')[0].query).toMatchObject({ id: yt.remote_id, broadcastStatus: 'complete' });
      expect(fake.calls.some((c) => c.path === `/graph/${fb.remote_id}` && c.body.end_live_video === 'true')).toBe(true);
      for (const id of Object.values(dests)) expect(await destRow(id)).toMatchObject({ remote_url_enc: null, remote_id: null, watch_url: null });
      // The reusable YouTube stream is kept for the next broadcast.
      expect((await destRow(dests.yt)).remote_stream_id).toBe('ls-1');
    });

    it('shows a platform error and keeps retrying', async () => {
      fake.fail.add('POST /youtube/liveBroadcasts');
      await op.post(`/api/destinations/${dests.yt}/live`, { live: true });
      await ctx.app.provisioner.tick();
      expect((await destRow(dests.yt)).prepare_error).toContain('forbidden by test');
      fake.fail.clear();
      await op.post(`/api/destinations/${dests.yt}/live`, { live: false });
      await ctx.app.provisioner.tick();
    });

    it('cannot remove an account that is live', async () => {
      await op.post(`/api/destinations/${dests.tw}/live`, { live: true });
      expect((await op.req('DELETE', `/api/accounts/${accounts['twitch:KerkTV']}`)).json().error).toBe('account_in_use');
      await op.post(`/api/destinations/${dests.tw}/live`, { live: false });
      await ctx.app.provisioner.tick();
    });

    describe('scheduled events', () => {
      let eventId = '';
      const startsAt = new Date(Date.now() + 3 * 86_400_000);
      const endsAt = new Date(startsAt.getTime() + 90 * 60_000);

      it('announces an event on the platforms', async () => {
        const keyDest = (await op.post(`/api/streams/${streamId}/destinations`, { name: 'Eigen', platform: 'rtmp', serverUrl: 'rtmp://studio/app', streamKey: 'k' })).json().id;
        dests.key = keyDest;
        expect((await op.post('/api/events', { streamId, title: 'x', startsAt: new Date(Date.now() - 3600_000).toISOString() })).json().error).toBe('event_in_past');
        expect((await op.post('/api/events', { streamId, title: 'x', startsAt: startsAt.toISOString(), endsAt: startsAt.toISOString() })).json().error).toBe('event_end_before_start');
        const r = await op.post('/api/events', {
          streamId, title: 'Kerstnachtdienst', description: 'Met koor', startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(),
          record: true, privacy: 'public', destinationIds: [dests.yt, dests.fb, dests.tw, keyDest],
        });
        expect(r.statusCode, r.body).toBe(200);
        eventId = r.json().id;
        fake.calls.length = 0;
        await ctx.app.provisioner.tick();
        const ev = (await viewer.get('/api/events')).json().find((e: { id: string }) => e.id === eventId);
        const byName = Object.fromEntries(ev.targets.map((t: { name: string }) => [t.name, t]));
        expect(byName.YouTube).toMatchObject({ status: 'registered', viaAccount: true });
        expect(byName.YouTube.watchUrl).toMatch(/^https:\/\/www\.youtube\.com\/watch\?v=bc-/);
        expect(byName.Facebook).toMatchObject({ status: 'registered', watchUrl: expect.stringContaining('https://www.facebook.com/kerk/videos/lv-') });
        expect(byName.Twitch).toMatchObject({ status: 'registered', watchUrl: 'https://www.twitch.tv/kerktv/schedule' });
        expect(byName.Eigen).toMatchObject({ status: 'skipped' });
        expect(fake.find('POST', '/youtube/liveBroadcasts')[0].body).toMatchObject({ snippet: { title: 'Kerstnachtdienst', scheduledStartTime: startsAt.toISOString(), scheduledEndTime: endsAt.toISOString() } });
        expect(fake.find('POST', '/graph/page-1/live_videos')[0].body).toMatchObject({ status: 'SCHEDULED_UNPUBLISHED', planned_start_time: String(Math.floor(startsAt.getTime() / 1000)) });
        expect(fake.find('POST', '/helix/schedule/segment')[0].body).toMatchObject({ title: 'Kerstnachtdienst', duration: '90', timezone: 'UTC' });
      });

      it('pushes changes and removed destinations to the platforms', async () => {
        fake.calls.length = 0;
        const r = await op.req('PUT', `/api/events/${eventId}`, {
          streamId, title: 'Kerstnachtdienst 2026', startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), record: true,
          destinationIds: [dests.yt, dests.fb, dests.key],
        });
        expect(r.statusCode, r.body).toBe(200);
        await ctx.app.provisioner.tick();
        expect(fake.find('PUT', '/youtube/liveBroadcasts')[0].body).toMatchObject({ snippet: { title: 'Kerstnachtdienst 2026' } });
        expect(fake.calls.some((c) => c.method === 'POST' && /^\/graph\/lv-/.test(c.path) && c.body.title === 'Kerstnachtdienst 2026')).toBe(true);
        expect(fake.find('DELETE', '/helix/schedule/segment')).toHaveLength(1);
        const ev = (await viewer.get('/api/events')).json().find((e: { id: string }) => e.id === eventId);
        expect(ev.targets.map((t: { name: string }) => t.name).sort()).toEqual(['Eigen', 'Facebook', 'YouTube']);
      });

      it('goes live at the start with the announced broadcasts and stops at the end', async () => {
        fake.calls.length = 0;
        await ctx.app.scheduler.tick(new Date(startsAt.getTime() + 1000));
        let ev = (await viewer.get('/api/events')).json().find((e: { id: string }) => e.id === eventId);
        expect(ev.status).toBe('live');
        const s = (await viewer.get('/api/streams')).json().streams[0];
        const live = Object.fromEntries(s.destinations.map((d: { name: string; live: boolean }) => [d.name, d.live]));
        expect(live).toMatchObject({ YouTube: true, Facebook: true, Eigen: true, Twitch: false });
        expect(s.record).toBe(true);

        await ctx.app.provisioner.tick();
        // No new YouTube broadcast: the announced one is bound to the reusable stream.
        expect(fake.find('POST', '/youtube/liveBroadcasts')).toHaveLength(0);
        const announced = ev.targets.find((t: { name: string }) => t.name === 'YouTube').watchUrl.split('v=')[1];
        expect(fake.find('POST', '/youtube/liveBroadcasts/bind')[0].query.id).toBe(announced);
        expect(fake.calls.some((c) => /^\/graph\/lv-/.test(c.path) && c.body.status === 'LIVE_NOW')).toBe(true);

        await ctx.app.scheduler.tick(new Date(endsAt.getTime() + 1000));
        ev = (await viewer.get('/api/events')).json().find((e: { id: string }) => e.id === eventId);
        expect(ev.status).toBe('ended');
        const after = (await viewer.get('/api/streams')).json().streams[0];
        expect(after.destinations.every((d: { live: boolean }) => !d.live)).toBe(true);
        expect(after.record).toBe(false);
        await ctx.app.provisioner.tick();
        expect(fake.find('POST', '/youtube/liveBroadcasts/transition')[0].query.id).toBe(announced);
      });

      it('cancels an event and removes it from the platforms', async () => {
        const r = await op.post('/api/events', {
          streamId, title: 'Afgelast', startsAt: startsAt.toISOString(), destinationIds: [dests.yt, dests.fb],
        });
        const id = r.json().id;
        await ctx.app.provisioner.tick();
        fake.calls.length = 0;
        expect((await op.post(`/api/events/${id}/cancel`)).statusCode).toBe(200);
        expect((await op.req('DELETE', `/api/events/${id}`)).json().error).toBe('event_cleanup_pending');
        await ctx.app.provisioner.tick();
        expect(fake.find('DELETE', '/youtube/liveBroadcasts')).toHaveLength(1);
        expect(fake.calls.some((c) => c.method === 'DELETE' && /^\/graph\/lv-/.test(c.path))).toBe(true);
        expect((await op.req('DELETE', `/api/events/${id}`)).statusCode).toBe(200);
        expect((await viewer.post(`/api/events/${eventId}/start`)).statusCode).toBe(403);
      });
    });
  });
});
