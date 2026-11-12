import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, statSync, statfsSync } from 'node:fs';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Sql } from '../db.js';
import { config } from '../config.js';
import { decrypt } from '../lib/crypto.js';
import { ffmpegArgs, parseProgress, recordArgs, redact, type OutputSpec } from './ffmpeg.js';
import { cleanupRecordings, recordingsDir } from '../lib/recordings.js';
import { ingestPath, listPaths, type MtxPath, type MtxTrack } from './mediamtx.js';
import type { Platform } from './platforms.js';

export type OutputStateName = 'off' | 'waiting' | 'preparing' | 'connecting' | 'live' | 'reconnecting';

export interface RecordingState {
  /** off: not asked; waiting: asked, no ingest yet; recording: writing a file. */
  state: 'off' | 'waiting' | 'recording';
  recordingId: string | null;
  since: string | null;
  sizeBytes: number;
  durationSeconds: number;
  lastError: string | null;
}

export interface IngestState {
  online: boolean;
  since: string | null;
  protocol: string | null;
  video: { codec: string; width: number | null; height: number | null } | null;
  audio: { codec: string; sampleRate: number | null; channels: number | null } | null;
  bitrateKbps: number | null;
  /** Local readers (outputs, HLS, WebRTC viewers). */
  readers: number;
  /** True above the 1080p maximum Restream v1 supports. */
  overLimit: boolean;
}

export interface OutputState {
  state: OutputStateName;
  since: string | null;
  bitrateKbps: number | null;
  fps: number | null;
  speed: number | null;
  attempts: number;
  lastError: string | null;
}

interface DestRow {
  id: string; stream_id: string; platform: Platform; server_url: string; stream_key_enc: string; passphrase_enc: string;
  mode: 'copy' | 'transcode'; video_bitrate: number; audio_bitrate: number; max_height: number; fps: number | null; live: boolean;
  auth: 'key' | 'account'; remote_url_enc: string | null; prepare_error: string | null;
}

interface RecProc {
  child: ChildProcess;
  recordingId: string;
  file: string;
  startedAt: number;
  stopping: boolean;
  stderr: string[];
  bytes: number;
  outTimeUs: number;
  /** The INSERT of the recording row; the final UPDATE waits for it. */
  inserted: Promise<unknown>;
}

/** A recording does not start with less free disk space than this. */
const MIN_FREE_BYTES = 1024 ** 3;

interface Proc {
  child: ChildProcess;
  hash: string;
  startedAt: number;
  stopping: boolean;
  secrets: string[];
  stderr: string[];
  lastBytes: { bytes: number; at: number } | null;
}

const offline: IngestState = { online: false, since: null, protocol: null, video: null, audio: null, bitrateKbps: null, readers: 0, overLimit: false };
const idle = (): OutputState => ({ state: 'off', since: null, bitrateKbps: null, fps: null, speed: null, attempts: 0, lastError: null });

const protocolOf = (sourceType: string | undefined) =>
  !sourceType ? null : sourceType.startsWith('rtmp') ? 'RTMP' : sourceType.startsWith('srt') ? 'SRT'
    : sourceType.startsWith('webRTC') ? 'WebRTC' : sourceType.startsWith('rtsp') ? 'RTSP' : sourceType;

export function ingestFromPath(p: MtxPath | undefined, prev: { bytes: number; at: number } | undefined, now: number): IngestState {
  if (!p || !(p.online ?? p.ready)) return offline;
  const tracks: MtxTrack[] = p.tracks2 ?? (p.tracks ?? []).map((codec) => ({ codec }));
  const v = tracks.find((t) => ['H264', 'H265', 'AV1', 'VP9', 'VP8', 'MPEG-4 Video', 'MPEG-1/2 Video'].includes(t.codec));
  const a = tracks.find((t) => t !== v);
  const bytes = p.inboundBytes ?? p.bytesReceived ?? 0;
  const bitrate = prev && now > prev.at && bytes >= prev.bytes ? Math.round(((bytes - prev.bytes) * 8) / (now - prev.at)) : null;
  const width = v?.codecProps?.width ?? null;
  const height = v?.codecProps?.height ?? null;
  return {
    online: true,
    since: p.onlineTime ?? p.readyTime ?? null,
    protocol: protocolOf(p.source?.type),
    video: v ? { codec: v.codec, width, height } : null,
    audio: a ? { codec: a.codec, sampleRate: a.codecProps?.sampleRate ?? null, channels: a.codecProps?.channelCount ?? null } : null,
    bitrateKbps: bitrate,
    readers: p.readers?.length ?? 0,
    overLimit: (width ?? 0) > 1920 || (height ?? 0) > 1080,
  };
}

