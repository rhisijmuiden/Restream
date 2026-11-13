import type { FastifyBaseLogger } from 'fastify';
import type { Sql } from '../db.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { getSettings, type OAuthProvider, type Settings } from '../lib/settings.js';
import { publishUrl } from '../media/platforms.js';
import { accessToken, facebook, PlatformError, twitch, x, xNotReady, youtube, type AccountRow, type BroadcastInfo } from './api.js';
import { readThumbnail } from '../lib/thumbnail.js';
import type { Platform } from '../media/platforms.js';

/**
 * What happened to one destination when the title and description were pushed:
 * - updated: the platform has the new title (and description where it has one);
 * - pending: the broadcast is still being created; it gets the new title then;
 * - next: the destination is not live; its next broadcast uses the new title;
 * - manual: a destination with a stream key; Restream cannot reach its title, change it on the platform;
 * - unsupported: the platform has no way to change the title of a running broadcast (X);
 * - failed: the platform refused; error says why.
 */
export type InfoResult = 'updated' | 'pending' | 'next' | 'manual' | 'unsupported' | 'failed';
export interface InfoOutcome {
  destinationId: string; name: string; platform: Platform; result: InfoResult; error: string | null;
  /** YouTube only: the thumbnail was set, failed, or there is none. */
  thumbnail: 'updated' | 'failed' | null;
}

interface DestRow {
  id: string; stream_id: string; name: string; platform: OAuthProvider; server_url: string; live: boolean; privacy: BroadcastInfo['privacy'];
  account_id: string | null; remote_url_enc: string | null; remote_id: string | null; remote_stream_id: string | null; prepared_event: string | null;
}

interface EventRow {
  id: string; stream_id: string; title: string; description: string; starts_at: Date; ends_at: Date | null; privacy: BroadcastInfo['privacy']; status: string;
}

interface TargetRow {
  event_id: string; destination_id: string; status: string; remote_id: string | null; dirty: boolean;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/**
 * Talks to the platforms for destinations that use a connected account:
 * - Go live: creates (or takes the event's) broadcast and gets the publish URL, before FFmpeg starts;
 * - X: publishes the broadcast once X receives the video (X refuses to go live on a source without video);
 * - Stop: ends the broadcast on the platform;
 * - Events: announces scheduled events on the platforms, updates and removes them.
 * Runs in the background next to the media supervisor, which waits for the publish URL ("preparing").
 */
export class Provisioner {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private retryAt = new Map<string, number>();
  private closed = false;
  /** Called after a destination got its publish URL, so FFmpeg starts without waiting for the next poll. */
  onReady: () => void = () => {};

  constructor(private sql: Sql, private log: FastifyBaseLogger) {}

  start(intervalMs = 3000) {
    if (this.timer) return;
    const loop = async () => {
      await this.tick();
      if (!this.closed) this.timer = setTimeout(loop, intervalMs);
    };
    this.timer = setTimeout(loop, 0);
  }

  stop() { this.closed = true; if (this.timer) clearTimeout(this.timer); }

  nudge() { if (!this.closed) void this.tick(); }

  async tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.pass().catch((err) => { this.log.error({ err }, 'provisioner pass failed'); }).finally(() => { this.running = null; });
    return this.running;
  }

  private async pass() {
    const s = await getSettings(this.sql);
    const dests = await this.sql<DestRow[]>`
      SELECT id, stream_id, name, platform, server_url, live, privacy, account_id, remote_url_enc, remote_id, remote_stream_id, prepared_event
      FROM destinations WHERE auth = 'account' OR remote_url_enc IS NOT NULL OR remote_id IS NOT NULL`;
    const now = Date.now();
    for (const d of dests) {
      if (!d.live) this.retryAt.delete(d.id);
      if (!d.live && (d.remote_url_enc || d.remote_id)) await this.finish(s, d);
      else if (d.live && !d.remote_url_enc && now >= (this.retryAt.get(d.id) ?? 0)) await this.prepare(s, d);
      else if (d.live && d.platform === 'x' && d.remote_url_enc && !d.remote_id && now >= (this.retryAt.get(d.id) ?? 0)) await this.publishX(s, d);
    }
    await this.syncEventTargets(s);
  }

