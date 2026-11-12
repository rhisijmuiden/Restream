import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { Client, addUser, loginWithEnrolment, setup } from './helpers.js';
import { startFakePlatforms } from './fakePlatforms.js';
import { encrypt } from '../src/lib/crypto.js';
import { endpoints } from '../src/platforms/api.js';
import { config } from '../src/config.js';
import { parseTwitchLine } from '../src/live/twitchChat.js';

const waitFor = async (fn: () => Promise<boolean> | boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('timed out');
};

/** A Twitch IRC stand-in: answers the anonymous login and lets the test send PRIVMSG lines. */
async function startFakeIrc() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const received: string[] = [];
  const clients = new Set<WsSocket>();
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('message', (data) => {
      for (const line of String(data).split('\r\n').filter(Boolean)) {
        received.push(line);
        const join = /^JOIN (#\S+)/.exec(line);
        if (join) ws.send(`:justinfan1!justinfan1@justinfan1.tmi.twitch.tv JOIN ${join[1]}\r\n:justinfan1.tmi.twitch.tv 366 justinfan1 ${join[1]} :End of /NAMES list\r\n`);
      }
    });
  });
  return {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    received,
    send: (line: string) => { for (const c of clients) c.send(`${line}\r\n`); },
    close: async () => { for (const c of clients) c.terminate(); await new Promise((r) => wss.close(r)); },
  };
}

describe('twitch chat lines', () => {
  it('parses tags, display names, /me and bits', () => {
    const m = parseTwitchLine('@badge-info=;bits=100;color=#FF0000;display-name=Jan\\sK;id=abc-1;tmi-sent-ts=1700000000000 :jank!jank@jank.tmi.twitch.tv PRIVMSG #kerktv :Amen!');
    expect(m).toEqual({ id: 'abc-1', author: 'Jan K', text: 'Amen!', at: new Date(1700000000000), highlight: '100 bits' });
    expect(parseTwitchLine(':piet!piet@piet.tmi.twitch.tv PRIVMSG #kerktv :\u0001ACTION zwaait\u0001')?.text).toBe('zwaait');
    expect(parseTwitchLine(':tmi.twitch.tv 001 justinfan1 :Welcome')).toBeNull();
    expect(parseTwitchLine('PING :tmi.twitch.tv')).toBeNull();
  });
});

