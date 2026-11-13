import { connect } from 'node:net';
import { lookup } from 'node:dns/promises';
import { statfsSync } from 'node:fs';
import os from 'node:os';
import type { Sql } from '../db.js';
import { config } from '../config.js';
import { decrypt } from '../lib/crypto.js';
import { getSettings } from '../lib/settings.js';
import { appConfigured, verifyAccount, type AccountRow } from '../platforms/api.js';
import { accountPlatforms, outputFormat, presets, type Platform } from '../media/platforms.js';
import type { MediaSupervisor } from '../media/supervisor.js';
import type { HealthMonitor } from './monitor.js';

export type CheckStatus = 'ok' | 'info' | 'warn' | 'fail';

/**
 * One line of the check before Go live. The console words each code (preflight.c_<code>) with its params;
 * health issues (code "health") reuse the wording of the health page.
 */
export interface Check {
  code: string;
  status: CheckStatus;
  params: Record<string, string | number>;
  destinationId?: string;
  destinationName?: string;
  platform?: Platform;
}

export interface PreflightResult {
  ok: boolean;
  fails: number;
  warnings: number;
  checkedAt: string;
  checks: Check[];
}

interface StreamRow { id: string; name: string; enabled: boolean; record: boolean; auto_record: boolean; backup_key_enc: string | null }
interface DestRow {
  id: string; name: string; platform: Platform; server_url: string; stream_key_enc: string; enabled: boolean; live: boolean;
  mode: 'copy' | 'transcode'; video_bitrate: number; audio_bitrate: number; max_height: number; fps: number | null;
  orientation: 'landscape' | 'portrait'; auth: 'key' | 'account'; account_id: string | null;
}

/** Audio and video FLV carries without re-encoding (same rule as ffmpegArgs). */
const flvAudio = new Set(['MPEG-4 Audio', 'MPEG-1/2 Audio']);

/** Opens a TCP connection to see whether the platform's ingest server answers. SRT runs over UDP, so only its name is resolved. */
export async function reach(url: string, timeoutMs = 3000): Promise<{ ok: true; host: string; ms: number } | { ok: false; host: string; reason: 'dns' | 'refused' | 'timeout' | 'invalid' }> {
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, host: url.slice(0, 60), reason: 'invalid' }; }
  const host = u.hostname;
  const proto = u.protocol.replace(':', '');
  const port = Number(u.port) || (proto === 'rtmps' ? 443 : proto === 'rtmp' ? 1935 : 0);
  const started = Date.now();
  let address: string;
  try {
    address = (await lookup(host)).address;
  } catch {
    return { ok: false, host, reason: 'dns' };
  }
  if (proto === 'srt' || !port) return { ok: true, host, ms: Date.now() - started };
  return new Promise((resolve) => {
    const sock = connect({ host: address, port });
    const done = (r: Awaited<ReturnType<typeof reach>>) => { sock.destroy(); resolve(r); };
    sock.setTimeout(timeoutMs, () => done({ ok: false, host, reason: 'timeout' }));
    sock.once('connect', () => done({ ok: true, host, ms: Date.now() - started }));
    sock.once('error', (err: NodeJS.ErrnoException) => done({ ok: false, host, reason: err.code === 'ECONNREFUSED' ? 'refused' : 'timeout' }));
  });
}

/** Rough CPU cost of transcoding, in cores: about 1.5 cores for 1080p30 with x264 veryfast, scaled by pixels per second. */
export function transcodeCores(height: number, fps: number) {
  const width = (height * 16) / 9;
  return Math.round(((width * height * fps) / (1920 * 1080 * 30)) * 1.5 * 10) / 10;
}

/**
 * Everything worth knowing before pressing Go live: is the feed there and healthy, will each included destination
 * connect (key, account, server reachable), does the feed fit the platform when passed through, and does this
 * server have the CPU, upload and disk for it. Nothing is changed.
 */
