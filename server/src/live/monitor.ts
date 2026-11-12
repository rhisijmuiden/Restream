import type { FastifyBaseLogger } from 'fastify';
import type { Sql } from '../db.js';
import { config } from '../config.js';
import { getSettings, type OAuthProvider } from '../lib/settings.js';
import {
  accessToken, endpoints, facebookLive, twitchLive, youtubeLive, type AccountRow, type ChatMessage,
} from '../platforms/api.js';
import type { MediaSupervisor } from '../media/supervisor.js';
import { closeBroadcast } from './stats.js';
import { TwitchChat } from './twitchChat.js';
import { bus } from '../lib/events.js';

export type ChatState = 'off' | 'connecting' | 'on' | 'error' | 'unsupported';

/** What the dashboard shows per destination while a stream is on air. */
export interface OutputLive {
  /** Viewer counts and chat are only available for destinations on a connected account. */
  supported: boolean;
  viewers: number | null;
  updatedAt: string | null;
  error: string | null;
  chat: ChatState;
  chatError: string | null;
}

interface DestRow {
  id: string; stream_id: string; name: string; platform: string; live: boolean; auth: 'key' | 'account';
  account_id: string | null; remote_id: string | null; watch_url: string | null;
}
interface BroadcastRow { id: string; stream_id: string | null; last_live_at: Date }

interface ChatSource { key: string; state(): ChatState; error(): string | null; stop(): void }

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);
const statsPlatforms = new Set(['youtube', 'facebook', 'twitch']);

/** Runs a poll function again after the delay it returns; errors back off and are shown. */
class PollingChat implements ChatSource {
  private st: ChatState = 'connecting';
  private err: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private failures = 0;
  constructor(public key: string, private poll: () => Promise<number>) { this.schedule(0); }
  private schedule(ms: number) {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      try {
        const next = await this.poll();
        this.st = 'on'; this.err = null; this.failures = 0;
        this.schedule(next);
      } catch (err) {
        this.st = 'error'; this.err = message(err); this.failures++;
        this.schedule(Math.min(120_000, 10_000 * this.failures));
      }
    }, ms);
    this.timer.unref();
  }
  state() { return this.st; }
  error() { return this.err; }
  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); }
}

/**
 * Follows the streams that are on air:
 * - opens a broadcast when the first output of a stream goes live and closes it after Stop (or after the grace period off air);
 * - samples the viewer counts of every destination on a connected account;
 * - collects the chat of YouTube, Facebook and Twitch into one table.
 */
export class LiveMonitor {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private closed = false;
  private lastSample = 0;
  private live = new Map<string, OutputLive>();
  private chats = new Map<string, ChatSource>();
  private writes = new Set<Promise<unknown>>();
  /** Whether a destination's output is on air right now; the media supervisor by default (replaced in tests). */
  onAir: (destId: string) => boolean;

  constructor(private sql: Sql, private log: FastifyBaseLogger, media: MediaSupervisor) {
    this.onAir = (id) => media.outputState(id).state === 'live';
  }

  start(intervalMs = 5000) {
    if (this.timer) return;
    const loop = async () => {
      await this.tick();
      if (!this.closed) { this.timer = setTimeout(loop, intervalMs); this.timer.unref(); }
    };
    this.timer = setTimeout(loop, 0);
  }