/**
 * Keeps the FFmpeg outputs in line with the desired state in the database:
 * a destination that is "live" gets an FFmpeg process while its ingest is online,
 * and is restarted with backoff when the process exits.
 */
export class MediaSupervisor {
  mediamtxOnline = false;
  private ingest = new Map<string, IngestState>();
  private outputs = new Map<string, OutputState>();
  private procs = new Map<string, Proc>();
  private nextAttempt = new Map<string, number>();
  private bytes = new Map<string, { bytes: number; at: number }>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private closed = false;
  private recs = new Map<string, RecProc>();
  private recState = new Map<string, RecordingState>();
  private writes = new Set<Promise<unknown>>();
  private lastCleanup = 0;

  constructor(private sql: Sql, private log: FastifyBaseLogger) {}

  start() {
    if (this.timer) return;
    this.track(this.recoverRecordings());
    const loop = async () => {
      await this.tick();
      if (!this.closed) this.timer = setTimeout(loop, config.media.pollMs);
    };
    this.timer = setTimeout(loop, 0);
  }

  /** Runs a reconcile pass now (after a change in the console). */
  nudge() {
    if (!config.media.enabled || this.closed) return;
    void this.tick();
  }

  ingestState(streamId: string): IngestState { return this.ingest.get(streamId) ?? offline; }
  outputState(destId: string): OutputState { return this.outputs.get(destId) ?? idle(); }
  recordingState(streamId: string): RecordingState {
    return this.recState.get(streamId) ?? { state: 'off', recordingId: null, since: null, sizeBytes: 0, durationSeconds: 0, lastError: null };
  }
  /** Live size and duration of a recording that is being written. */
  activeRecording(recordingId: string): { sizeBytes: number; durationSeconds: number } | null {
    for (const r of this.recs.values()) if (r.recordingId === recordingId) return { sizeBytes: r.bytes, durationSeconds: Math.floor(r.outTimeUs / 1e6) };
    return null;
  }

  private track<T>(p: Promise<T>) {
    const w = p.catch((err) => { this.log.error({ err }, 'recording bookkeeping failed'); }).finally(() => { this.writes.delete(w); });
    this.writes.add(w);
  }

