import { outputFormat, publishUrl, type Platform } from './platforms.js';

export interface OutputSpec {
  platform: Platform;
  serverUrl: string;
  streamKey: string;
  passphrase: string;
  mode: 'copy' | 'transcode';
  videoBitrate: number;
  audioBitrate: number;
  maxHeight: number;
  fps: number | null;
}

export interface SourceInfo {
  /** MediaMTX codec names, e.g. "H264", "MPEG-4 Audio", "Opus". */
  videoCodec: string | null;
  audioCodec: string | null;
}

/** Audio codecs FLV (RTMP) carries without re-encoding. */
const flvAudio = new Set(['MPEG-4 Audio', 'MPEG-1/2 Audio']);
/** Video codecs that classic RTMP platforms accept. */
const flvVideo = new Set(['H264']);

/**
 * FFmpeg arguments for one output. The input is the local RTSP feed of the ingest, so FFmpeg never
 * talks to the encoder directly. No shell is involved: arguments are passed as an array.
 */
export function ffmpegArgs(input: string, out: OutputSpec, src: SourceInfo): string[] {
  const fmt = outputFormat(out.platform);
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'warning',
    '-progress', 'pipe:1', '-stats_period', '2',
    '-rtsp_transport', 'tcp', '-timeout', '10000000',
    '-i', input,
    '-map', '0:v:0?', '-map', '0:a:0?',
  ];

  const transcodeVideo = out.mode === 'transcode' || (fmt === 'flv' && src.videoCodec !== null && !flvVideo.has(src.videoCodec));
  if (transcodeVideo) {
    const fps = out.fps ?? 50;
    const kbps = out.videoBitrate;
    args.push(
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      '-vf', `scale=-2:'min(${out.maxHeight},ih)'`,
      '-r', String(fps), '-g', String(fps * 2), '-keyint_min', String(fps * 2), '-sc_threshold', '0',
      '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`,
    );
  } else {
    args.push('-c:v', 'copy');
  }

  const transcodeAudio = out.mode === 'transcode' || (fmt === 'flv' && src.audioCodec !== null && !flvAudio.has(src.audioCodec));
  if (transcodeAudio) args.push('-c:a', 'aac', '-b:a', `${out.audioBitrate}k`, '-ar', '48000', '-ac', '2');
  else args.push('-c:a', 'copy');

  if (fmt === 'flv') args.push('-flvflags', 'no_duration_filesize', '-f', 'flv');
  else args.push('-f', 'mpegts');
  args.push(publishUrl(out.platform, out.serverUrl, out.streamKey, out.passphrase));
  return args;
}

/** Hides secrets (stream key, SRT passphrase) in a URL or log line before it is stored or shown. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('••••');
  }
  return out;
}

export interface Progress {
  bitrateKbps: number | null;
  fps: number | null;
  speed: number | null;
  totalBytes: number | null;
}

/** Parses one block of `-progress` output (key=value lines). */
export function parseProgress(block: string): Progress {
  const kv = Object.fromEntries(block.split('\n').map((l) => l.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const num = (v: string | undefined) => (v === undefined || v === 'N/A' || v === '' ? null : Number.parseFloat(v));
  const bitrate = kv.bitrate?.endsWith('kbits/s') ? num(kv.bitrate.replace('kbits/s', '')) : null;
  return {
    bitrateKbps: bitrate !== null && Number.isFinite(bitrate) ? Math.round(bitrate) : null,
    fps: num(kv.fps),
    speed: kv.speed ? num(kv.speed.replace('x', '')) : null,
    totalBytes: num(kv.total_size),
  };
}