describe('phase 4: live viewers, combined chat and broadcast statistics', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let admin: Client;
  let viewer: Client;
  let fake: Awaited<ReturnType<typeof startFakePlatforms>>;
  let irc: Awaited<ReturnType<typeof startFakeIrc>>;
  let streamId = '';
  const dest: Record<string, string> = {};
  const onAir = new Set<string>();

  beforeAll(async () => {
    ctx = await setup();
    fake = await startFakePlatforms();
    irc = await startFakeIrc();
    endpoints.twitchChat = irc.url;
    Object.assign(config.live, { youtubeChatMs: 100, facebookChatMs: 100 });
    await addUser(ctx.sql, 'admin@example.com', 'correct horse battery', 'admin');
    await addUser(ctx.sql, 'view@example.com', 'correct horse battery', 'viewer');
    admin = new Client(ctx.app); viewer = new Client(ctx.app);
    await loginWithEnrolment(admin, 'admin@example.com', 'correct horse battery');
    await loginWithEnrolment(viewer, 'view@example.com', 'correct horse battery');
    await admin.req('PUT', '/api/accounts/apps/twitch', { clientId: 'tw-client', clientSecret: 'tw-secret' });
    streamId = (await admin.post('/api/streams', { name: 'Kerkdienst' })).json().id;

    const acc = async (provider: string, ext: string, handle = '') => (await ctx.sql<{ id: string }[]>`
      INSERT INTO platform_accounts (provider, external_id, name, handle, access_token_enc, scopes)
      VALUES (${provider}, ${ext}, ${provider}, ${handle}, ${encrypt(`${provider}-token`)}, '') RETURNING id`)[0].id;
    const yt = await acc('youtube', 'UC1');
    const fb = await acc('facebook', 'page-1');
    const tw = await acc('twitch', 'tw-1', 'kerktv');
    const add = async (name: string, platform: string, accountId: string | null, remoteId: string | null) => (await ctx.sql<{ id: string }[]>`
      INSERT INTO destinations (stream_id, name, platform, server_url, auth, account_id, remote_id, live, watch_url)
      VALUES (${streamId}, ${name}, ${platform}, 'rtmp://x/app', ${accountId ? 'account' : 'key'}, ${accountId}, ${remoteId}, true, ${remoteId ? `https://watch/${remoteId}` : null})
      RETURNING id`)[0].id;
    dest.yt = await add('YouTube kanaal', 'youtube', yt, 'bc-9');
    dest.fb = await add('Facebook pagina', 'facebook', fb, 'lv-9');
    dest.tw = await add('Twitch', 'twitch', tw, null);
    dest.rtmp = await add('Eigen server', 'rtmp', null, null);
    ctx.app.live.onAir = (id) => onAir.has(id);
  });
  afterAll(async () => {
    await ctx.app.close(); await fake.close(); await irc.close(); await ctx.sql.end();
  });

  const tick = async () => { ctx.app.live.sampleSoon(); await ctx.app.live.tick(); };
  const liveView = async (after?: number) => (await viewer.get(`/api/streams/${streamId}/live${after !== undefined ? `?after=${after}` : ''}`)).json();

  it('has no broadcast while nothing is on air', async () => {
    await tick();
    const v = await liveView();
    expect(v.broadcast).toBeNull();
    expect(v.destinations).toHaveLength(4);
    expect(v.destinations.every((d: { onAir: boolean }) => !d.onAir)).toBe(true);
  });

  it('opens a broadcast and reads viewers per platform', async () => {
    fake.live.viewers.set('bc-9', 120);
    fake.live.viewers.set('lv-9', 30);
    fake.live.viewers.set('tw:tw-1', 7);
    for (const id of Object.values(dest)) onAir.add(id);
    await tick();
    const v = await liveView();
    expect(v.broadcast).toMatchObject({ title: 'Kerkdienst', live: true, peakViewers: 157, currentViewers: 157 });
    expect(v.totalViewers).toBe(157);
    const by = Object.fromEntries(v.destinations.map((d: { destinationId: string }) => [d.destinationId, d]));
    expect(by[dest.yt]).toMatchObject({ onAir: true, supported: true, viewers: 120 });
    expect(by[dest.fb]).toMatchObject({ supported: true, viewers: 30 });
    expect(by[dest.tw]).toMatchObject({ supported: true, viewers: 7 });
    expect(by[dest.rtmp]).toMatchObject({ onAir: true, supported: false, viewers: null, chat: 'unsupported' });
    expect(fake.find('GET', '/helix/streams')[0].query.user_id).toBe('tw-1');
  });

  it('combines YouTube, Facebook and Twitch chat in one list', async () => {
    fake.live.ytChat.push(
      { id: 'yt-m1', snippet: { type: 'textMessageEvent', publishedAt: new Date().toISOString(), displayMessage: 'Goedemorgen!' }, authorDetails: { displayName: 'Anna' } },
      { id: 'yt-m2', snippet: { type: 'superChatEvent', publishedAt: new Date().toISOString(), displayMessage: 'Dank!', superChatDetails: { amountDisplayString: '€5.00' } }, authorDetails: { displayName: 'Bram' } },
      { id: 'yt-gone', snippet: { type: 'messageDeletedEvent', publishedAt: new Date().toISOString() }, authorDetails: { displayName: 'Mod' } },
    );
    fake.live.fbComments.set('lv-9', [{ id: 'fb-c1', message: 'Mooi zo', created_time: new Date().toISOString(), from: { name: 'Carla' } }]);
    await waitFor(() => irc.received.some((l) => l === 'JOIN #kerktv'));
    await waitFor(async () => (await liveView()).destinations.find((d: { destinationId: string }) => d.destinationId === dest.tw).chat === 'on' || (await ctx.app.live.tick(), false));
    irc.send('@display-name=Daan;id=tw-m1;tmi-sent-ts=1700000000000 :daan!daan@daan.tmi.twitch.tv PRIVMSG #kerktv :Hallo vanaf Twitch');
    await waitFor(async () => { await ctx.app.live.flush(); return (await liveView()).chat.length >= 4; });
    const v = await liveView();
    const texts = v.chat.map((m: { platform: string; author: string; text: string; highlight: string | null }) => `${m.platform}:${m.author}:${m.text}:${m.highlight ?? ''}`);
    expect(texts).toEqual(expect.arrayContaining([
      'youtube:Anna:Goedemorgen!:', 'youtube:Bram:Dank!:€5.00', 'facebook:Carla:Mooi zo:', 'twitch:Daan:Hallo vanaf Twitch:',
    ]));
    expect(texts.some((t: string) => t.includes('Mod'))).toBe(false);
    expect(v.chat[0].destination).toBeTruthy();
    // Facebook is polled again: the same comment is stored once; only newer messages come after the cursor.
    fake.live.fbComments.get('lv-9')!.push({ id: 'fb-c2', message: 'Tweede', created_time: new Date().toISOString(), from: { name: 'Carla' } });
    await waitFor(async () => { await ctx.app.live.flush(); return (await liveView(v.cursor)).chat.length > 0; }, 8000);
    const next = await liveView(v.cursor);
    expect(next.chat.map((m: { text: string }) => m.text)).toEqual(['Tweede']);
    const [{ n }] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM chat_messages WHERE external_id = 'fb-c1'`;
    expect(n).toBe(1);
    // The YouTube poll uses the chat id from the broadcast and keeps its page token.
    const polls = fake.find('GET', '/youtube/liveChat/messages');
    expect(polls[0].query).toMatchObject({ liveChatId: 'chat-bc-9', part: 'snippet,authorDetails' });
    expect(polls[0].auth).toBe('Bearer youtube-token');
  });

  it('keeps samples and computes peak and average', async () => {
    fake.live.viewers.set('bc-9', 200);
    fake.live.viewers.set('lv-9', 50);
    fake.live.viewers.set('tw:tw-1', 10);
    await tick();
    const b = (await viewer.get('/api/broadcasts')).json().broadcasts[0];
    expect(b).toMatchObject({ live: true, peakViewers: 260, avgViewers: Math.round((157 + 260) / 2), currentViewers: 260 });
  });

  it('keeps the broadcast open through a short drop and closes it on Stop', async () => {
    onAir.clear();
    await tick();
    expect((await liveView()).broadcast).not.toBeNull(); // still set to live: a reconnect continues the broadcast
    await ctx.sql`UPDATE destinations SET live = false`;
    await tick();
    expect((await liveView()).broadcast).toBeNull();
    const list = (await viewer.get('/api/broadcasts')).json().broadcasts;
    expect(list).toHaveLength(1);
    const b = list[0];
    expect(b).toMatchObject({ live: false, peakViewers: 260, avgViewers: 209, chatMessages: 5 });
    expect(b.endedAt).toBeTruthy();
    const detail = (await viewer.get(`/api/broadcasts/${b.id}`)).json();
    expect(detail.series).toHaveLength(2);
    expect(detail.series.map((s: { total: number }) => s.total)).toEqual([157, 260]);
    const yt = detail.outputs.find((o: { platform: string }) => o.platform === 'youtube');
    expect(yt).toMatchObject({ name: 'YouTube kanaal', peakViewers: 200, avgViewers: 160, chatMessages: 2, stats: true, watchUrl: 'https://watch/bc-9' });
    expect(detail.outputs.find((o: { platform: string }) => o.platform === 'rtmp')).toMatchObject({ stats: false, peakViewers: 0 });
  });

  it('exports the chat and lets only admins delete a broadcast', async () => {
    const b = (await viewer.get('/api/broadcasts')).json().broadcasts[0];
    const chat = (await viewer.get(`/api/broadcasts/${b.id}/chat`)).json();
    expect(chat.messages).toHaveLength(5);
    const csv = await viewer.get(`/api/broadcasts/${b.id}/chat.csv`);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\r\n')[0]).toBe('﻿time,platform,destination,author,message,amount');
    expect(csv.body).toContain('"Bram","Dank!","€5.00"');
    expect((await viewer.req('DELETE', `/api/broadcasts/${b.id}`)).statusCode).toBe(403);
    expect((await admin.req('DELETE', `/api/broadcasts/${b.id}`)).statusCode).toBe(200);
    expect((await viewer.get('/api/broadcasts')).json().broadcasts).toHaveLength(0);
    const [{ n }] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM chat_messages`;
    expect(n).toBe(0);
  });

  it('flags Facebook accounts that still need the comments permission', async () => {
    const acc = (await viewer.get('/api/accounts')).json().accounts;
    expect(acc.find((a: { provider: string }) => a.provider === 'facebook').missingScopes).toContain('pages_read_user_content');
    expect(acc.find((a: { provider: string }) => a.provider === 'youtube').missingScopes).toEqual([]);
  });
});
