import { spawn, type ChildProcess } from 'node:child_process';
import type { FastifyBaseLogger } from 'fastify';
import type { Sql } from '../db.js';
import { config } from '../config.js';
import { bus } from '../lib/events.js';
import { getSettings } from '../lib/settings.js';
import { probeArgs, redact } from '../media/ffmpeg.js';
import { srtStats } from '../media/mediamtx.js';
import type { FeedInfo, MediaSupervisor, OutputStateName } from '../media/supervisor.js';
import type { Platform } from '../media/platforms.js';
import { FrameStats, median, nominalFps } from './frames.js';
import { SystemSampler, type ServerSample } from './system.js';

/** How long the charts look back. */
export const HISTORY_MS = 15 * 60_000;

export type Severity = 'warn' | 'danger';

/**
 * What can be wrong. The console and the mails explain each code in plain words:
 * - feed_bitrate_drop: the encoder sends far less than it did a minute ago (network of the encoder, or the encoder itself);
 * - feed_fps_low: frames are missing (the encoder or its computer cannot keep up);
 * - feed_keyframes: key frames are too far apart (platforms ask for 2 s, accept up to 4 s);
 * - feed_errors: time stamps going back or damaged frames;
 * - feed_srt_drops: SRT packets arrive too late and are skipped (raise the SRT latency or improve the line);
 * - output_slow: a destination cannot keep up (upload or CPU of this server);
 * - server_cpu, server_memory, server_disk, server_upload: this server runs out of room.
 */
export type IssueCode =
  | 'feed_bitrate_drop' | 'feed_fps_low' | 'feed_keyframes' | 'feed_errors' | 'feed_srt_drops'
  | 'output_slow' | 'server_cpu' | 'server_memory' | 'server_disk' | 'server_upload';

export interface Issue {
  key: string;
  code: IssueCode;
  severity: Severity;
  /** When the condition started (before the grace time). */
  since: string;
  streamId: string | null;
  streamName: string | null;
  input: 'main' | 'backup' | null;
  destinationId: string | null;
  destinationName: string | null;
  /** Figures for the explanation, e.g. { now: 1200, before: 6000 }. */
  params: Record<string, number>;
}

export interface FeedPoint { t: number; kbps: number | null; fps: number | null }
export interface OutputPoint { t: number; kbps: number | null; speed: number | null; cpu: number | null }
export interface ServerPoint { t: number; cpu: number | null; memory: number | null; upload: number | null; download: number | null }

export interface FeedHealth {
  streamId: string;
  input: 'main' | 'backup';
  protocol: string | null;
  video: { codec: string; width: number | null; height: number | null } | null;
  bitrateKbps: number | null;
  fps: number | null;
  nominalFps: number | null;
  keyframeSeconds: number | null;
  /** Time stamp errors and damaged frames in the last minute. */
  errors: number;
  srt: { rttMs: number | null; retransPercent: number | null; linkMbps: number | null; drops: number } | null;
  history: FeedPoint[];
}

export interface OutputHealth {
  destinationId: string;
  streamId: string;
  name: string;
  platform: Platform;
  mode: 'copy' | 'transcode';
  state: OutputStateName;
  bitrateKbps: number | null;
  /** Bitrate the destination should carry when transcoding (video + audio). */
  targetKbps: number | null;
  speed: number | null;
  /** CPU of its FFmpeg process, in % of one core. */
  cpuPercent: number | null;
  history: OutputPoint[];
}

export interface HealthSnapshot {
  enabled: boolean;
  sampledAt: string | null;
  server: Omit<ServerSample, 'at'> & { uploadCapacityKbps: number | null; history: ServerPoint[] };
  feeds: FeedHealth[];
  outputs: OutputHealth[];
  issues: Issue[];
}

interface Probe { child: ChildProcess; frames: FrameStats; stopping: boolean; stderr: string[]; errorLines: number }