  async stop() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const c of this.chats.values()) c.stop();
    this.chats.clear();
    await this.running;
    await Promise.all([...this.writes]);
  }

  outputLive(destId: string): OutputLive | null { return this.live.get(destId) ?? null; }

  /** Forces a viewer sample on the next pass (tests, and right after Go live). */
  sampleSoon() { this.lastSample = 0; }

  async tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.pass().catch((err) => { this.log.error({ err }, 'live monitor pass failed'); }).finally(() => { this.running = null; });
    return this.running;
  }

  /** Waits for chat messages that are being stored (tests). */
  async flush() { await Promise.all([...this.writes]); }

  private track(p: Promise<unknown>) {
    const w = p.catch((err) => this.log.warn({ err }, 'storing chat failed')).finally(() => this.writes.delete(w));
    this.writes.add(w);
  }

  private async pass() {
    const now = Date.now();
    const streams = await this.sql<{ id: string; name: string; title: string }[]>`SELECT id, name, title FROM streams`;
    const dests = await this.sql<DestRow[]>`
      SELECT id, stream_id, name, platform, live, auth, account_id, remote_id, watch_url FROM destinations`;
    const accounts = new Map((await this.sql<AccountRow[]>`SELECT * FROM platform_accounts`).map((a) => [a.id, a]));
    const open = new Map<string, BroadcastRow>();
    for (const b of await this.sql<BroadcastRow[]>`SELECT id, stream_id, last_live_at FROM broadcasts WHERE ended_at IS NULL`) {
      if (!b.stream_id) { await closeBroadcast(this.sql, b.id); continue; }
      open.set(b.stream_id, b);
    }

    const airing: { d: DestRow; broadcastId: string; outputId: string; account: AccountRow | null }[] = [];
    for (const s of streams) {
      const mine = dests.filter((d) => d.stream_id === s.id);
      const onAir = mine.filter((d) => this.onAir(d.id));
      let b = open.get(s.id);
      if (onAir.length === 0) {
        if (b && (!mine.some((d) => d.live) || now - b.last_live_at.getTime() > config.live.graceMs)) {
          await closeBroadcast(this.sql, b.id);
          this.log.info({ stream: s.id, broadcast: b.id }, 'broadcast ended');
          await this.publishEnded(b.id);
        }
        continue;
      }
      if (!b) {
        const [ev] = await this.sql<{ id: string; title: string }[]>`
          SELECT id, title FROM events WHERE stream_id = ${s.id} AND status = 'live' ORDER BY started_at DESC LIMIT 1`;
        const [row] = await this.sql<BroadcastRow[]>`
          INSERT INTO broadcasts (stream_id, stream_name, event_id, title)
          VALUES (${s.id}, ${s.name}, ${ev?.id ?? null}, ${ev?.title || s.title || s.name})
          ON CONFLICT DO NOTHING RETURNING id, stream_id, last_live_at`;
        if (!row) continue;
        b = row;
        this.lastSample = 0;
        this.log.info({ stream: s.id, broadcast: b.id }, 'broadcast started');
        bus.publish('broadcast.started', { broadcast: { id: b.id, title: ev?.title || s.title || s.name, eventId: ev?.id ?? null }, stream: { id: s.id, name: s.name } });
      } else {
        await this.sql`UPDATE broadcasts SET last_live_at = now() WHERE id = ${b.id}`;
      }
      for (const d of onAir) {
        const account = d.account_id ? accounts.get(d.account_id) ?? null : null;
        const supported = d.auth === 'account' && !!account && account.provider === d.platform && statsPlatforms.has(d.platform)
          && (d.platform === 'twitch' || !!d.remote_id);
        const [o] = await this.sql<{ id: string }[]>`
          INSERT INTO broadcast_outputs (broadcast_id, destination_id, platform, name, watch_url, stats)
          VALUES (${b.id}, ${d.id}, ${d.platform}, ${d.name}, ${d.watch_url}, ${supported})
          ON CONFLICT (broadcast_id, destination_id) DO UPDATE
            SET watch_url = COALESCE(EXCLUDED.watch_url, broadcast_outputs.watch_url), stats = broadcast_outputs.stats OR EXCLUDED.stats
          RETURNING id`;
        airing.push({ d, broadcastId: b.id, outputId: o.id, account: supported ? account : null });
      }
    }

    // In-memory state and chat follow the outputs that are on air.
    const ids = new Set(airing.map((a) => a.d.id));
    for (const id of [...this.live.keys()]) if (!ids.has(id)) this.live.delete(id);
    for (const [id, c] of [...this.chats]) if (!ids.has(id)) { c.stop(); this.chats.delete(id); }
    for (const a of airing) {
      const cur = this.live.get(a.d.id);
      this.live.set(a.d.id, cur ?? { supported: !!a.account, viewers: null, updatedAt: null, error: null, chat: a.account ? 'connecting' : 'unsupported', chatError: null });
      if (a.account) this.ensureChat(a.d, a.account, a.broadcastId, a.outputId);
    }
    for (const a of airing) {
      const st = this.live.get(a.d.id)!;
      const c = this.chats.get(a.d.id);
      st.supported = !!a.account;
      st.chat = c ? c.state() : 'unsupported';
      st.chatError = c ? c.error() : null;
    }

    if (now - this.lastSample >= config.live.viewersMs && airing.length) {
      this.lastSample = now;
      await this.sample(airing.filter((a) => a.account));
    }
  }

  private async publishEnded(id: string) {
    const [b] = await this.sql<{ id: string; title: string; stream_id: string | null; stream_name: string; started_at: Date; ended_at: Date; peak_viewers: number; avg_viewers: number; chat_messages: number }[]>`
      SELECT id, title, stream_id, stream_name, started_at, ended_at, peak_viewers, avg_viewers, chat_messages FROM broadcasts WHERE id = ${id}`;
    if (!b) return;
    bus.publish('broadcast.ended', {
      broadcast: { id: b.id, title: b.title, startedAt: b.started_at, endedAt: b.ended_at, peakViewers: b.peak_viewers, avgViewers: b.avg_viewers, chatMessages: b.chat_messages },
      stream: { id: b.stream_id, name: b.stream_name },
    });
  }

  /** Reads all viewer counts at once and stores them as one sample per broadcast. */
  private async sample(list: { d: DestRow; broadcastId: string; outputId: string; account: AccountRow | null }[]) {
    if (!list.length) return;
    const settings = await getSettings(this.sql);
    const at = new Date();
    const results = await Promise.all(list.map(async (a) => {
      const st = this.live.get(a.d.id)!;
      try {
        const acc = a.account!;
        const token = await accessToken(this.sql, acc, settings);
        let viewers: number | null;
        if (acc.provider === 'youtube') viewers = (await youtubeLive.details(token, a.d.remote_id!)).viewers;
        else if (acc.provider === 'facebook') viewers = await facebookLive.viewers(token, a.d.remote_id!);
        else viewers = await twitchLive.viewers(settings, token, acc.external_id);
        st.viewers = viewers ?? 0; st.updatedAt = at.toISOString(); st.error = null;
        return { a, viewers: st.viewers };
      } catch (err) {
        st.error = message(err);
        this.log.warn({ err: st.error, destination: a.d.id }, 'reading viewers failed');
        // A short hiccup keeps the last known count in the sample, so the total does not dip.
        const fresh = st.updatedAt && at.getTime() - new Date(st.updatedAt).getTime() < 3 * config.live.viewersMs;
        return fresh && st.viewers !== null ? { a, viewers: st.viewers } : null;
      }
    }));
    const rows = results.filter((r): r is NonNullable<typeof r> => !!r)
      .map((r) => ({ broadcast_id: r.a.broadcastId, output_id: r.a.outputId, at, viewers: r.viewers }));
    if (rows.length) await this.sql`INSERT INTO viewer_samples ${this.sql(rows)} ON CONFLICT DO NOTHING`;
  }

  private save(broadcastId: string, outputId: string, platform: OAuthProvider, msgs: ChatMessage[]) {
    if (!msgs.length) return;
    const rows = msgs.map((m) => ({
      broadcast_id: broadcastId, output_id: outputId, platform, external_id: m.id.slice(0, 200), author: m.author, text: m.text, highlight: m.highlight, at: m.at,
    }));
    this.track(this.sql`INSERT INTO chat_messages ${this.sql(rows)} ON CONFLICT (output_id, external_id) DO NOTHING`);
  }

  private ensureChat(d: DestRow, account: AccountRow, broadcastId: string, outputId: string) {
    const provider = account.provider;
    const key = `${outputId}:${provider === 'twitch' ? account.handle : d.remote_id}`;
    const cur = this.chats.get(d.id);
    if (cur?.key === key) return;
    cur?.stop();
    const token = async () => {
      const [a] = await this.sql<AccountRow[]>`SELECT * FROM platform_accounts WHERE id = ${account.id}`;
      if (!a) throw new Error('account_missing');
      return accessToken(this.sql, a);
    };

    if (provider === 'twitch') {
      if (!account.handle) return;
      const chat = new TwitchChat(endpoints.twitchChat, account.handle, (m) => this.save(broadcastId, outputId, 'twitch', [m]));
      this.chats.set(d.id, { key, state: () => chat.state, error: () => chat.error, stop: () => chat.stop() });
      return;
    }

    if (provider === 'youtube') {
      const videoId = d.remote_id!;
      let chatId: string | null = null;
      let page: string | null = null;
      this.chats.set(d.id, new PollingChat(key, async () => {
        const t = await token();
        if (!chatId) {
          chatId = (await youtubeLive.details(t, videoId)).chatId;
          if (!chatId) throw new Error('chat_not_available');
        }
        const r = await youtubeLive.chat(t, chatId, page);
        page = r.nextPageToken;
        this.save(broadcastId, outputId, 'youtube', r.messages);
        if (r.offline) { chatId = null; page = null; }
        return Math.max(config.live.youtubeChatMs, r.pollMs);
      }));
      return;
    }

    const videoId = d.remote_id!;
    this.chats.set(d.id, new PollingChat(key, async () => {
      this.save(broadcastId, outputId, 'facebook', await facebookLive.comments(await token(), videoId));
      return config.live.facebookChatMs;
    }));
  }
}
