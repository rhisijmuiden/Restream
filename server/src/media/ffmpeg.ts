import { outputFormat, presets, publishUrl, type Platform } from './platforms.js';

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
  /** Portrait crops the middle 9:16 of the picture (only when transcoding). */
  orientation: 'landscape' | 'portrait';
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
    const fps = Math.min(out.fps ?? 50, presets[out.platform].maxFps);
    const filter = out.orientation === 'portrait' ? `crop='min(iw,ih*9/16)':'min(ih,iw*16/9)',${portraitScale(out.maxHeight)}` : `scale=-2:'min(${out.maxHeight},ih)'`;
    args.push('-vf', filter, ...x264(out.videoBitrate, fps, presets[out.platform].keyframeSeconds));
  } else {
    args.push('-c:v', 'copy');
  }

  const transcodeAudio = out.mode === 'transcode' || (fmt === 'flv' && src.audioCodec !== null && !flvAudio.has(src.audioCodec));
  if (transcodeAudio) args.push(...aac(out));
  else args.push('-c:a', 'copy');

  args.push(...muxer(out));
  return args;
}

/** 9:16 output whose short side is the chosen resolution (720 → 720x1280). */
function portraitScale(short: number) {
  const even = (n: number) => Math.round(n / 2) * 2;
  return `scale=${even(short)}:${even((short * 16) / 9)},setsar=1`;
}

/** H.264 at a constant bitrate with a fixed keyframe interval, as all platforms ask for. */
function x264(kbps: number, fps: number, keyframeSeconds: number) {
  const gop = String(Math.round(fps * keyframeSeconds));
  return [
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-r', String(fps), '-g', gop, '-keyint_min', gop, '-sc_threshold', '0',
    '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`, '-x264-params', 'nal-hrd=cbr',
  ];
}

function aac(out: OutputSpec) {
  return ['-c:a', 'aac', '-b:a', `${out.audioBitrate}k`, '-ar', String(presets[out.platform].audioSampleRate), '-ac', '2'];
}

function muxer(out: OutputSpec) {
  const fmt = outputFormat(out.platform);
  return [
    ...(fmt === 'flv' ? ['-flvflags', 'no_duration_filesize', '-f', 'flv'] : ['-f', 'mpegts']),
    publishUrl(out.platform, out.serverUrl, out.streamKey, out.passphrase),
  ];
}

/**
 * FFmpeg arguments that keep a destination on air with a still image and silence while no ingest is available.
 * The image is fitted (letterboxed) into the size the destination last carried, so the platform sees the same format.
 */
export function fallbackArgs(image: string, out: OutputSpec, size: { height: number; fps: number }): string[] {
  const even = (n: number) => Math.round(n / 2) * 2;
  const short = Math.min(size.height, out.mode === 'transcode' ? out.maxHeight : 1080, presets[out.platform].maxHeight);
  const portrait = out.orientation === 'portrait' && out.mode === 'transcode';
  const [w, h] = portrait ? [even(short), even((short * 16) / 9)] : [even((short * 16) / 9), even(short)];
  const fps = Math.min(out.fps ?? size.fps, presets[out.platform].maxFps);
  // A still image needs little bitrate; staying well under the destination's rate keeps the platform's buffer happy.
  const kbps = Math.max(500, Math.min(out.videoBitrate, 2500));
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'warning',
    '-progress', 'pipe:1', '-stats_period', '2',
    '-re', '-loop', '1', '-framerate', String(fps), '-i', image,
    '-re', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-map', '0:v:0', '-map', '1:a:0',
    '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x070A12,setsar=1,format=yuv420p`,
    ...x264(kbps, fps, presets[out.platform].keyframeSeconds),
    ...aac({ ...out, audioBitrate: 128 }),
    ...muxer(out),
  ];
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
  /** Media time written so far, in microseconds. */
  outTimeUs: number | null;
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
    outTimeUs: num(kv.out_time_us ?? kv.out_time_ms),
  };
}

/** Audio codecs an MP4 recording keeps as they are. */
const mp4Audio = new Set(['MPEG-4 Audio', 'MPEG-1/2 Audio', 'Opus', 'AC-3']);
const mp4Video = new Set(['H264', 'H265', 'AV1', 'VP9']);

/**
 * FFmpeg arguments for a recording: the ingest is copied into a fragmented MP4, which stays playable
 * when the recording is cut off (power loss, ingest drop) and can be downloaded while it grows.
 */
export function recordArgs(input: string, src: SourceInfo, file: string): string[] {
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'warning',
    '-progress', 'pipe:1', '-stats_period', '2',
    '-rtsp_transport', 'tcp', '-timeout', '10000000',
    '-i', input,
    '-map', '0:v:0?', '-map', '0:a:0?',
  ];
  if (src.videoCodec === null || mp4Video.has(src.videoCodec)) {
    args.push('-c:v', 'copy');
    // Apple players need the hvc1 tag for HEVC in MP4.
    if (src.videoCodec === 'H265') args.push('-tag:v', 'hvc1');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
  }
  if (src.audioCodec === null || mp4Audio.has(src.audioCodec)) args.push('-c:a', 'copy');
  else args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
  args.push('-f', 'mp4', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '2000000', '-y', file);
  return args;
}

/**
 * Light console preview for WebRTC: re-encodes the feed without B-frames (which MediaMTX refuses over WebRTC)
 * at up to 540p and 30 fps, with Opus audio (WebRTC carries no AAC). About half a CPU core while someone watches.
 */
export function previewArgs(input: string, output: string): string[] {
  return [
    '-hide_banner', '-nostats', '-loglevel', 'warning',
    '-rtsp_transport', 'tcp', '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', "scale=-2:'min(540,ih)'", '-fpsmax', '30',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-bf', '0', '-pix_fmt', 'yuv420p',
    '-b:v', '1500k', '-maxrate', '1500k', '-bufsize', '1500k', '-g', '60',
    '-c:a', 'libopus', '-b:a', '96k', '-ar', '48000', '-ac', '2',
    '-f', 'rtsp', '-rtsp_transport', 'tcp', output,
  ];
}