interface FeedTrack {
  path: string;
  probe: Probe | null;
  restartAt: number;
  lastTake: number;
  fps: number | null;
  keyframeSeconds: number | null;
  /** Error counts per sample, to sum the last minute. */
  errors: { t: number; n: number }[];
  framesInError: number | null;
  srt: FeedHealth['srt'];
  srtDrops: { t: number; total: number }[];
  history: FeedPoint[];
  info: FeedInfo;
}

interface DestRow {
  id: string; stream_id: string; name: string; platform: Platform; mode: 'copy' | 'transcode'; live: boolean;
  video_bitrate: number; audio_bitrate: number;
}

const trim = <T extends { t: number }>(list: T[], now: number) => {
  while (list.length && list[0]!.t < now - HISTORY_MS) list.shift();
};
const avg = (v: (number | null)[]) => {
  const n = v.filter((x): x is number => x !== null);
  return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null;
};

/**
 * Raises an issue after its condition held for a grace time and clears it after the condition was gone for a short while,
 * so a single bad sample does not cause a warning and a flapping value does not cause a flood.
 */
export class IssueTracker {
  private onSince = new Map<string, number>();
  private offSince = new Map<string, number>();
  readonly active = new Map<string, Issue>();
  constructor(private clearMs = 6000, private onRaise: (i: Issue) => void = () => {}, private onClear: (i: Issue) => void = () => {}) {}

  observe(key: string, on: boolean, graceMs: number, now: number, make: () => Omit<Issue, 'key' | 'since'>) {
    const cur = this.active.get(key);
    if (on) {
      this.offSince.delete(key);
      if (!this.onSince.has(key)) this.onSince.set(key, now);
      if (cur) { Object.assign(cur, { ...make(), key, since: cur.since }); return; }
      if (now - this.onSince.get(key)! >= graceMs) {
        const issue = { ...make(), key, since: new Date(this.onSince.get(key)!).toISOString() };
        this.active.set(key, issue);
        this.onRaise(issue);
      }
      return;
    }
    this.onSince.delete(key);
    if (!cur) return;
    if (!this.offSince.has(key)) this.offSince.set(key, now);
    if (now - this.offSince.get(key)! >= this.clearMs) this.clear(key);
  }

  /** Clears what was not observed in this pass (a feed went offline, a destination was removed). */
  sweep(seen: Set<string>) {
    for (const key of [...this.active.keys()]) if (!seen.has(key)) this.clear(key);
    for (const key of [...this.onSince.keys()]) if (!seen.has(key)) this.onSince.delete(key);
    for (const key of [...this.offSince.keys()]) if (!seen.has(key)) this.offSince.delete(key);
  }

  private clear(key: string) {
    const cur = this.active.get(key);
    this.active.delete(key);
    this.offSince.delete(key);
    if (cur) this.onClear(cur);
  }

  list(): Issue[] {
    const rank = { danger: 0, warn: 1 };
    return [...this.active.values()].sort((a, b) => rank[a.severity] - rank[b.severity] || a.since.localeCompare(b.since));
  }
}

/** Input of one evaluation pass; built from live measurements, or by hand in the tests. */
export interface EvalInput {
  now: number;
  server: ServerSample;
  uploadCapacityKbps: number | null;
  feeds: { streamId: string; streamName: string; input: 'main' | 'backup'; history: FeedPoint[]; keyframeSeconds: number | null; errors: number; srtDrops: number }[];
  outputs: { destinationId: string; destinationName: string; streamId: string; streamName: string; live: boolean; state: OutputStateName; history: OutputPoint[] }[];
}

