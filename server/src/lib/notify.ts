import type { FastifyBaseLogger } from 'fastify';
import type { Sql } from '../db.js';
import { branchToChannel, config, readBuildInfo } from '../config.js';
import type { MediaSupervisor } from '../media/supervisor.js';
import { getSettings, type NotifyEvent, type Settings } from './settings.js';
import { mailConfigured, notificationRecipients, render, sendMail } from './mail.js';
import { readUpdateStatus, fetchRemote } from './updates.js';
import { decrypt } from './crypto.js';

type Lang = 'en' | 'nl';
type Tone = 'ok' | 'warn' | 'danger' | 'info';

/** Notification texts in English and Dutch. */
const T = {
  en: {
    footer: (n: string) => `You get this message because notifications are switched on in ${n} (Administration › Mail server).`,
    open: 'Open the console',
    stream: 'Stream', destination: 'Destination', platform: 'Platform', since: 'Since', error: 'Last error', attempts: 'Attempts',
    backup: 'Backup', type: 'Type', size: 'Size', duration: 'Duration', target: 'Target', channel: 'Channel', version: 'Version', from: 'From', to: 'To', result: 'Result',
    full: 'full', incremental: 'incremental',
    streamDown: (s: string) => [`Stream "${s}" lost its ingest`, `The encoder stopped sending to "${s}" while destinations are live. Restream keeps the destinations ready and resumes as soon as the encoder reconnects.`],
    streamUp: (s: string) => [`Stream "${s}" is back`, `The encoder is sending to "${s}" again; the live destinations resume automatically.`],
    outputDown: (d: string) => [`Destination "${d}" keeps failing`, `Restream cannot keep the connection to "${d}" up and keeps retrying. Check the stream key and the platform.`],
    outputUp: (d: string) => [`Destination "${d}" is live again`, `The connection to "${d}" is up again.`],
    mediaDown: ['The media server is down', 'MediaMTX has not responded for a minute, so no streams can come in or go out. Restream restarts it automatically; an administrator can also use Repair on the dashboard.'],
    mediaUp: ['The media server is running again', 'MediaMTX responds again. Ingest and outputs work normally.'],
    backupOk: (id: string) => [`Backup ${id} completed`, 'The backup was encrypted and stored on the remote location.'],
    backupFail: (id: string) => [`Backup failed`, `Backup ${id} could not be completed. Restream tries again at the next scheduled time.`],
    updateOk: ['Update installed', 'Restream was updated and is running the new version.'],
    updateRolledBack: ['Update failed and was rolled back', 'The update did not complete. Restream restored the previous version, which is running normally.'],
    updateFail: ['Update failed', 'The update and the automatic rollback both failed. Check the server: journalctl -u restream'],
    updateAvailable: (v: string) => [`Update available: ${v}`, 'A new version is available on your channel. You can install it from Administration › Updates.'],
    testSubject: (n: string) => `Test message from ${n}`,
    testIntro: 'Your mail server settings work. Restream can send notifications.',
    server: 'Server', security: 'Security', dkim: 'DKIM',
  },
  nl: {
    footer: (n: string) => `Je krijgt dit bericht omdat meldingen aan staan in ${n} (Beheer › Mailserver).`,
    open: 'Console openen',
    stream: 'Stream', destination: 'Bestemming', platform: 'Platform', since: 'Sinds', error: 'Laatste fout', attempts: 'Pogingen',
    backup: 'Back-up', type: 'Soort', size: 'Grootte', duration: 'Duur', target: 'Locatie', channel: 'Kanaal', version: 'Versie', from: 'Van', to: 'Naar', result: 'Resultaat',
    full: 'volledig', incremental: 'incrementeel',
    streamDown: (s: string) => [`Stream "${s}" heeft geen ingest meer`, `De encoder stuurt niets meer naar "${s}" terwijl er bestemmingen live staan. Restream houdt de bestemmingen klaar en gaat verder zodra de encoder weer verbindt.`],
    streamUp: (s: string) => [`Stream "${s}" is terug`, `De encoder stuurt weer naar "${s}"; de live bestemmingen gaan automatisch verder.`],
    outputDown: (d: string) => [`Bestemming "${d}" blijft mislukken`, `Restream krijgt de verbinding met "${d}" niet stabiel en blijft het proberen. Controleer de streamkey en het platform.`],
    outputUp: (d: string) => [`Bestemming "${d}" is weer live`, `De verbinding met "${d}" staat weer.`],
    mediaDown: ['De mediaserver ligt eruit', 'MediaMTX reageert al een minuut niet, dus er kunnen geen streams binnenkomen of uitgaan. Restream start hem automatisch opnieuw; een beheerder kan ook Repareren gebruiken op het dashboard.'],
    mediaUp: ['De mediaserver draait weer', 'MediaMTX reageert weer. Ingest en bestemmingen werken normaal.'],
    backupOk: (id: string) => [`Back-up ${id} voltooid`, 'De back-up is versleuteld en op de remote locatie opgeslagen.'],
    backupFail: (id: string) => [`Back-up mislukt`, `Back-up ${id} kon niet worden voltooid. Restream probeert het opnieuw op het volgende geplande tijdstip.`],
    updateOk: ['Update geïnstalleerd', 'Restream is bijgewerkt en draait op de nieuwe versie.'],
    updateRolledBack: ['Update mislukt en teruggedraaid', 'De update is niet gelukt. Restream heeft de vorige versie teruggezet; die draait normaal.'],
    updateFail: ['Update mislukt', 'De update en het automatisch terugdraaien zijn allebei mislukt. Controleer de server: journalctl -u restream'],
    updateAvailable: (v: string) => [`Update beschikbaar: ${v}`, 'Er staat een nieuwe versie klaar op jouw kanaal. Je installeert hem via Beheer › Updates.'],
    testSubject: (n: string) => `Testbericht van ${n}`,
    testIntro: 'Je mailserverinstellingen werken. Restream kan meldingen versturen.',
    server: 'Server', security: 'Beveiliging', dkim: 'DKIM',
  },
} as const;