  private async account(id: string | null): Promise<AccountRow | null> {
    if (!id) return null;
    const [a] = await this.sql<AccountRow[]>`SELECT * FROM platform_accounts WHERE id = ${id}`;
    return a ?? null;
  }

  /** The event that is live on this destination right now, with what was registered for it. */
  private async liveEvent(destId: string) {
    const [row] = await this.sql<(EventRow & { remote_id: string | null; target_status: string })[]>`
      SELECT e.*, t.remote_id, t.status AS target_status FROM event_targets t JOIN events e ON e.id = t.event_id
      WHERE t.destination_id = ${destId} AND e.status = 'live' ORDER BY e.started_at DESC LIMIT 1`;
    return row ?? null;
  }

  private async info(d: DestRow, ev: EventRow | null): Promise<BroadcastInfo> {
    if (ev) return { title: ev.title, description: ev.description, start: new Date(), end: ev.ends_at, privacy: ev.privacy };
    const [st] = await this.sql<{ name: string; title: string; description: string }[]>`SELECT name, title, description FROM streams WHERE id = ${d.stream_id}`;
    return { title: st?.title || st?.name || 'Live', description: st?.description ?? '', start: new Date(), end: null, privacy: d.privacy };
  }

  /** Gets the publish URL for a destination that is going live on a connected account. */
  private async prepare(s: Settings, d: DestRow) {
    try {
      const a = await this.account(d.account_id);
      if (!a || a.provider !== d.platform) throw new Error('account_missing');
      const token = await accessToken(this.sql, a, s);
      const ev = await this.liveEvent(d.id);
      const useEvent = ev && ev.target_status === 'registered' && ev.remote_id ? ev : null;
      const b = await this.info(d, ev);
      let url: string; let remoteId: string | null = null; let streamId = d.remote_stream_id; let watch: string | null = null;

      if (a.provider === 'youtube') {
        const stream = await youtube.ensureStream(token, d.remote_stream_id);
        streamId = stream.id;
        if (useEvent) { remoteId = useEvent.remote_id!; watch = `https://www.youtube.com/watch?v=${remoteId}`; }
        else { const bc = await youtube.createBroadcast(token, b); remoteId = bc.id; watch = bc.watchUrl; }
        await youtube.bind(token, remoteId, stream.id);
        await this.youtubeThumbnail(token, d.stream_id, remoteId).catch((err) => this.log.warn({ err: message(err), destination: d.id }, 'youtube: setting the thumbnail failed'));
        url = stream.url;
      } else if (a.provider === 'facebook') {
        if (useEvent) {
          remoteId = useEvent.remote_id!;
          const v = await facebook.get(token, remoteId);
          url = v.secure_stream_url ?? v.stream_url ?? '';
          // A scheduled live video is published when its event starts.
          await facebook.goLive(token, remoteId).catch((err) => this.log.warn({ err, destination: d.id }, 'facebook: publishing the scheduled live video failed'));
          watch = await facebook.watchUrl(token, remoteId);
        } else {
          const v = await facebook.create(a.external_id, token, b, false);
          remoteId = v.id; url = v.url ?? ''; watch = v.watchUrl;
        }
        if (!url) throw new Error('facebook returned no stream URL');
      } else if (a.provider === 'x') {
        // The source is reused for every broadcast; the broadcast itself is published once the video arrives (publishX).
        const src = await x.ensureSource(token, d.remote_stream_id, `Restream · ${d.name}`);
        streamId = src.id; url = src.url;
      } else {
        const key = await twitch.streamKey(s, token, a.external_id);
        url = publishUrl('twitch', d.server_url, key);
        await twitch.setTitle(s, token, a.external_id, b.title).catch((err) => this.log.warn({ err }, 'twitch: setting the title failed'));
        watch = a.handle ? `https://www.twitch.tv/${a.handle}` : null;
      }

      if (useEvent) await this.sql`UPDATE event_targets SET status = 'used' WHERE event_id = ${useEvent.id} AND destination_id = ${d.id}`;
      await this.sql`
        UPDATE destinations SET remote_url_enc = ${encrypt(url)}, remote_id = ${remoteId}, remote_stream_id = ${streamId},
               watch_url = ${watch}, prepare_error = NULL, prepared_event = ${ev?.id ?? null}
        WHERE id = ${d.id}`;
      this.retryAt.delete(d.id);
      this.log.info({ destination: d.id, platform: d.platform, event: ev?.id }, 'broadcast prepared on connected account');
      this.onReady();
    } catch (err) {
      this.retryAt.set(d.id, Date.now() + 30_000);
      const xRefused = d.platform === 'x' && err instanceof PlatformError && err.status === 403 && !/scope/i.test(err.message);
      await this.sql`UPDATE destinations SET prepare_error = ${xRefused ? 'x_not_eligible' : message(err)} WHERE id = ${d.id}`;
      this.log.warn({ err, destination: d.id }, 'preparing broadcast failed');
    }
  }