  async tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.reconcile().catch((err) => { this.log.error({ err }, 'media reconcile failed'); }).finally(() => { this.running = null; });
    return this.running;
  }

  private async reconcile() {
    const now = Date.now();
    let paths: MtxPath[] = [];
    try {
      paths = await listPaths();
      if (!this.mediamtxOnline) this.log.info('MediaMTX is reachable');
      this.mediamtxOnline = true;
    } catch (err) {
      if (this.mediamtxOnline) this.log.warn({ err }, 'MediaMTX is not reachable');
      this.mediamtxOnline = false;
    }
    const byName = new Map(paths.map((p) => [p.name, p]));

    const streams = await this.sql<{ id: string; name: string; ingest_key_enc: string; enabled: boolean; record: boolean; record_by: string | null; record_event: string | null }[]>`
      SELECT id, name, ingest_key_enc, enabled, record, record_by, record_event FROM streams`;
    const keys = new Map<string, string>();
    const seenPaths = new Set<string>();
    for (const s of streams) {
      const key = decrypt(s.ingest_key_enc);
      keys.set(s.id, key);
      const name = ingestPath(key);
      seenPaths.add(name);
      const p = byName.get(name);
      const state = s.enabled ? ingestFromPath(p, this.bytes.get(name), now) : offline;
      this.ingest.set(s.id, state);
      if (p) this.bytes.set(name, { bytes: p.inboundBytes ?? p.bytesReceived ?? 0, at: now });
      else this.bytes.delete(name);
    }
    for (const id of [...this.ingest.keys()]) if (!keys.has(id)) this.ingest.delete(id);

    for (const s of streams) this.reconcileRecording(s, keys.get(s.id)!, now);
    for (const id of [...this.recs.keys()]) if (!keys.has(id)) this.stopRecording(id);
    for (const id of [...this.recState.keys()]) if (!keys.has(id) && !this.recs.has(id)) this.recState.delete(id);
    if (now - this.lastCleanup > 3600_000) {
      this.lastCleanup = now;
      this.track(cleanupRecordings(this.sql, this.log));
    }
    for (const name of [...this.bytes.keys()]) if (!seenPaths.has(name)) this.bytes.delete(name);

    const dests = await this.sql<DestRow[]>`
      SELECT d.id, d.stream_id, d.platform, d.server_url, d.stream_key_enc, d.passphrase_enc, d.mode,
             d.video_bitrate, d.audio_bitrate, d.max_height, d.fps, d.live, d.auth, d.remote_url_enc, d.prepare_error
      FROM destinations d JOIN streams s ON s.id = d.stream_id`;
    const ids = new Set(dests.map((d) => d.id));

    for (const d of dests) {
      const ingest = this.ingest.get(d.stream_id) ?? offline;
      const key = keys.get(d.stream_id)!;
      const want = d.live && ingest.online;
      const proc = this.procs.get(d.id);
      const out = this.outputs.get(d.id) ?? idle();

      // A destination on a connected account publishes to the URL the platform handed out for this broadcast.
      const viaAccount = d.auth === 'account';
      const spec: OutputSpec = {
        platform: d.platform, serverUrl: viaAccount ? (d.remote_url_enc ? decrypt(d.remote_url_enc) : '') : d.server_url,
        streamKey: viaAccount ? '' : d.stream_key_enc ? decrypt(d.stream_key_enc) : '',
        passphrase: d.passphrase_enc ? decrypt(d.passphrase_enc) : '',
        mode: d.mode, videoBitrate: d.video_bitrate, audioBitrate: d.audio_bitrate, maxHeight: d.max_height, fps: d.fps,
      };
      const src = { videoCodec: ingest.video?.codec ?? null, audioCodec: ingest.audio?.codec ?? null };
      const hash = JSON.stringify([spec, src, key]);

      if (proc && (!want || proc.hash !== hash)) {
        this.stop(d.id);
        continue;
      }
      if (!d.live) {
        if (!proc) { this.outputs.set(d.id, idle()); this.nextAttempt.delete(d.id); }
        continue;
      }
      if (viaAccount && !d.remote_url_enc) {
        if (!proc) this.outputs.set(d.id, { ...idle(), state: 'preparing', lastError: d.prepare_error });
        continue;
      }
      if (!ingest.online) {
        if (!proc) this.outputs.set(d.id, { ...idle(), state: 'waiting', attempts: 0, lastError: out.lastError });
        this.nextAttempt.delete(d.id);
        continue;
      }
      if (!proc && now >= (this.nextAttempt.get(d.id) ?? 0)) {
        this.launch(d.id, `${config.media.rtspUrl}/${ingestPath(key)}`, spec, src, hash);
      }
    }

    for (const id of [...this.procs.keys()]) if (!ids.has(id)) this.stop(id);
    for (const id of [...this.outputs.keys()]) if (!ids.has(id) && !this.procs.has(id)) this.outputs.delete(id);
  }

  private launch(id: string, input: string, spec: OutputSpec, src: { videoCodec: string | null; audioCodec: string | null }, hash: string) {
    const prev = this.outputs.get(id) ?? idle();
    const args = ffmpegArgs(input, spec, src);
    const secrets = [spec.streamKey, spec.passphrase, encodeURIComponent(spec.streamKey), encodeURIComponent(spec.passphrase), input.split('/').pop() ?? ''];
    const child = spawn(config.media.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const proc: Proc = { child, hash, startedAt: Date.now(), stopping: false, secrets, stderr: [], lastBytes: null };
    this.procs.set(id, proc);
    this.outputs.set(id, { ...prev, state: prev.attempts > 0 ? 'reconnecting' : 'connecting', since: null, bitrateKbps: null, fps: null, speed: null });

    let buf = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.search(/progress=(continue|end)\n/)) !== -1) {
        const end = buf.indexOf('\n', idx) + 1;
        const block = buf.slice(0, end);
        buf = buf.slice(end);
        this.onProgress(id, proc, block);
      }
      if (buf.length > 64_000) buf = '';
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        const l = line.trim();
        if (l) proc.stderr.push(redact(l, proc.secrets).slice(0, 300));
      }
      if (proc.stderr.length > 30) proc.stderr.splice(0, proc.stderr.length - 30);
    });
    child.on('error', (err) => { proc.stderr.push(err.message); });
    child.on('close', (code, signal) => this.onExit(id, proc, code, signal));
  }

  private onProgress(id: string, proc: Proc, block: string) {
    if (this.procs.get(id) !== proc) return;
    const p = parseProgress(block);
    const now = Date.now();
    let kbps = p.bitrateKbps;
    if (p.totalBytes !== null && proc.lastBytes && now > proc.lastBytes.at && p.totalBytes >= proc.lastBytes.bytes) {
      kbps = Math.round(((p.totalBytes - proc.lastBytes.bytes) * 8) / (now - proc.lastBytes.at));
    }
    if (p.totalBytes !== null) proc.lastBytes = { bytes: p.totalBytes, at: now };
    const cur = this.outputs.get(id) ?? idle();
    const flowing = (p.totalBytes ?? 0) > 0;
    // A connection that stays up for a minute resets the backoff.
    const attempts = now - proc.startedAt > 60_000 ? 0 : cur.attempts;
    this.outputs.set(id, {
      ...cur,
      state: flowing ? 'live' : cur.state,
      since: flowing ? (cur.since ?? new Date().toISOString()) : cur.since,
      bitrateKbps: kbps, fps: p.fps, speed: p.speed, attempts,
      lastError: flowing && attempts === 0 ? null : cur.lastError,
    });
  }

  private onExit(id: string, proc: Proc, code: number | null, signal: NodeJS.Signals | null) {
    if (this.procs.get(id) === proc) this.procs.delete(id);
    const cur = this.outputs.get(id) ?? idle();
    const lastError = proc.stderr.filter((l) => !/^\s*(frame|size)=/.test(l)).slice(-1)[0] ?? (code !== 0 ? `FFmpeg exited with code ${code ?? signal}` : null);
    if (proc.stopping) {
      this.outputs.set(id, { ...cur, state: 'off', since: null, bitrateKbps: null, fps: null, speed: null });
      this.nudge();
      return;
    }
    const attempts = cur.attempts + 1;
    const delay = Math.min(30, 2 ** Math.min(attempts, 5)) * 1000;
    this.nextAttempt.set(id, Date.now() + delay);
    this.outputs.set(id, { ...cur, state: 'reconnecting', since: null, bitrateKbps: null, fps: null, speed: null, attempts, lastError });
    this.log.warn({ destination: id, code, signal, attempts, lastError }, 'output stopped, reconnecting');
  }

  private stop(id: string) {
    const proc = this.procs.get(id);
    if (!proc || proc.stopping) return;
    proc.stopping = true;
    proc.child.kill('SIGTERM');
    const t = setTimeout(() => proc.child.kill('SIGKILL'), 4000);
    t.unref();
    proc.child.once('close', () => clearTimeout(t));
  }

  async close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    const waits = [...this.procs.values(), ...this.recs.values()].map((p) => new Promise<void>((r) => { p.child.once('close', () => r()); }));
    for (const id of [...this.procs.keys()]) this.stop(id);
    for (const id of [...this.recs.keys()]) this.stopRecording(id);
    await Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, 5000))]);
    await Promise.all([...this.writes]);
  }

  // -------------------------------------------------------------------------------------------
  // Recordings

  private reconcileRecording(s: { id: string; name: string; enabled: boolean; record: boolean; record_by: string | null; record_event: string | null }, key: string, now: number) {
    const ingest = this.ingest.get(s.id) ?? offline;
    const want = s.enabled && s.record && ingest.online;
    const proc = this.recs.get(s.id);
    const cur = this.recordingState(s.id);
    if (proc && !want) { this.stopRecording(s.id); return; }
    if (proc) return;
    if (!s.record) { this.recState.set(s.id, { ...cur, state: 'off', recordingId: null, since: null, sizeBytes: 0, durationSeconds: 0 }); return; }
    if (!want) { this.recState.set(s.id, { ...cur, state: 'waiting', recordingId: null, since: null, sizeBytes: 0, durationSeconds: 0 }); return; }
    if (now < (this.nextAttempt.get(`rec:${s.id}`) ?? 0)) return;
    this.startRecording(s, key, ingest);
  }

  private startRecording(s: { id: string; name: string; record_by: string | null; record_event: string | null }, key: string, ingest: IngestState) {
    const dir = recordingsDir();
    try {
      mkdirSync(dir, { recursive: true });
      const fs = statfsSync(dir);
      if (fs.bavail * fs.bsize < MIN_FREE_BYTES) throw new Error('disk_full');
    } catch (err) {
      const msg = (err as Error).message;
      this.nextAttempt.set(`rec:${s.id}`, Date.now() + 60_000);
      this.recState.set(s.id, { ...this.recordingState(s.id), state: 'waiting', lastError: msg });
      this.log.warn({ stream: s.id, err: msg }, 'recording cannot start');
      return;
    }
    const id = randomUUID();
    const file = `${new Date().toISOString().slice(0, 10)}-${id}.mp4`;
    const src = { videoCodec: ingest.video?.codec ?? null, audioCodec: ingest.audio?.codec ?? null };
    const video = ingest.video ? `${ingest.video.codec}${ingest.video.width ? ` ${ingest.video.width}x${ingest.video.height}` : ''}` : null;
    const audio = ingest.audio?.codec ?? null;
    const args = recordArgs(`${config.media.rtspUrl}/${ingestPath(key)}`, src, path.join(dir, file));
    const child = spawn(config.media.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const inserted = this.sql`
      INSERT INTO recordings (id, stream_id, stream_name, event_id, title, file, video, audio, started_by)
      VALUES (${id}, ${s.id}, ${s.name}, ${s.record_event},
              COALESCE((SELECT title FROM events WHERE id = ${s.record_event}), ''), ${file}, ${video}, ${audio}, ${s.record_by})`.then(() => null);
    this.track(inserted);
    const proc: RecProc = { child, recordingId: id, file, startedAt: Date.now(), stopping: false, stderr: [], bytes: 0, outTimeUs: 0, inserted };
    this.recs.set(s.id, proc);
    this.recState.set(s.id, { state: 'recording', recordingId: id, since: new Date().toISOString(), sizeBytes: 0, durationSeconds: 0, lastError: null });
    this.log.info({ stream: s.id, recording: id }, 'recording started');

    let buf = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.search(/progress=(continue|end)\n/)) !== -1) {
        const end = buf.indexOf('\n', idx) + 1;
        const p = parseProgress(buf.slice(0, end));
        buf = buf.slice(end);
        if (p.totalBytes !== null) proc.bytes = p.totalBytes;
        if (p.outTimeUs !== null && p.outTimeUs > 0) proc.outTimeUs = p.outTimeUs;
        const st = this.recState.get(s.id);
        if (st && st.recordingId === id) this.recState.set(s.id, { ...st, sizeBytes: proc.bytes, durationSeconds: Math.floor(proc.outTimeUs / 1e6) });
      }
      if (buf.length > 64_000) buf = '';
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        const l = line.trim();
        if (l) proc.stderr.push(redact(l, [key]).slice(0, 300));
      }
      if (proc.stderr.length > 30) proc.stderr.splice(0, proc.stderr.length - 30);
    });
    child.on('error', (err) => { proc.stderr.push(err.message); });
    child.on('close', (code) => this.onRecordingExit(s.id, proc, code));
  }

  private onRecordingExit(streamId: string, proc: RecProc, code: number | null) {
    if (this.recs.get(streamId) === proc) this.recs.delete(streamId);
    let size = proc.bytes;
    try { size = statSync(path.join(recordingsDir(), proc.file)).size; } catch { size = 0; }
    const ok = size > 0;
    const error = ok ? null : proc.stderr.slice(-1)[0] ?? `FFmpeg exited with code ${code}`;
    this.track(proc.inserted.then(() => this.sql`
      UPDATE recordings SET status = ${ok ? 'finished' : 'failed'}, size_bytes = ${size}, duration_seconds = ${Math.floor(proc.outTimeUs / 1e6)},
             error = ${error}, ended_at = now()
      WHERE id = ${proc.recordingId}`));
    const cur = this.recordingState(streamId);
    this.recState.set(streamId, { state: 'off', recordingId: null, since: null, sizeBytes: 0, durationSeconds: 0, lastError: ok ? null : error ?? cur.lastError });
    if (!proc.stopping) {
      // Ingest dropped or FFmpeg stopped: a new part starts when the ingest is back.
      this.nextAttempt.set(`rec:${streamId}`, Date.now() + (ok ? 2000 : 15_000));
      this.log.warn({ stream: streamId, recording: proc.recordingId, code }, 'recording stopped unexpectedly');
    } else {
      this.log.info({ stream: streamId, recording: proc.recordingId }, 'recording stopped');
    }
    if (!this.closed) this.nudge();
  }

  private stopRecording(streamId: string) {
    const proc = this.recs.get(streamId);
    if (!proc || proc.stopping) return;
    proc.stopping = true;
    // SIGINT lets FFmpeg flush the last fragment.
    proc.child.kill('SIGINT');
    const t = setTimeout(() => proc.child.kill('SIGKILL'), 8000);
    t.unref();
    proc.child.once('close', () => clearTimeout(t));
  }

  /** Recordings left in "recording" by a crash or power loss are closed with the size of their file. */
  private async recoverRecordings() {
    const rows = await this.sql<{ id: string; file: string }[]>`SELECT id, file FROM recordings WHERE status = 'recording'`;
    for (const r of rows) {
      let size = 0;
      try { size = statSync(path.join(recordingsDir(), r.file)).size; } catch { /* missing */ }
      await this.sql`
        UPDATE recordings SET status = ${size > 0 ? 'finished' : 'failed'}, size_bytes = ${size}, ended_at = COALESCE(ended_at, now()),
               error = ${size > 0 ? null : 'interrupted'}
        WHERE id = ${r.id} AND status = 'recording'`;
    }
  }
}
