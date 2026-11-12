/** Output platforms supported in phase 1 and how their publish URL is built. */
export const platforms = ['youtube', 'facebook', 'twitch', 'rtmp', 'srt'] as const;
export type Platform = (typeof platforms)[number];

export interface PlatformPreset {
  /** Default ingest server; the operator can change it (e.g. YouTube backup ingest). */
  server: string;
  protocols: readonly ('rtmp' | 'rtmps' | 'srt')[];
  /** True when the platform only works with a stream key. */
  keyRequired: boolean;
  /** Recommended maximum video bitrate in kbps for 1080p50, used as default when transcoding. */
  recommendedKbps: number;
}

export const presets: Record<Platform, PlatformPreset> = {
  youtube: { server: 'rtmps://a.rtmps.youtube.com/live2', protocols: ['rtmp', 'rtmps'], keyRequired: true, recommendedKbps: 9000 },
  facebook: { server: 'rtmps://live-api-s.facebook.com:443/rtmp', protocols: ['rtmps'], keyRequired: true, recommendedKbps: 6000 },
  twitch: { server: 'rtmps://live.twitch.tv/app', protocols: ['rtmp', 'rtmps'], keyRequired: true, recommendedKbps: 6000 },
  rtmp: { server: '', protocols: ['rtmp', 'rtmps'], keyRequired: false, recommendedKbps: 6000 },
  srt: { server: '', protocols: ['srt'], keyRequired: false, recommendedKbps: 6000 },
};

/** SRT stream ids and passphrases are put into the URL as they are, so these characters are refused. */
export const unsafeSrtValue = /[\s&]/;

/** Returns an error code when the server URL is not usable for the platform, otherwise null. */
export function serverUrlProblem(platform: Platform, server: string): string | null {
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
  const base = server.replace(/\/+$/, '');
  return key ? `${base}/${key.replace(/^\/+/, '')}` : base;
}

/** The FFmpeg container for a platform. */
export function outputFormat(platform: Platform): 'flv' | 'mpegts' {
  return platform === 'srt' ? 'mpegts' : 'flv';
}
