/** Output platforms and how their publish URL is built. */
export const platforms = ['youtube', 'facebook', 'twitch', 'instagram', 'kick', 'x', 'linkedin', 'rtmp', 'srt'] as const;
export type Platform = (typeof platforms)[number];

/** Platforms a destination can reach through a connected (OAuth) account instead of a stream key. */
export const accountPlatforms = ['youtube', 'facebook', 'twitch'] as const;

export interface PlatformPreset {
  /** Default ingest server; the operator can change it (e.g. YouTube backup ingest). Empty: the platform hands out a URL per broadcast. */
  server: string;
  protocols: readonly ('rtmp' | 'rtmps' | 'srt')[];
  /** True when the platform only works with a stream key. */
  keyRequired: boolean;
  /** True when the server URL must be filled in (it differs per account, region or broadcast). */
  serverRequired: boolean;
  /** What such a server URL looks like (placeholder in the console). */
  serverExample: string;
  /** Recommended video bitrate in kbps, used as default when transcoding. */
  recommendedKbps: number;
  /** Highest video bitrate the platform accepts, in kbps. */
  maxKbps: number;
  /** Highest resolution (short side) and frame rate the platform accepts. */
  maxHeight: 720 | 1080;
  maxFps: 30 | 60;
  /** Picture orientation the platform expects; portrait is 9:16. */
  orientation: 'landscape' | 'portrait';
  /** Encoding mode a new destination starts with. */
  defaultMode: 'copy' | 'transcode';
  /** Audio sample rate the platform asks for. */
  audioSampleRate: 44100 | 48000;
  /** Keyframe interval in seconds the platform asks for. */
  keyframeSeconds: number;
  /** True when the stream key changes for every broadcast (Instagram, LinkedIn, X). */
  keyPerBroadcast: boolean;
}

const base = {
  keyRequired: true, serverRequired: false, serverExample: '', maxHeight: 1080, maxFps: 60, orientation: 'landscape', defaultMode: 'copy',
  audioSampleRate: 48000, keyframeSeconds: 2, keyPerBroadcast: false,
} as const;

/**
 * Presets per platform, checked against the platforms' own guidance in November 2026:
 * Instagram Live Producer (720x1280 portrait, 30 fps, up to 6 Mbps, 44.1 kHz audio), Kick (1080p60, up to 8 Mbps, CBR, H.264 only),
 * X Media Studio Producer (720p30, up to 4 Mbps; 3 s keyframes) and LinkedIn Live custom stream (1080p30, 3.5 to 6 Mbps).
 */
export const presets: Record<Platform, PlatformPreset> = {
  youtube: { ...base, server: 'rtmps://a.rtmps.youtube.com/live2', protocols: ['rtmp', 'rtmps'], recommendedKbps: 9000, maxKbps: 51000 },
  facebook: { ...base, server: 'rtmps://live-api-s.facebook.com:443/rtmp', protocols: ['rtmps'], recommendedKbps: 6000, maxKbps: 9000 },
  twitch: { ...base, server: 'rtmps://live.twitch.tv/app', protocols: ['rtmp', 'rtmps'], recommendedKbps: 6000, maxKbps: 8500 },
  instagram: {
    ...base, server: '', protocols: ['rtmps'], serverRequired: true, serverExample: 'rtmps://edgetee-upload-…fbcdn.net:443/rtmp/',
    recommendedKbps: 4000, maxKbps: 6000, maxHeight: 720, maxFps: 30, orientation: 'portrait', defaultMode: 'transcode',
    audioSampleRate: 44100, keyPerBroadcast: true,
  },
  kick: { ...base, server: '', protocols: ['rtmps'], serverRequired: true, serverExample: 'rtmps://….global-contribute.live-video.net:443/app', recommendedKbps: 6000, maxKbps: 8000 },
  x: {
    ...base, server: '', protocols: ['rtmp', 'rtmps'], serverRequired: true, serverExample: 'rtmps://va.pscp.tv:443/x',
    recommendedKbps: 4000, maxKbps: 4000, maxHeight: 720, maxFps: 30, defaultMode: 'transcode', keyframeSeconds: 3, keyPerBroadcast: true,
  },
  linkedin: {
    ...base, server: '', protocols: ['rtmp', 'rtmps'], serverRequired: true, serverExample: 'rtmps://…/live',
    recommendedKbps: 5000, maxKbps: 6000, maxFps: 30, defaultMode: 'transcode', keyPerBroadcast: true,
  },
  rtmp: { ...base, server: '', protocols: ['rtmp', 'rtmps'], keyRequired: false, serverRequired: true, serverExample: 'rtmp://host/app', recommendedKbps: 6000, maxKbps: 20000 },
  srt: { ...base, server: '', protocols: ['srt'], keyRequired: false, serverRequired: true, serverExample: 'srt://host:port', recommendedKbps: 6000, maxKbps: 20000 },
};

/** SRT stream ids and passphrases are put into the URL as they are, so these characters are refused. */
export const unsafeSrtValue = /[\s&]/;

/** Returns an error code when the server URL is not usable for the platform, otherwise null. */
export function serverUrlProblem(platform: Platform, server: string): string | null {
  if (!server) return presets[platform].serverRequired ? 'server_required' : 'invalid_server_url';
  let u: URL;
  try { u = new URL(server); } catch { return 'invalid_server_url'; }
  const proto = u.protocol.replace(/:$/, '');
  if (!(presets[platform].protocols as readonly string[]).includes(proto)) return 'invalid_server_url';
  if (!u.hostname || u.username || u.password) return 'invalid_server_url';
  // Characters that would let a URL smuggle extra FFmpeg options or break the URL are refused.
  if (/[\s"'`|<>\\]/.test(server)) return 'invalid_server_url';
  return null;
}

/**
 * Builds the URL FFmpeg publishes to. RTMP: <server>/<key>. SRT: the key is sent as streamid,
 * the passphrase as SRT encryption passphrase.
 */
export function publishUrl(platform: Platform, server: string, key: string, passphrase = ''): string {
  if (platform === 'srt') {
    // FFmpeg passes SRT options on literally (no URL decoding), so values are appended as they are;
    // the console refuses '&' and whitespace in them.
    const params = [
      ...(key ? [`streamid=${key}`] : []),
      ...(passphrase ? [`passphrase=${passphrase}`] : []),
      ...(/[?&]pkt_size=/.test(server) ? [] : ['pkt_size=1316']),
    ];
    return params.length ? `${server}${server.includes('?') ? '&' : '?'}${params.join('&')}` : server;
  }
  const b = server.replace(/\/+$/, '');
  return key ? `${b}/${key.replace(/^\/+/, '')}` : b;
}

/** The FFmpeg container for a platform. */
export function outputFormat(platform: Platform): 'flv' | 'mpegts' {
  return platform === 'srt' ? 'mpegts' : 'flv';
}