export async function preflight(sql: Sql, media: MediaSupervisor, health: HealthMonitor | null, streamId: string): Promise<PreflightResult | null> {
  const [s] = await sql<StreamRow[]>`SELECT id, name, enabled, record, auto_record, backup_key_enc FROM streams WHERE id = ${streamId}`;
  if (!s) return null;
  const settings = await getSettings(sql);
  const dests = await sql<DestRow[]>`
    SELECT id, name, platform, server_url, stream_key_enc, enabled, live, mode, video_bitrate, audio_bitrate, max_height, fps, orientation, auth, account_id
    FROM destinations WHERE stream_id = ${streamId} AND (enabled OR live) ORDER BY position, created_at`;
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  // Media server and the stream itself.
  if (config.media.enabled && !media.mediamtxOnline) add({ code: 'media_down', status: 'fail', params: {} });
  if (!s.enabled) add({ code: 'stream_disabled', status: 'fail', params: {} });

  const ingest = media.ingestState(streamId);
  const snap = health?.snapshot();
  const feedHealth = snap?.feeds.find((f) => f.streamId === streamId && f.input === 'main') ?? null;
  const fps = feedHealth?.nominalFps ?? feedHealth?.fps ?? null;
  const keyframes = feedHealth?.keyframeSeconds ?? null;
  if (ingest.online) {
    add({
      code: 'ingest_ok', status: 'ok',
      params: {
        protocol: ingest.protocol ?? '', resolution: ingest.video?.height ? `${ingest.video.width}x${ingest.video.height}` : '',
        codec: ingest.video?.codec ?? '', kbps: ingest.bitrateKbps ?? 0, fps: fps ?? 0, keyframes: keyframes ?? 0,
      },
    });
    if (ingest.overLimit) add({ code: 'over_limit', status: 'warn', params: { resolution: `${ingest.video?.width}x${ingest.video?.height}` } });
  } else {
    add({ code: 'ingest_offline', status: 'warn', params: {} });
  }
  // What the health monitor sees right now on this stream's feeds and on the server.
  for (const i of health?.issues() ?? []) {
    if (i.destinationId || (i.streamId && i.streamId !== streamId)) continue;
    add({ code: 'health', status: i.severity === 'danger' ? 'fail' : 'warn', params: { issue: i.code, input: i.input ?? '', ...i.params } });
  }

  if (s.backup_key_enc) {
    const b = media.sourceState(streamId).backup;
    add({ code: b.online ? 'backup_ok' : 'backup_offline', status: b.online ? 'ok' : 'info', params: {} });
  } else {
    add({ code: 'backup_none', status: 'info', params: {} });
  }

  // Destinations that go live with "Go live" (included), plus those already live.
  const accounts = new Map((await sql<AccountRow[]>`SELECT * FROM platform_accounts`).map((a) => [a.id, a]));
  const verified = new Map<string, Promise<string | null>>();
  const verify = (a: AccountRow) => {
    if (!verified.has(a.id)) verified.set(a.id, verifyAccount(sql, a, settings).then(() => null, (err: Error) => err.message.slice(0, 200)));
    return verified.get(a.id)!;
  };
  if (!dests.length) add({ code: 'no_destinations', status: 'fail', params: {} });

  let cores = 0;
  let uploadKbps = 0;
  let uploadKnown = true;
  // Destination checks run in parallel; each keeps its own list so the order stays that of the destinations.
  const perDest: Check[][] = dests.map(() => []);
  await Promise.all(dests.map(async (d, idx) => {
    const add = (c: Check) => perDest[idx]!.push(c);
    const who = { destinationId: d.id, destinationName: d.name, platform: d.platform };
    const preset = presets[d.platform];
    const flv = outputFormat(d.platform) === 'flv';
    // Connection: key or connected account, and whether the ingest server answers.
    if (d.auth === 'account') {
      const a = d.account_id ? accounts.get(d.account_id) : undefined;
      if (!(accountPlatforms as readonly string[]).includes(d.platform) || !a) add({ ...who, code: 'dest_account_missing', status: 'fail', params: {} });
      else if (!appConfigured(settings, a.provider)) add({ ...who, code: 'dest_app_missing', status: 'fail', params: {} });
      else {
        const err = await verify(a);
        add({ ...who, code: err ? 'dest_account_error' : 'dest_account_ok', status: err ? 'fail' : 'ok', params: { account: a.name, ...(err ? { error: err } : {}) } });
      }
    } else {
      const key = d.stream_key_enc ? decrypt(d.stream_key_enc) : '';
      if (preset.keyRequired && !key) add({ ...who, code: 'dest_no_key', status: 'fail', params: {} });
      else if (!d.server_url) add({ ...who, code: 'dest_no_server', status: 'fail', params: {} });
      else {
        const r = await reach(d.server_url);
        if (r.ok) add({ ...who, code: 'dest_reachable', status: 'ok', params: { host: r.host, ms: r.ms } });
        else add({ ...who, code: `dest_${r.reason === 'dns' ? 'dns' : r.reason === 'invalid' ? 'no_server' : 'unreachable'}`, status: 'fail', params: { host: r.host, reason: r.reason } });
        if (preset.keyPerBroadcast) add({ ...who, code: 'dest_key_per_broadcast', status: 'info', params: {} });
      }
    }

    // Does the feed fit the platform? Passthrough sends the feed as it is.
    const v = ingest.video;
    const forcedVideo = d.mode === 'copy' && flv && v !== null && v.codec !== 'H264';
    const forcedAudio = d.mode === 'copy' && flv && ingest.audio !== null && !flvAudio.has(ingest.audio.codec);
    const transcodes = d.mode === 'transcode' || forcedVideo;
    if (forcedVideo) add({ ...who, code: 'dest_forced_transcode', status: 'warn', params: { codec: v!.codec } });
    else if (forcedAudio) add({ ...who, code: 'dest_audio_transcode', status: 'info', params: { codec: ingest.audio!.codec } });
    if (!transcodes && ingest.online) {
      if (ingest.bitrateKbps && ingest.bitrateKbps > preset.maxKbps * 1.05) add({ ...who, code: 'dest_over_bitrate', status: 'warn', params: { kbps: ingest.bitrateKbps, max: preset.maxKbps } });
      if (v?.height && v.height > preset.maxHeight) add({ ...who, code: 'dest_over_resolution', status: 'warn', params: { height: v.height, max: preset.maxHeight } });
      if (fps && fps > preset.maxFps + 1) add({ ...who, code: 'dest_over_fps', status: 'warn', params: { fps, max: preset.maxFps } });
      if (keyframes && keyframes > preset.keyframeSeconds + 0.5) add({ ...who, code: 'dest_keyframes', status: 'warn', params: { seconds: keyframes, wanted: preset.keyframeSeconds } });
      if (preset.orientation === 'portrait') add({ ...who, code: 'dest_portrait_copy', status: 'warn', params: {} });
    }

    // What it costs this server.
    if (transcodes) {
      const height = Math.min(d.max_height, v?.height ?? d.max_height, preset.maxHeight);
      cores += transcodeCores(height, Math.min(d.fps ?? fps ?? 30, preset.maxFps));
      uploadKbps += d.video_bitrate + d.audio_bitrate;
    } else if (ingest.bitrateKbps) {
      uploadKbps += ingest.bitrateKbps;
    } else {
      uploadKnown = false;
    }
  }));
  for (const list of perDest) checks.push(...list);

  // CPU: what is free now against what the transcoded destinations will take (those already live are already counted in the load).
  const totalCores = os.cpus().length || 1;
  const busy = ((snap?.server.cpuPercent ?? 0) / 100) * totalCores;
  const liveCores = dests.filter((d) => d.live && d.mode === 'transcode').reduce((n, d) => n + transcodeCores(Math.min(d.max_height, presets[d.platform].maxHeight), Math.min(d.fps ?? 30, presets[d.platform].maxFps)), 0);
  const needed = Math.max(0, Math.round((cores - liveCores) * 10) / 10);
  const free = Math.max(0, Math.round((totalCores - busy - 0.5) * 10) / 10);
  if (cores > 0) add({ code: needed > free ? 'cpu_tight' : 'cpu_ok', status: needed > free ? 'warn' : 'ok', params: { needed, free, cores: totalCores } });

  // Upload: the sum of what all destinations send, with about 5 % protocol overhead.
  const totalMbps = Math.round((uploadKbps * 1.05) / 100) / 10;
  const capMbps = settings.health.uploadMbps;
  if (dests.length) {
    if (!capMbps) add({ code: uploadKnown ? 'upload_total' : 'upload_unknown', status: 'info', params: { mbps: totalMbps } });
    else {
      const pct = Math.round((totalMbps / capMbps) * 100);
      add({ code: pct > 100 ? 'upload_over' : pct > 85 ? 'upload_tight' : 'upload_ok', status: pct > 100 ? 'fail' : pct > 85 ? 'warn' : 'ok', params: { mbps: totalMbps, capacity: capMbps, percent: pct } });
    }
  }

  // Disk, when this broadcast will be recorded.
  if (s.record || s.auto_record) {
    try {
      const fs = statfsSync(config.dataDir);
      const gb = Math.round(((fs.bavail * fs.bsize) / 1024 ** 3) * 10) / 10;
      add({ code: gb < 1 ? 'disk_full' : gb < 5 ? 'disk_low' : 'disk_ok', status: gb < 1 ? 'fail' : gb < 5 ? 'warn' : 'ok', params: { gb } });
    } catch { /* no data dir yet: recordings create it */ }
  }

  const rank: Record<CheckStatus, number> = { fail: 0, warn: 1, info: 2, ok: 3 };
  checks.sort((a, b) => rank[a.status] - rank[b.status]);
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warnings = checks.filter((c) => c.status === 'warn').length;
  return { ok: fails === 0, fails, warnings, checkedAt: new Date().toISOString(), checks };
}
