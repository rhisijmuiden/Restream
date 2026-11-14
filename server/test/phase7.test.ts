import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, addUser, loginWithEnrolment, setup } from './helpers.js';
import { startFakePlatforms } from './fakePlatforms.js';
import { decrypt } from '../src/lib/crypto.js';
import { linkedinRegion } from '../src/platforms/api.js';
import { presets, publishUrl, serverUrlProblem } from '../src/media/platforms.js';
import { ffmpegArgs } from '../src/media/ffmpeg.js';

describe('phase 7: more destinations and LinkedIn Live', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let admin: Client;
  let op: Client;
  let fake: Awaited<ReturnType<typeof startFakePlatforms>>;
  let streamId = '';
  let memberId = '';
  let pageId = '';
  let destId = '';
  const destRow = async () => (await ctx.sql<{ remote_url_enc: string | null; remote_id: string | null; remote_stream_id: string | null; watch_url: string | null; prepare_error: string | null }[]>`
    SELECT remote_url_enc, remote_id, remote_stream_id, watch_url, prepare_error FROM destinations WHERE id = ${destId}`)[0];
  /** Lets every back-off (including LinkedIn's ten seconds before ending) run out, then runs one pass. */
  const tick = async () => {
    const m = (ctx.app.provisioner as unknown as { retryAt: Map<string, number> }).retryAt;
    for (const k of m.keys()) m.set(k, 0);
    await ctx.app.provisioner.tick();
  };

  beforeAll(async () => {
    ctx = await setup();
    fake = await startFakePlatforms();
    await addUser(ctx.sql, 'admin@example.com', 'correct horse battery', 'admin');
    await addUser(ctx.sql, 'op@example.com', 'correct horse battery', 'operator');
    admin = new Client(ctx.app); op = new Client(ctx.app);
    await loginWithEnrolment(admin, 'admin@example.com', 'correct horse battery');
    await loginWithEnrolment(op, 'op@example.com', 'correct horse battery');
    await admin.req('PUT', '/api/settings', { publicUrl: 'https://stream.example.com' });
    streamId = (await op.post('/api/streams', { name: 'Kerkdienst' })).json().id;
    await op.req('PATCH', `/api/streams/${streamId}`, { title: 'Zondagdienst', description: 'Live vanuit de kerk', autoRecord: false });
  });
  afterAll(async () => { await fake.close(); await ctx.app.close(); await ctx.sql.end(); });

  it('has presets for the new platforms', () => {
    expect(presets.tiktok).toMatchObject({ orientation: 'portrait', defaultMode: 'transcode', keyPerBroadcast: true, serverRequired: true, maxKbps: 6000 });
    expect(presets.vimeo).toMatchObject({ server: 'rtmps://rtmp-global.cloud.vimeo.com:443/live', serverRequired: false });
    expect(presets.dailymotion).toMatchObject({ server: 'rtmp://publish.dailymotion.com/publish-dm', protocols: ['rtmp'] });
    expect(presets.rumble).toMatchObject({ maxKbps: 8000, audioSampleRate: 44100, keyframeSeconds: 2, defaultMode: 'transcode' });
    expect(presets.trovo.server).toBe('rtmp://livepush.trovo.live/live/');
    expect(presets.owncast).toMatchObject({ serverRequired: true, protocols: ['rtmp'] });
    expect(presets.peertube).toMatchObject({ serverRequired: true, protocols: ['rtmp', 'rtmps'] });

    expect(serverUrlProblem('owncast', '')).toBe('server_required');
    expect(serverUrlProblem('owncast', 'rtmps://owncast.example.com/live')).toBe('invalid_server_url');
    expect(serverUrlProblem('peertube', 'rtmps://peertube.example.com:1936/live')).toBeNull();
    expect(serverUrlProblem('dailymotion', 'rtmps://publish.dailymotion.com/publish-dm')).toBe('invalid_server_url');
    // Dailymotion's key carries an auth parameter; it is kept as it is.
    expect(publishUrl('dailymotion', presets.dailymotion.server, 'x1a2b3c?auth=x1cg_5883')).toBe('rtmp://publish.dailymotion.com/publish-dm/x1a2b3c?auth=x1cg_5883');
    expect(publishUrl('trovo', presets.trovo.server, 'trovo-key')).toBe('rtmp://livepush.trovo.live/live/trovo-key');
  });

  it('transcodes TikTok to portrait 9:16 at 44.1 kHz and Rumble at constant bitrate', () => {
    const base = { serverUrl: '', streamKey: 'k', passphrase: '', mode: 'transcode' as const, videoBitrate: 4500, audioBitrate: 128, maxHeight: 1080, fps: 30 };
    const src = { videoCodec: 'H264', audioCodec: 'MPEG-4 Audio' };
    const tt = ffmpegArgs('rtsp://127.0.0.1:8554/feed', { ...base, platform: 'tiktok', serverUrl: 'rtmp://push.tiktokcdn.com/game/', orientation: 'portrait' }, src).join(' ');
    expect(tt).toContain("crop='min(iw,ih*9/16)'");
    expect(tt).toContain('-ar 44100');
    const rb = ffmpegArgs('rtsp://127.0.0.1:8554/feed', { ...base, platform: 'rumble', serverUrl: presets.rumble.server, orientation: 'landscape', videoBitrate: 6000 }, src).join(' ');
    expect(rb).toContain('nal-hrd=cbr');
    expect(rb).toContain('-g 60');
  });

  it('adds destinations for every new platform with a stream key', async () => {
    const add = (body: Record<string, unknown>) => op.post(`/api/streams/${streamId}/destinations`, body);
    expect((await add({ name: 'TikTok', platform: 'tiktok', streamKey: 'tt-key' })).json().error).toBe('server_required');
    for (const body of [
      { name: 'TikTok', platform: 'tiktok', serverUrl: 'rtmp://push-rtmp-l11-va01.tiktokcdn.com/game/', streamKey: 'stream-123?expire=1&sign=abc', mode: 'transcode', orientation: 'portrait', fps: 30, videoBitrate: 4500 },
      { name: 'Vimeo', platform: 'vimeo', streamKey: 'vimeo-key' },
      { name: 'Dailymotion', platform: 'dailymotion', streamKey: 'x1a2b3c?auth=x1cg_588354' },
      { name: 'Rumble', platform: 'rumble', streamKey: 'rumble-key' },
      { name: 'Trovo', platform: 'trovo', streamKey: 'trovo-key' },
      { name: 'Owncast', platform: 'owncast', serverUrl: 'rtmp://owncast.example.com:1935/live', streamKey: 'owncast-admin-key' },
      { name: 'PeerTube', platform: 'peertube', serverUrl: 'rtmps://peertube.example.com:1936/live', streamKey: 'e0c1-uuid' },
    ]) {
      const r = await add(body);
      expect(r.statusCode, `${body.platform}: ${r.body}`).toBe(200);
    }
    // Only LinkedIn joins the platforms with a connected account.
    expect((await add({ name: 'Vimeo', platform: 'vimeo', auth: 'account', accountId: '00000000-0000-0000-0000-000000000000' })).json().error).toBe('account_not_supported');
    const d = (await op.get('/api/streams')).json().streams[0].destinations;
    expect(d.map((x: { platform: string }) => x.platform)).toEqual(['tiktok', 'vimeo', 'dailymotion', 'rumble', 'trovo', 'owncast', 'peertube']);
    expect(d.find((x: { platform: string }) => x.platform === 'vimeo').serverUrl).toBe('rtmps://rtmp-global.cloud.vimeo.com:443/live');
    expect(JSON.stringify(d)).not.toContain('owncast-admin-key');
    for (const x of d) await op.req('DELETE', `/api/destinations/${x.id}`);
  });

  it('connects a LinkedIn member and, separately, the company pages they administer', async () => {
    expect((await admin.req('PUT', '/api/accounts/apps/linkedin', { clientId: '86abcdef12', clientSecret: 'li-secret' })).statusCode).toBe(200);
    const apps = (await admin.get('/api/accounts/apps')).json();
    expect(apps.linkedin.redirectUri).toBe('https://stream.example.com/api/accounts/oauth/linkedin/callback');
    expect(apps.linkedin.scopes).toEqual(['openid', 'profile', 'r_member_live', 'w_member_live', 'r_organization_live', 'w_organization_live', 'r_organization_admin']);

    const connect = async (query: string) => {
      const start = await op.get(`/api/accounts/oauth/linkedin/start?popup=1${query}`);
      expect(start.statusCode).toBe(302);
      const loc = new URL(start.headers.location as string);
      const flow = start.cookies.find((c) => c.name === 'restream_oauth')!;
      const r = await ctx.app.inject({
        method: 'GET', url: `/api/accounts/oauth/linkedin/callback?code=li-code&state=${loc.searchParams.get('state')}`, cookies: { restream_oauth: flow.value },
      });
      return { loc, location: r.headers.location };
    };

    const member = await connect('');
    expect(member.loc.pathname).toBe('/li-auth/authorization');
    expect(member.loc.searchParams.get('scope')).toBe('openid profile r_member_live w_member_live');
    expect(member.location).toBe('/oauth-done.html?connected=1&provider=linkedin');
    expect(fake.find('POST', '/li-auth/accessToken')[0].body).toMatchObject({ grant_type: 'authorization_code', code: 'li-code', client_id: '86abcdef12', client_secret: 'li-secret' });

    const page = await connect('&target=organization');
    // Member and company-page permissions are never asked for together.
    expect(page.loc.searchParams.get('scope')).toBe('r_organization_live w_organization_live r_organization_admin');
    expect(page.location).toBe('/oauth-done.html?connected=2&provider=linkedin');

    const list = (await op.get('/api/accounts')).json().accounts.filter((a: { provider: string }) => a.provider === 'linkedin');
    expect(list.map((a: { name: string }) => a.name).sort()).toEqual(['Kerk BV', 'Reinder Kerk', 'Stichting Koor']);
    memberId = list.find((a: { name: string }) => a.name === 'Reinder Kerk').id;
    pageId = list.find((a: { name: string }) => a.name === 'Kerk BV').id;
    const [row] = await ctx.sql<{ external_id: string }[]>`SELECT external_id FROM platform_accounts WHERE id = ${pageId}`;
    expect(row.external_id).toBe('urn:li:organization:555');
  });

  it('goes live on a LinkedIn page: registers the live video, publishes the post once video arrives, ends it on Stop', async () => {
    const add = await op.post(`/api/streams/${streamId}/destinations`, { name: 'LinkedIn', platform: 'linkedin', auth: 'account', accountId: pageId, mode: 'transcode', videoBitrate: 5000, maxHeight: 1080, fps: 30 });
    expect(add.statusCode, add.body).toBe(200);
    destId = add.json().id;
    fake.calls.length = 0;
    fake.live.liStatus = 'NEW';

    await op.post(`/api/destinations/${destId}/live`, { live: true });
    await tick();
    const reg = fake.find('POST', '/li/liveAssetActions')[0];
    expect(reg.query.action).toBe('register');
    expect(reg.headers['x-restli-protocol-version']).toBe('2.0.0');
    expect(reg.body).toEqual({ registerLiveEventRequest: { owner: 'urn:li:organization:555', recipes: ['urn:li:digitalmediaRecipe:feedshare-live-video'], region: linkedinRegion() } });
    let row = await destRow();
    expect(decrypt(row.remote_url_enc!)).toMatch(/^rtmps:\/\/C4E\d+\.channel\.media\.azure\.net:2935\/live\/C4E\d+$/);
    expect(row).toMatchObject({ remote_stream_id: expect.stringMatching(/^urn:li:digitalmediaAsset:C4E\d+$/), remote_id: null });
    const asset = row.remote_stream_id!;

    // Not available yet: no post, no error.
    await tick();
    expect(fake.find('POST', '/li/ugcPosts')).toHaveLength(0);
    expect((await destRow()).prepare_error).toBeNull();

    fake.live.liStatus = 'AVAILABLE';
    await tick();
    const post = fake.find('POST', '/li/ugcPosts')[0];
    expect(post.body).toMatchObject({
      author: 'urn:li:organization:555', lifecycleState: 'PUBLISHED',
      specificContent: { 'com.linkedin.ugc.ShareContent': { shareMediaCategory: 'LIVE_VIDEO', media: [{ media: asset, status: 'READY' }], shareCommentary: { text: 'Zondagdienst\n\nLive vanuit de kerk' } } },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
    });
    row = await destRow();
    expect(row.remote_id).toMatch(/^urn:li:ugcPost:\d+$/);
    expect(row.watch_url).toBe(`https://www.linkedin.com/feed/update/${row.remote_id}`);

    // Title changes do not reach a running LinkedIn post.
    const info = await op.req('PUT', `/api/streams/${streamId}/broadcast-info`, { title: 'Nieuwe titel', description: '' });
    expect(info.statusCode, info.body).toBe(200);
    expect(info.json().results.find((r: { platform: string }) => r.platform === 'linkedin').result).toBe('unsupported');

    await op.post(`/api/destinations/${destId}/live`, { live: false });
    fake.calls.length = 0;
    await ctx.app.provisioner.tick();
    // LinkedIn asks to wait about ten seconds before ending, so nothing is sent at once.
    expect(fake.find('POST', '/li/liveAssetActions')).toHaveLength(0);
    await tick();
    const end = fake.find('POST', '/li/liveAssetActions')[0];
    expect(end.query.action).toBe('end');
    expect(end.body).toEqual({ asset });
    expect(await destRow()).toMatchObject({ remote_url_enc: null, remote_id: null, remote_stream_id: null, watch_url: null });
  });

  it('registers a new live video every time and explains when LinkedIn has not approved the app', async () => {
    fake.calls.length = 0;
    fake.live.liEligible = false;
    await op.req('PUT', `/api/destinations/${destId}`, { name: 'LinkedIn', platform: 'linkedin', auth: 'account', accountId: memberId, mode: 'transcode', videoBitrate: 5000, maxHeight: 1080, fps: 30, enabled: true });
    await op.post(`/api/destinations/${destId}/live`, { live: true });
    await tick();
    expect((await destRow()).prepare_error).toBe('linkedin_not_eligible');
    expect((await op.get('/api/streams')).json().streams[0].destinations[0].prepareError).toBe('linkedin_not_eligible');

    fake.live.liEligible = true;
    fake.live.liStatus = 'AVAILABLE';
    await tick();
    await tick();
    const regs = fake.find('POST', '/li/liveAssetActions').filter((c) => c.query.action === 'register');
    expect(regs.at(-1)!.body).toMatchObject({ registerLiveEventRequest: { owner: 'urn:li:person:abc123' } });
    expect(await destRow()).toMatchObject({ prepare_error: null, watch_url: expect.stringMatching(/^https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:ugcPost:/) });
    await op.post(`/api/destinations/${destId}/live`, { live: false });
    await tick(); await tick();
  });

  it('refreshes the LinkedIn token with the client secret', async () => {
    await ctx.sql`UPDATE platform_accounts SET expires_at = now() WHERE id = ${memberId}`;
    fake.calls.length = 0;
    const pre = await op.post(`/api/streams/${streamId}/preflight`);
    expect(pre.statusCode, pre.body).toBe(200);
    const refresh = fake.find('POST', '/li-auth/accessToken')[0];
    expect(refresh.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'li-refresh', client_id: '86abcdef12', client_secret: 'li-secret' });
    expect(fake.find('GET', '/li/userinfo')).toHaveLength(1);
  });

  it('does not announce events on LinkedIn', async () => {
    const startsAt = new Date(Date.now() + 86_400_000);
    const ev = await op.post('/api/events', { streamId, title: 'Kerst', startsAt: startsAt.toISOString(), destinationIds: [destId] });
    expect(ev.statusCode, ev.body).toBe(200);
    await tick();
    const [t] = await ctx.sql<{ status: string }[]>`SELECT status FROM event_targets WHERE destination_id = ${destId}`;
    expect(t.status).toBe('skipped');
  });
});