  /**
   * X: publishes the broadcast as soon as X receives the video on the source. Until then FFmpeg is already sending;
   * the dashboard shows "waiting for X" and the reason when X refuses (for example an account without Premium).
   */
  private async publishX(s: Settings, d: DestRow) {
    const wait = (ms: number) => this.retryAt.set(d.id, Date.now() + ms);
    try {
      const a = await this.account(d.account_id);
      if (!a || a.provider !== 'x' || !d.remote_stream_id) throw new Error('account_missing');
      const token = await accessToken(this.sql, a, s);
      if (!await x.sourceActive(token, d.remote_stream_id)) {
        wait(3000);
        await this.sql`UPDATE destinations SET prepare_error = NULL WHERE id = ${d.id} AND prepare_error IS NOT NULL`;
        return;
      }
      const b = await this.info(d, await this.liveEvent(d.id));
      const bc = await x.goLive(token, d.remote_stream_id, b.title);
      await this.sql`
        UPDATE destinations SET remote_id = ${bc.id}, watch_url = ${bc.watchUrl}, prepare_error = NULL
        WHERE id = ${d.id} AND live`;
      this.retryAt.delete(d.id);
      this.log.info({ destination: d.id, broadcast: bc.id }, 'x: broadcast is live');
    } catch (err) {
      if (xNotReady(err)) { wait(5000); return; }
      // 403: the account may not go live (X asks for a paid subscription) or the broadcast was moderated.
      const code = err instanceof PlatformError && err.status === 403 && !/scope/i.test(err.message) ? 'x_not_eligible' : message(err);
      wait(code === 'x_not_eligible' ? 60_000 : 15_000);
      await this.sql`UPDATE destinations SET prepare_error = ${code} WHERE id = ${d.id}`;
      this.log.warn({ err, destination: d.id }, 'x: going live failed');
    }
  }

  /** Ends the broadcast of a destination that stopped and forgets its publish URL. */
  private async finish(s: Settings, d: DestRow) {
    if (d.remote_id && (d.platform === 'youtube' || d.platform === 'facebook' || d.platform === 'x')) {
      try {
        const a = await this.account(d.account_id);
        if (a) {
          const token = await accessToken(this.sql, a, s);
          if (d.platform === 'youtube') await youtube.end(token, d.remote_id);
          else if (d.platform === 'x') await x.end(token, d.remote_id);
          else await facebook.end(token, d.remote_id);
        }
      } catch (err) {
        // Usually already ended (YouTube auto-stop); the broadcast is not reused either way.
        this.log.info({ err: message(err), destination: d.id }, 'ending broadcast on the platform');
      }
    }
    await this.sql`
      UPDATE destinations SET remote_url_enc = NULL, remote_id = NULL, watch_url = NULL, prepare_error = NULL, prepared_event = NULL
      WHERE id = ${d.id} AND NOT live`;
    this.retryAt.delete(d.id);
  }