/** Checks every rule and updates the tracker; returns the keys it looked at. */
export function evaluate(tracker: IssueTracker, x: EvalInput): Set<string> {
  const seen = new Set<string>();
  const { now } = x;
  const check = (key: string, on: boolean, graceMs: number, make: () => Omit<Issue, 'key' | 'since'>) => {
    seen.add(key);
    tracker.observe(key, on, graceMs, now, make);
  };
  const base = { streamId: null, streamName: null, input: null, destinationId: null, destinationName: null } as const;

  // Server
  const s = x.server;
  check('server_cpu', (s.cpuPercent ?? 0) >= 90, 20_000, () => ({
    ...base, code: 'server_cpu', severity: (s.cpuPercent ?? 0) >= 97 ? 'danger' : 'warn', params: { percent: Math.round(s.cpuPercent ?? 0), cores: s.cores },
  }));
  const memPct = s.memory ? (s.memory.usedBytes / s.memory.totalBytes) * 100 : 0;
  check('server_memory', memPct >= 92, 30_000, () => ({ ...base, code: 'server_memory', severity: 'warn', params: { percent: Math.round(memPct) } }));
  const freeGb = s.disk ? s.disk.freeBytes / 1024 ** 3 : Infinity;
  check('server_disk', freeGb < 5, 0, () => ({ ...base, code: 'server_disk', severity: freeGb < 1 ? 'danger' : 'warn', params: { freeGb: Math.round(freeGb * 10) / 10 } }));
  const cap = x.uploadCapacityKbps;
  check('server_upload', !!cap && (s.uploadKbps ?? 0) > cap * 0.85, 10_000, () => ({
    ...base, code: 'server_upload', severity: (s.uploadKbps ?? 0) > cap! * 0.97 ? 'danger' : 'warn',
    params: { percent: Math.round(((s.uploadKbps ?? 0) / cap!) * 100), mbps: Math.round((s.uploadKbps ?? 0) / 100) / 10, capacityMbps: Math.round(cap! / 100) / 10 },
  }));

  // Feeds
  for (const f of x.feeds) {
    const who = { ...base, streamId: f.streamId, streamName: f.streamName, input: f.input };
    const k = (code: string) => `${code}:${f.streamId}:${f.input}`;
    const h = f.history.filter((p) => p.t >= now - 60_000);
    const recent = h.filter((p) => p.t >= now - 6_000);
    const before = h.filter((p) => p.t < now - 8_000).map((p) => p.kbps).filter((v): v is number => v !== null);
    const baseline = before.length >= 10 ? median(before) : null;
    const current = avg(recent.map((p) => p.kbps));
    check(k('feed_bitrate_drop'), baseline !== null && baseline >= 300 && current !== null && current < baseline * 0.5, 4_000, () => ({
      ...who, code: 'feed_bitrate_drop', severity: current !== null && baseline !== null && current < baseline * 0.2 ? 'danger' : 'warn',
      params: { now: Math.round(current ?? 0), before: Math.round(baseline ?? 0) },
    }));
    const nominal = nominalFps(h.map((p) => p.fps).filter((v): v is number => v !== null));
    const fpsNow = avg(recent.map((p) => p.fps));
    check(k('feed_fps_low'), nominal !== null && fpsNow !== null && fpsNow < nominal * 0.9, 8_000, () => ({
      ...who, code: 'feed_fps_low', severity: 'warn', params: { now: Math.round((fpsNow ?? 0) * 10) / 10, expected: nominal ?? 0 },
    }));
    check(k('feed_keyframes'), f.keyframeSeconds !== null && f.keyframeSeconds > 4.2, 10_000, () => ({
      ...who, code: 'feed_keyframes', severity: 'warn', params: { seconds: f.keyframeSeconds ?? 0 },
    }));
    check(k('feed_errors'), f.errors >= 5, 0, () => ({ ...who, code: 'feed_errors', severity: 'warn', params: { count: f.errors } }));
    check(k('feed_srt_drops'), f.srtDrops >= 10, 0, () => ({ ...who, code: 'feed_srt_drops', severity: 'warn', params: { count: f.srtDrops } }));
  }

  // Destinations
  for (const o of x.outputs) {
    const recent = o.history.filter((p) => p.t >= now - 10_000);
    const speed = avg(recent.map((p) => p.speed));
    // Speed below 1 means FFmpeg delivers slower than real time: the platform falls behind until it drops the stream.
    check(`output_slow:${o.destinationId}`, o.live && o.state === 'live' && recent.length >= 3 && speed !== null && speed < 0.95, 10_000, () => ({
      ...base, streamId: o.streamId, streamName: o.streamName, destinationId: o.destinationId, destinationName: o.destinationName,
      code: 'output_slow', severity: speed !== null && speed < 0.8 ? 'danger' : 'warn', params: { speed: Math.round((speed ?? 0) * 100) / 100 },
    }));
  }
  return seen;
}