export const texts = (lang: Lang) => T[lang] ?? T.en;

export function formatBytes(n: number) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

interface NotifyState { initialized?: boolean; updateFinishedAt?: string; updateAvailableCommit?: string }

/**
 * Watches the media supervisor and the updater and mails the configured recipients when
 * something breaks (and once more when it recovers). Mail problems are logged, never thrown.
 */
export class Notifier {
  private timer: NodeJS.Timeout | null = null;
  private downSince = new Map<string, number>();
  private alerted = new Set<string>();
  private lastUpdateCheck = 0;
  private busy = false;

  constructor(private sql: Sql, private media: MediaSupervisor | null, private log: FastifyBaseLogger) {}

  start(intervalMs = 10_000) {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    this.timer.unref();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Sends one notification when the event is switched on. Returns false when nothing was sent. */
  async send(event: NotifyEvent, build: (t: ReturnType<typeof texts>) => { title: string; intro: string; rows?: [string, string][]; tone?: Tone }, s?: Settings) {
    try {
      const settings = s ?? await getSettings(this.sql);
      if (!settings.notifications.events[event] || !mailConfigured(settings.mail)) return false;
      const to = await notificationRecipients(this.sql, settings);
      if (!to.length) return false;
      const t = texts(settings.defaultLanguage);
      const b = build(t);
      const body = render({
        instanceName: settings.instanceName, title: b.title, intro: b.intro, rows: b.rows, tone: b.tone,
        link: settings.publicUrl ? { href: settings.publicUrl, label: t.open } : undefined,
        footer: t.footer(settings.instanceName),
      });
      await sendMail(this.sql, { kind: event, to, subject: `[${settings.instanceName}] ${b.title}`, ...body }, settings);
      return true;
    } catch (err) {
      this.log.warn({ err, event }, 'notification could not be sent');
      return false;
    }
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const s = await getSettings(this.sql);
      if (this.media && config.media.enabled) await this.checkMedia(s);
      await this.checkUpdates(s);
    } catch (err) {
      this.log.warn({ err }, 'notifier check failed');
    } finally {
      this.busy = false;
    }
  }

  /** Raises an alert after `graceMs` in the failing state; clears it (optionally with a recovery mail) when it recovers. */
  private async edge(key: string, failing: boolean, graceMs: number, down: () => Promise<boolean>, up: (() => Promise<boolean>) | null) {
    const now = Date.now();
    if (failing) {
      if (!this.downSince.has(key)) this.downSince.set(key, now);
      if (!this.alerted.has(key) && now - this.downSince.get(key)! >= graceMs) {
        this.alerted.add(key);
        await down();
      }
      return;
    }
    this.downSince.delete(key);
    if (this.alerted.delete(key) && up) await up();
  }