  /** Ends a destination's broadcast right away, e.g. before the destination is deleted. */
  async release(destId: string) {
    const [d] = await this.sql<DestRow[]>`SELECT * FROM destinations WHERE id = ${destId}`;
    if (d && (d.remote_id || d.remote_url_enc)) await this.finish(await getSettings(this.sql), { ...d, live: false });
  }

  // -------------------------------------------------------------------------------------------
  // Events

  /** Registers new targets, pushes changes and removes cancelled ones on the platforms (part of every pass). */
  private async syncEventTargets(settings: Settings) {
    const rows = await this.sql<(TargetRow & { platform: string; auth: string; account_id: string | null; event_status: string })[]>`
      SELECT t.*, d.platform, d.auth, d.account_id, e.status AS event_status
      FROM event_targets t JOIN destinations d ON d.id = t.destination_id JOIN events e ON e.id = t.event_id
      WHERE t.status IN ('pending', 'removed') OR (t.status = 'registered' AND t.dirty)`;
    for (const t of rows) {
      const retryKey = `target:${t.event_id}:${t.destination_id}`;
      if (Date.now() < (this.retryAt.get(retryKey) ?? 0)) continue;
      const [ev] = await this.sql<EventRow[]>`SELECT * FROM events WHERE id = ${t.event_id}`;
      try {
        if (t.status === 'removed') {
          if (t.remote_id) await this.removeRemote(settings, t.account_id, t.platform, t.remote_id);
          await this.sql`DELETE FROM event_targets WHERE event_id = ${t.event_id} AND destination_id = ${t.destination_id}`;
          continue;
        }
        if (t.auth !== 'account' || !['youtube', 'facebook', 'twitch'].includes(t.platform)) {
          await this.sql`UPDATE event_targets SET status = 'skipped', dirty = false, error = NULL WHERE event_id = ${t.event_id} AND destination_id = ${t.destination_id}`;
          continue;
        }
        if (ev.status !== 'scheduled') continue;
        const a = await this.account(t.account_id);
        if (!a) throw new Error('account_missing');
        const token = await accessToken(this.sql, a, settings);
        const b: BroadcastInfo = { title: ev.title, description: ev.description, start: ev.starts_at, end: ev.ends_at, privacy: ev.privacy };
        let remoteId = t.remote_id; let watch: string | null = null;
        if (t.status === 'registered' && remoteId) {
          if (a.provider === 'youtube') await youtube.updateBroadcast(token, remoteId, b);
          else if (a.provider === 'facebook') await facebook.update(token, remoteId, b);
          else await twitch.updateSegment(settings, token, a.external_id, remoteId, b);
        } else if (a.provider === 'youtube') {
          const bc = await youtube.createBroadcast(token, b); remoteId = bc.id; watch = bc.watchUrl;
        } else if (a.provider === 'facebook') {
          const v = await facebook.create(a.external_id, token, b, true); remoteId = v.id; watch = v.watchUrl;
        } else {
          remoteId = await twitch.createSegment(settings, token, a.external_id, b);
          watch = a.handle ? `https://www.twitch.tv/${a.handle}/schedule` : null;
        }
        await this.sql`
          UPDATE event_targets SET status = 'registered', dirty = false, error = NULL, remote_id = ${remoteId}, watch_url = COALESCE(${watch}, watch_url)
          WHERE event_id = ${t.event_id} AND destination_id = ${t.destination_id}`;
      } catch (err) {
        this.log.warn({ err, event: t.event_id, destination: t.destination_id }, 'event registration failed');
        this.retryAt.set(retryKey, Date.now() + 60_000);
        // Removing keeps being retried; a failed registration is shown and the event still goes live with Go live.
        if (t.status !== 'removed') {
          await this.sql`UPDATE event_targets SET status = CASE WHEN status = 'registered' THEN status ELSE 'failed' END, dirty = false, error = ${message(err)}
                         WHERE event_id = ${t.event_id} AND destination_id = ${t.destination_id}`;
        }
      }
    }
  }

