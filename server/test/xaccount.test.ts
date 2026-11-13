import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, addUser, loginWithEnrolment, setup } from './helpers.js';
import { startFakePlatforms } from './fakePlatforms.js';
import { decrypt } from '../src/lib/crypto.js';
import { presets } from '../src/media/platforms.js';

describe('X as a connected account', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let admin: Client;
  let op: Client;
  let fake: Awaited<ReturnType<typeof startFakePlatforms>>;
  let streamId = '';
  let accountId = '';
  let destId = '';
  const destRow = async () => (await ctx.sql<{ remote_url_enc: string | null; remote_id: string | null; remote_stream_id: string | null; watch_url: string | null; prepare_error: string | null }[]>`
    SELECT remote_url_enc, remote_id, remote_stream_id, watch_url, prepare_error FROM destinations WHERE id = ${destId}`)[0];
  /** Clears the provisioner's back-off so the next tick tries again at once. */
  const tick = async () => { (ctx.app.provisioner as unknown as { retryAt: Map<string, number> }).retryAt.clear(); await ctx.app.provisioner.tick(); };

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
    await op.req('PATCH', `/api/streams/${streamId}`, { title: 'Zondagdienst', autoRecord: false });
  });
  afterAll(async () => { await fake.close(); await ctx.app.close(); await ctx.sql.end(); });

  it('keeps the X source key between broadcasts', () => {
    expect(presets.x).toMatchObject({ keyPerBroadcast: false, maxHeight: 720, maxFps: 30, keyframeSeconds: 3, defaultMode: 'transcode' });
  });

  it('registers the X app and connects an account with PKCE', async () => {
    expect((await admin.req('PUT', '/api/accounts/apps/x', { clientId: 'x-client_ID', clientSecret: 'x-secret' })).statusCode).toBe(200);
    const apps = (await admin.get('/api/accounts/apps')).json();
    expect(apps.x).toMatchObject({ clientId: 'x-client_ID', clientSecretSet: true, redirectUri: 'https://stream.example.com/api/accounts/oauth/x/callback' });
    expect(apps.x.scopes).toEqual(['tweet.read', 'users.read', 'broadcast.read', 'broadcast.write', 'offline.access']);

    const start = await op.get('/api/accounts/oauth/x/start?popup=1');
    expect(start.statusCode).toBe(302);
    const loc = new URL(start.headers.location as string);
    expect(loc.pathname).toBe('/x-auth');
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('scope')).toContain('broadcast.write');
    const flow = start.cookies.find((c) => c.name === 'restream_oauth')!;
    const r = await ctx.app.inject({
      method: 'GET', url: `/api/accounts/oauth/x/callback?code=c0de&state=${loc.searchParams.get('state')}`, cookies: { restream_oauth: flow.value },
    });
    expect(r.headers.location).toBe('/oauth-done.html?connected=1&provider=x');
    const token = fake.find('POST', '/x/oauth2/token')[0];
    // Confidential client: credentials in HTTP Basic, never in the form.
    expect(token.auth).toBe(`Basic ${Buffer.from('x-client_ID:x-secret').toString('base64')}`);
    expect(token.body).toMatchObject({ code: 'c0de', grant_type: 'authorization_code', redirect_uri: 'https://stream.example.com/api/accounts/oauth/x/callback' });
    expect(token.body.code_verifier).toBeTruthy();
    expect(token.body.client_secret).toBeUndefined();

    const list = (await op.get('/api/accounts')).json();
    expect(list.apps.x.configured).toBe(true);
    const a = list.accounts.find((x: { provider: string }) => x.provider === 'x');
    expect(a).toMatchObject({ name: 'Kerk op X', handle: '@kerkx', status: 'ok' });
    accountId = a.id;
  });

  it('goes live on X once the video arrives and ends the broadcast on Stop', async () => {
    const add = await op.post(`/api/streams/${streamId}/destinations`, { name: 'X', platform: 'x', auth: 'account', accountId, mode: 'transcode', videoBitrate: 4000, maxHeight: 720, fps: 30 });
    expect(add.statusCode, add.body).toBe(200);
    destId = add.json().id;
    fake.calls.length = 0;
    fake.live.xActive = false;

    await op.post(`/api/destinations/${destId}/live`, { live: true });
    await tick();
    let row = await destRow();
    expect(decrypt(row.remote_url_enc!)).toBe('rtmps://va.pscp.tv:443/x/x-key-1');
    expect(row).toMatchObject({ remote_stream_id: '9100000000000000001', remote_id: null, watch_url: null });
    expect(fake.find('POST', '/x/sources')[0].body).toEqual({ name: 'Restream · X', region: 'us-east-1' });

    // No video on the source yet: Restream waits instead of creating a broadcast that X would time out.
    await tick();
    expect(fake.find('POST', '/x/broadcasts')).toHaveLength(0);
    expect((await destRow()).prepare_error).toBeNull();

    fake.live.xActive = true;
    await tick();
    row = await destRow();
    expect(fake.find('POST', '/x/broadcasts')[0].body).toEqual({ source_id: '9100000000000000001', title: 'Zondagdienst' });
    expect(row.remote_id).toMatch(/^1Xb/);
    expect(row.watch_url).toBe(`https://x.com/i/broadcasts/${row.remote_id}`);
    const view = (await op.get('/api/streams')).json().streams[0].destinations[0];
    expect(view).toMatchObject({ platform: 'x', auth: 'account', watchUrl: row.watch_url, prepareError: null });
    expect(JSON.stringify(view)).not.toContain('x-key-1');

    await op.post(`/api/destinations/${destId}/live`, { live: false });
    await tick();
    expect(fake.find('PUT', `/x/broadcasts/${row.remote_id}/state`)[0].body).toEqual({ state: 'END' });
    expect(await destRow()).toMatchObject({ remote_url_enc: null, remote_id: null, watch_url: null, remote_stream_id: '9100000000000000001' });
  });

  it('reuses the source next time and explains when X refuses the account', async () => {
    fake.calls.length = 0;
    fake.live.xActive = true;
    fake.live.xEligible = false;
    await op.post(`/api/destinations/${destId}/live`, { live: true });
    await tick();
    expect(fake.find('POST', '/x/sources')).toHaveLength(0);
    expect(fake.find('GET', '/x/sources/9100000000000000001/stream_key')).toHaveLength(1);
    await tick();
    expect((await destRow()).prepare_error).toBe('x_not_eligible');
    expect((await op.get('/api/streams')).json().streams[0].destinations[0].prepareError).toBe('x_not_eligible');

    fake.live.xEligible = true;
    await tick();
    expect(await destRow()).toMatchObject({ prepare_error: null, watch_url: expect.stringMatching(/^https:\/\/x\.com\/i\/broadcasts\//) });
    await op.post(`/api/destinations/${destId}/live`, { live: false });
    await tick();
  });

  it('refreshes the X token with Basic authentication and stores the rotated refresh token', async () => {
    await ctx.sql`UPDATE platform_accounts SET expires_at = now() WHERE id = ${accountId}`;
    fake.calls.length = 0;
    await op.post(`/api/destinations/${destId}/live`, { live: true });
    await tick();
    const refresh = fake.find('POST', '/x/oauth2/token')[0];
    expect(refresh.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'x-refresh-0' });
    expect(refresh.auth).toMatch(/^Basic /);
    const [a] = await ctx.sql<{ refresh_token_enc: string }[]>`SELECT refresh_token_enc FROM platform_accounts WHERE id = ${accountId}`;
    expect(decrypt(a.refresh_token_enc)).toMatch(/^x-refresh-\d+$/);
    expect(decrypt(a.refresh_token_enc)).not.toBe('x-refresh-0');
    await op.post(`/api/destinations/${destId}/live`, { live: false });
    await tick();
  });

  it('does not announce events on X', async () => {
    const startsAt = new Date(Date.now() + 86_400_000);
    const ev = await op.post('/api/events', { streamId, title: 'Kerst', startsAt: startsAt.toISOString(), destinationIds: [destId] });
    expect(ev.statusCode, ev.body).toBe(200);
    await tick();
    const [t] = await ctx.sql<{ status: string }[]>`SELECT status FROM event_targets WHERE destination_id = ${destId}`;
    expect(t.status).toBe('skipped');
  });
});