  private async checkMedia(s: Settings) {
    const media = this.media!;
    await this.edge('media', !media.mediamtxOnline, 60_000,
      () => this.send('mediaServerDown', (t) => ({ title: t.mediaDown[0], intro: t.mediaDown[1], tone: 'danger' }), s),
      () => this.send('mediaServerDown', (t) => ({ title: t.mediaUp[0], intro: t.mediaUp[1], tone: 'ok' }), s));
    if (!media.mediamtxOnline) return;

    const streams = await this.sql<{ id: string; name: string }[]>`SELECT id, name FROM streams WHERE enabled`;
    const dests = await this.sql<{ id: string; name: string; platform: string; stream_id: string; live: boolean }[]>`
      SELECT id, name, platform, stream_id, live FROM destinations`;
    const seen = new Set<string>();
    for (const st of streams) {
      const ingest = media.ingestState(st.id);
      const live = dests.filter((d) => d.stream_id === st.id && d.live);
      const key = `stream:${st.id}`;
      seen.add(key);
      const since = new Date().toISOString().slice(11, 19);
      // Stopping all outputs ends the incident without a "back" message.
      await this.edge(key, live.length > 0 && !ingest.online, 20_000,
        () => this.send('streamDown', (t) => ({ title: t.streamDown(st.name)[0], intro: t.streamDown(st.name)[1], tone: 'danger', rows: [[t.stream, st.name], [t.since, `${since} UTC`]] }), s),
        live.length ? () => this.send('streamDown', (t) => ({ title: t.streamUp(st.name)[0], intro: t.streamUp(st.name)[1], tone: 'ok', rows: [[t.stream, st.name]] }), s) : null);

      for (const d of dests.filter((x) => x.stream_id === st.id)) {
        const out = media.outputState(d.id);
        const dkey = `output:${d.id}`;
        seen.add(dkey);
        const failing = d.live && ingest.online && out.state !== 'live' && out.attempts >= 3;
        await this.edge(dkey, failing, 0,
          () => this.send('outputFailed', (t) => ({
            title: t.outputDown(d.name)[0], intro: t.outputDown(d.name)[1], tone: 'warn',
            rows: [[t.stream, st.name], [t.destination, d.name], [t.platform, d.platform], [t.attempts, String(out.attempts)], ...(out.lastError ? [[t.error, out.lastError.slice(0, 160)] as [string, string]] : [])],
          }), s),
          d.live && out.state === 'live'
            ? () => this.send('outputFailed', (t) => ({ title: t.outputUp(d.name)[0], intro: t.outputUp(d.name)[1], tone: 'ok', rows: [[t.stream, st.name], [t.destination, d.name]] }), s)
            : null);
      }
    }
    for (const key of [...this.downSince.keys(), ...this.alerted]) {
      if ((key.startsWith('stream:') || key.startsWith('output:')) && !seen.has(key)) { this.downSince.delete(key); this.alerted.delete(key); }
    }
  }

  private async state(): Promise<NotifyState> {
    const [row] = await this.sql<{ value: NotifyState }[]>`SELECT value FROM settings WHERE key = 'notifyState'`;
    return row?.value ?? {};
  }

  private async saveState(st: NotifyState) {
    await this.sql`
      INSERT INTO settings (key, value) VALUES ('notifyState', ${this.sql.json(st as never)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  }

  private async checkUpdates(s: Settings) {
    const st = await this.state();
    const u = readUpdateStatus();
    const done = ['success', 'failed', 'rolled_back'].includes(u.state) && u.finishedAt;
    if (!st.initialized) {
      // First run: remember the current status so an old update is not reported.
      await this.saveState({ ...st, initialized: true, updateFinishedAt: u.finishedAt ?? '' });
      return;
    }
    if (done && u.finishedAt !== st.updateFinishedAt) {
      await this.saveState({ ...st, updateFinishedAt: u.finishedAt });
      if (u.message !== 'Already up to date') {
        const b = readBuildInfo();
        await this.send('updateFinished', (t) => {
          const [title, intro] = u.state === 'success' ? t.updateOk : u.state === 'rolled_back' ? t.updateRolledBack : t.updateFail;
          return {
            title, intro, tone: u.state === 'success' ? 'ok' : 'danger',
            rows: [[t.channel, u.channel ?? ''], [t.version, b.version], [t.from, (u.from ?? '').slice(0, 7)], [t.to, (u.to ?? '').slice(0, 7)], ...(u.message ? [[t.result, u.message] as [string, string]] : [])],
          };
        }, s);
      }
    }

    if (!s.notifications.events.updateAvailable || Date.now() - this.lastUpdateCheck < 6 * 3600_000) return;
    this.lastUpdateCheck = Date.now();
    const b = readBuildInfo();
    const channel = branchToChannel(b.branch);
    try {
      const remote = await fetchRemote(channel, s.githubTokenEnc ? decrypt(s.githubTokenEnc) : '');
      if (remote.commit !== b.commit && remote.commit !== st.updateAvailableCommit) {
        await this.saveState({ ...(await this.state()), updateAvailableCommit: remote.commit });
        const v = `${remote.version ?? ''} (${remote.commit.slice(0, 7)})`.trim();
        await this.send('updateAvailable', (t) => ({
          title: t.updateAvailable(v)[0], intro: t.updateAvailable(v)[1], tone: 'info',
          rows: [[t.channel, channel], [t.version, `${b.version} → ${remote.version ?? '?'}`], [t.to, remote.message.slice(0, 80)]],
        }), s);
      }
    } catch (err) {
      this.log.debug({ err }, 'update check for notification failed');
    }
  }
}