/**
 * Watches the health of a running broadcast: the incoming feeds (bitrate, frame rate, key frames, errors, SRT link),
 * every live destination (bitrate, speed, CPU) and the server itself (CPU, memory, upload, disk).
 * Keeps 15 minutes of history in memory for the charts and raises issues for the console, the mails and the webhooks.
 */
export class HealthMonitor {
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private sampler = new SystemSampler(config.dataDir);
  private feeds = new Map<string, FeedTrack>();
  private outputs = new Map<string, { history: OutputPoint[] }>();
  private serverHistory: ServerPoint[] = [];
  private last: HealthSnapshot | null = null;
  private busy = false;
  readonly tracker: IssueTracker;
  private names = new Map<string, string>();

  constructor(private sql: Sql, private media: MediaSupervisor, private log: FastifyBaseLogger, private intervalMs = config.media.pollMs) {
    const describe = (i: Issue) => ({
      code: i.code, severity: i.severity, since: i.since, params: i.params,
      stream: i.streamId ? { id: i.streamId, name: i.streamName ?? '' } : null, input: i.input,
      destination: i.destinationId ? { id: i.destinationId, name: i.destinationName ?? '' } : null,
    });
    this.tracker = new IssueTracker(6000,
      (i) => { this.log.warn({ issue: i.key, params: i.params }, 'health issue'); bus.publish('health.warning', describe(i)); },
      (i) => { this.log.info({ issue: i.key }, 'health issue cleared'); bus.publish('health.cleared', describe(i)); });
  }

  start() {
    if (this.timer) return;
    const loop = async () => {
      await this.tick();
      if (!this.closed) this.timer = setTimeout(loop, this.intervalMs);
    };
    this.timer = setTimeout(loop, this.intervalMs);
  }

