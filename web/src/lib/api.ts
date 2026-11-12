export class ApiError extends Error {
  /** `detail` is the technical reason from the server (e.g. the reply of a mail or FTP server). */
  constructor(public status: number, public code: string, public detail?: string) { super(code); }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    credentials: 'same-origin',
    headers: { 'x-restream': '1', ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'request_failed', data?.detail);
  return data as T;
}

export type Role = 'admin' | 'operator' | 'viewer';
export interface Me {
  instanceName: string;
  defaultLanguage: 'en' | 'nl';
  ssoEnabled: boolean;
  stage: 'mfa' | 'mfa_setup' | 'full' | null;
  user: null | {
    id: string; email: string; name: string; role: Role; language: 'en' | 'nl';
    totp_enabled: boolean; must_change_password: boolean; auth_source: 'local' | 'microsoft'; recovery_left: number;
  };
}
export interface SystemInfo {
  version: string; commit: string; branch: string; channel: 'production' | 'test'; builtAt: string | null;
  node: string; postgres: string; os: string; hostname: string; uptimeSeconds: number; repository: string; updaterEnabled: boolean;
  mediamtx: string | null; ffmpeg: string | null;
}

export type Platform = 'youtube' | 'facebook' | 'twitch' | 'rtmp' | 'srt';
export type OutputStateName = 'off' | 'waiting' | 'preparing' | 'connecting' | 'live' | 'reconnecting';
export interface IngestStatus {
  online: boolean; since: string | null; protocol: string | null;
  video: { codec: string; width: number | null; height: number | null } | null;
  audio: { codec: string; sampleRate: number | null; channels: number | null } | null;
  bitrateKbps: number | null; readers: number; overLimit: boolean;
}
export interface Destination {
  id: string; name: string; platform: Platform; serverUrl: string; streamKeyMasked: string; passphraseSet: boolean;
  enabled: boolean; mode: 'copy' | 'transcode'; videoBitrate: number; audioBitrate: number; maxHeight: 480 | 720 | 1080; fps: 25 | 30 | 50 | 60 | null;
  live: boolean; liveSince: string | null;
  auth: 'key' | 'account'; account: { id: string; name: string; imageUrl: string; status: string } | null;
  privacy: Privacy; watchUrl: string | null;
  status: { state: OutputStateName; since: string | null; bitrateKbps: number | null; fps: number | null; speed: number | null; attempts: number; lastError: string | null };
}
export type Privacy = 'public' | 'unlisted' | 'private';
export interface RecordingState {
  state: 'off' | 'waiting' | 'recording'; recordingId: string | null; since: string | null; sizeBytes: number; durationSeconds: number; lastError: string | null;
}
export interface Stream {
  id: string; name: string; enabled: boolean; playbackEnabled: boolean; playbackId: string; createdAt: string;
  allowedDomains: string[]; requireToken: boolean; record: boolean; autoRecord: boolean; title: string; description: string;
  recording: RecordingState;
  ingest: { rtmpServer: string; streamKey: string | null; rtmpUrl: string | null; srtUrl: string | null };
  playback: { hls: string; whep: string; hlsPage: string; webrtcPage: string; embed: string };
  status: IngestStatus;
  destinations: Destination[];
}
export interface StreamsResponse { mediaEnabled: boolean; mediamtxOnline: boolean; streams: Stream[] }
export interface PlatformPreset { server: string; protocols: string[]; keyRequired: boolean; recommendedKbps: number }

export type OAuthProvider = 'youtube' | 'facebook' | 'twitch';
export interface Account {
  id: string; provider: OAuthProvider; name: string; handle: string; imageUrl: string; status: 'ok' | 'error'; lastError: string | null;
  createdAt: string; destinations: number;
}
export interface AccountsResponse { publicUrlSet: boolean; apps: Record<OAuthProvider, { configured: boolean }>; accounts: Account[] }
export type OAuthApps = Record<OAuthProvider, { clientId: string; clientSecretSet: boolean; redirectUri: string }>;

export interface Recording {
  id: string; streamId: string | null; streamName: string; eventId: string | null; title: string; status: 'recording' | 'finished' | 'failed';
  sizeBytes: number; durationSeconds: number; video: string | null; audio: string | null; error: string | null;
  startedAt: string; endedAt: string | null; startedBy: string | null; fileName: string;
}
export interface RecordingsResponse { retentionDays: number; disk: { totalBytes: number; freeBytes: number } | null; usedBytes: number; recordings: Recording[] }

export type EventStatus = 'scheduled' | 'live' | 'ended' | 'cancelled';
export interface EventTarget {
  destinationId: string; name: string; platform: Platform; viaAccount: boolean;
  status: 'pending' | 'registered' | 'used' | 'skipped' | 'failed'; watchUrl: string | null; error: string | null;
}
export interface LiveEvent {
  id: string; streamId: string; streamName: string | null; title: string; description: string; startsAt: string; endsAt: string | null;
  autoStart: boolean; autoStop: boolean; record: boolean; privacy: Privacy; status: EventStatus; startedAt: string | null; endedAt: string | null;
  targets: EventTarget[];
}