  private async removeRemote(s: Settings, accountId: string | null, platform: string, remoteId: string) {
    const a = await this.account(accountId);
    if (!a) return;
    const token = await accessToken(this.sql, a, s);
    try {
      if (platform === 'youtube') await youtube.remove(token, remoteId);
      else if (platform === 'facebook') await facebook.remove(token, remoteId);
      else if (platform === 'twitch') await twitch.removeSegment(s, token, a.external_id, remoteId);
    } catch (err) {
      // Already gone on the platform: nothing left to remove.
      if ((err as { status?: number }).status === 404) return;
      throw err;
    }
  }

  private async youtubeThumbnail(token: string, streamId: string, videoId: string): Promise<boolean> {
    const [st] = await this.sql<{ thumbnail: string | null }[]>`SELECT thumbnail FROM streams WHERE id = ${streamId}`;
    const img = await readThumbnail(st?.thumbnail ?? null);
    if (!img) return false;
    await youtube.setThumbnail(token, videoId, img.data, img.type);
    return true;
  }

  /**
   * Pushes the stream's title, description and thumbnail to every destination that is live on a connected account,
   * so a title change reaches YouTube, Facebook and Twitch at once, also during the broadcast.
   */
  async pushInfo(streamId: string, opts: { thumbnail?: boolean } = {}): Promise<InfoOutcome[]> {
    const s = await getSettings(this.sql);
    const dests = await this.sql<(DestRow & { auth: 'key' | 'account' })[]>`
      SELECT id, stream_id, name, platform, server_url, live, privacy, account_id, remote_url_enc, remote_id, remote_stream_id, prepared_event, auth
      FROM destinations WHERE stream_id = ${streamId} ORDER BY position, created_at`;
    return Promise.all(dests.map(async (d): Promise<InfoOutcome> => {
      const out: InfoOutcome = { destinationId: d.id, name: d.name, platform: d.platform as Platform, result: 'next', error: null, thumbnail: null };
      if (!d.live) return out;
      if (d.auth !== 'account') return { ...out, result: 'manual' };
      if (d.platform === 'x') return { ...out, result: 'unsupported' };
      if (d.platform !== 'twitch' && !d.remote_id) return { ...out, result: 'pending' };
      try {
        const a = await this.account(d.account_id);
        if (!a) throw new Error('account_missing');
        const token = await accessToken(this.sql, a, s);
        const b = await this.info(d, await this.liveEvent(d.id));
        if (d.platform === 'youtube') {
          await youtube.setInfo(token, d.remote_id!, b.title, b.description);
          if (opts.thumbnail !== false) {
            try { if (await this.youtubeThumbnail(token, streamId, d.remote_id!)) out.thumbnail = 'updated'; }
            catch (err) { out.thumbnail = 'failed'; out.error = message(err); }
          }
        } else if (d.platform === 'facebook') {
          await facebook.setInfo(token, d.remote_id!, b.title, b.description);
        } else {
          await twitch.setTitle(s, token, a.external_id, b.title);
        }
        return { ...out, result: 'updated' };
      } catch (err) {
        this.log.warn({ err, destination: d.id }, 'updating the broadcast title failed');
        return { ...out, result: 'failed', error: message(err) };
      }
    }));
  }

  /** Publish URL for the media supervisor (decrypted), or null while preparing. */
  static publishUrl(remoteUrlEnc: string | null) { return remoteUrlEnc ? decrypt(remoteUrlEnc) : null; }
}