  async stop() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    const waits: Promise<void>[] = [];
    for (const f of this.feeds.values()) if (f.probe) { waits.push(new Promise((r) => f.probe!.child.once('close', () => r()))); this.stopProbe(f); }
    await Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, 3000))]);
  }

  snapshot(): HealthSnapshot {
    if (this.last) return this.last;
    const s = this.sampler.sample();
    const { at: _at, ...rest } = s;
    return { enabled: config.media.enabled, sampledAt: null, server: { ...rest, uploadCapacityKbps: null, history: [] }, feeds: [], outputs: [], issues: [] };
  }

  issues(): Issue[] { return this.tracker.list(); }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try { await this.pass(); } catch (err) { this.log.warn({ err }, 'health pass failed'); } finally { this.busy = false; }
  }

  private async pass() {
    const now = Date.now();
    const settings = await getSettings(this.sql);
    const server = this.sampler.sample(now);
    const capacity = settings.health.uploadMbps > 0 ? settings.health.uploadMbps * 1000 : null;
    this.serverHistory.push({
      t: now, cpu: server.cpuPercent, memory: server.memory ? Math.round((server.memory.usedBytes / server.memory.totalBytes) * 1000) / 10 : null,
      upload: server.uploadKbps, download: server.downloadKbps,
    });
    trim(this.serverHistory, now);

    const streams = await this.sql<{ id: string; name: string }[]>`SELECT id, name FROM streams`;
    this.names = new Map(streams.map((s) => [s.id, s.name]));

    // Feeds: one light probe per online feed.
    const online = this.media.feeds();
    const keys = new Set<string>();
    for (const info of online) {
      const key = `${info.streamId}:${info.input}`;
      keys.add(key);
      let f = this.feeds.get(key);
      if (f && f.path !== info.path) { this.stopProbe(f); f = undefined; }
      if (!f) {
        f = { path: info.path, probe: null, restartAt: 0, lastTake: now, fps: null, keyframeSeconds: null, errors: [], framesInError: null, srt: null, srtDrops: [], history: [], info };
        this.feeds.set(key, f);
      }
      f.info = info;
      if (!f.probe && now >= f.restartAt && config.media.enabled) this.startProbe(f);
      await this.sampleFeed(f, now);
    }
    for (const [key, f] of this.feeds) {
      if (keys.has(key)) continue;
      this.stopProbe(f);
      this.feeds.delete(key);
    }
    this.media.setProbed(new Set([...this.feeds.values()].filter((f) => f.probe).map((f) => f.path)));

    // Destinations.
    const dests = await this.sql<DestRow[]>`SELECT id, stream_id, name, platform, mode, live, video_bitrate, audio_bitrate FROM destinations ORDER BY position, created_at`;
    const pids = this.media.outputPids();
    const outputs: OutputHealth[] = [];
    for (const d of dests) {
      const st = this.media.outputState(d.id);
      let track = this.outputs.get(d.id);
      if (!d.live && !track) continue;
      track ??= { history: [] };
      this.outputs.set(d.id, track);
      const cpu = this.sampler.processCpu(pids.get(d.id), now);
      if (d.live) track.history.push({ t: now, kbps: st.bitrateKbps, speed: st.speed, cpu });
      trim(track.history, now);
      if (!d.live && !track.history.length) { this.outputs.delete(d.id); continue; }
      outputs.push({
        destinationId: d.id, streamId: d.stream_id, name: d.name, platform: d.platform, mode: d.mode, state: d.live ? st.state : 'off',
        bitrateKbps: d.live ? st.bitrateKbps : null, targetKbps: d.mode === 'transcode' ? d.video_bitrate + d.audio_bitrate : null,
        speed: d.live ? st.speed : null, cpuPercent: d.live ? cpu : null, history: track.history,
      });
    }
    const ids = new Set(dests.map((d) => d.id));
    for (const id of [...this.outputs.keys()]) if (!ids.has(id)) this.outputs.delete(id);
    this.sampler.keepOnly(new Set(pids.values()));

    const feedList = [...this.feeds.values()];
    const seen = evaluate(this.tracker, {
      now, server, uploadCapacityKbps: capacity,
      feeds: feedList.map((f) => ({
        streamId: f.info.streamId, streamName: this.names.get(f.info.streamId) ?? '', input: f.info.input, history: f.history,
        keyframeSeconds: f.keyframeSeconds, errors: f.errors.filter((e) => e.t >= now - 30_000).reduce((a, e) => a + e.n, 0),
        srtDrops: this.srtDropsSince(f, now - 30_000),
      })),
      outputs: outputs.map((o) => ({
        destinationId: o.destinationId, destinationName: o.name, streamId: o.streamId, streamName: this.names.get(o.streamId) ?? '',
        live: o.state !== 'off', state: o.state, history: o.history,
      })),
    });
    this.tracker.sweep(seen);

    const { at: _at, ...srv } = server;
    this.last = {
      enabled: config.media.enabled,
      sampledAt: new Date(now).toISOString(),
      server: { ...srv, uploadCapacityKbps: capacity, history: this.serverHistory },
      feeds: feedList.map((f) => ({
        streamId: f.info.streamId, input: f.info.input, protocol: f.info.state.protocol, video: f.info.state.video,
        bitrateKbps: f.info.state.bitrateKbps, fps: f.fps,
        nominalFps: nominalFps(f.history.filter((p) => p.t >= now - 60_000).map((p) => p.fps).filter((v): v is number => v !== null)),
        keyframeSeconds: f.keyframeSeconds, errors: f.errors.filter((e) => e.t >= now - 60_000).reduce((a, e) => a + e.n, 0),
        srt: f.srt, history: f.history,
      })),
      outputs,
      issues: this.tracker.list(),
    };
  }

  private srtDropsSince(f: FeedTrack, since: number) {
    const old = f.srtDrops.find((d) => d.t >= since);
    const last = f.srtDrops[f.srtDrops.length - 1];
    return old && last ? Math.max(0, last.total - old.total) : 0;
  }

  private async sampleFeed(f: FeedTrack, now: number) {
    let errors = 0;
    if (f.probe) {
      const w = f.probe.frames.take();
      const secs = (now - f.lastTake) / 1000;
      f.fps = secs > 0.2 ? Math.round((w.frames / secs) * 10) / 10 : f.fps;
      if (w.keyframeSeconds !== null) f.keyframeSeconds = w.keyframeSeconds;
      errors += w.timestampErrors + f.probe.errorLines;
      f.probe.errorLines = 0;
    }
    f.lastTake = now;
    const fie = f.info.framesInError;
    if (fie !== null) {
      if (f.framesInError !== null && fie > f.framesInError) errors += fie - f.framesInError;
      f.framesInError = fie;
    }
    if (errors) f.errors.push({ t: now, n: errors });
    while (f.errors.length && f.errors[0]!.t < now - 60_000) f.errors.shift();

    if (f.info.source?.type.toLowerCase().startsWith('srt')) {
      const st = await srtStats(f.info.source.id);
      if (st) {
        f.srt = {
          rttMs: st.msRTT ?? null, retransPercent: st.packetsReceivedLossRate !== undefined ? Math.round(st.packetsReceivedLossRate * 10) / 10 : null,
          linkMbps: st.mbpsLinkCapacity ?? null, drops: st.packetsReceivedDrop ?? 0,
        };
        f.srtDrops.push({ t: now, total: st.packetsReceivedDrop ?? 0 });
        while (f.srtDrops.length && f.srtDrops[0]!.t < now - 60_000) f.srtDrops.shift();
      }
    }
    // The first seconds after (re)connecting have no frame rate yet.
    f.history.push({ t: now, kbps: f.info.state.bitrateKbps, fps: f.probe ? f.fps : null });
    trim(f.history, now);
  }

  private startProbe(f: FeedTrack) {
    const input = `${config.media.rtspUrl}/${f.path}`;
    const key = f.path.split('/').pop() ?? '';
    let child: ChildProcess;
    try {
      child = spawn(config.media.ffmpegPath, probeArgs(input), { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      f.restartAt = Date.now() + 10_000;
      this.log.warn({ err }, 'health probe could not start');
      return;
    }
    const probe: Probe = { child, frames: new FrameStats(), stopping: false, stderr: [], errorLines: 0 };
    f.probe = probe;
    f.lastTake = Date.now();
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (c: string) => probe.frames.push(c));
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (c: string) => {
      for (const line of c.split('\n')) {
        const l = line.trim();
        if (!l) continue;
        // Damaged input or time stamps going back count as feed errors.
        if (/corrupt|non[- ]monoton|invalid|missing|error while decoding|concealing|discard/i.test(l)) probe.errorLines++;
        probe.stderr.push(redact(l, [key]).slice(0, 200));
        if (probe.stderr.length > 10) probe.stderr.shift();
      }
    });
    child.on('error', (err) => { probe.stderr.push(err.message); });
    child.on('close', (code) => {
      if (f.probe === probe) f.probe = null;
      if (!probe.stopping) {
        f.restartAt = Date.now() + 5000;
        this.log.debug({ code, stderr: probe.stderr.slice(-2) }, 'health probe stopped');
      }
    });
  }

  private stopProbe(f: FeedTrack) {
    const p = f.probe;
    if (!p || p.stopping) return;
    p.stopping = true;
    f.probe = null;
    p.child.kill('SIGTERM');
    const t = setTimeout(() => p.child.kill('SIGKILL'), 3000);
    t.unref();
    p.child.once('close', () => clearTimeout(t));
  }
}
