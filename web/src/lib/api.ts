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

export type Platform = 'youtube' | 'facebook' | 'twitch' | 'instagram' | 'kick' | 'x' | 'linkedin' | 'rtmp' | 'srt';
export type Orientation = 'landscape' | 'portrait';
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
  orientation: Orientation;
  live: boolean; liveSince: string | null;
  auth: 'key' | 'account'; account: { id: string; name: string; imageUrl: string; status: string } | null;
  privacy: Privacy; watchUrl: string | null;
  /** Why a destination on a connected account is not on the platform yet, e.g. x_not_eligible. */
  prepareError: string | null;
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
  backupIngest: { configured: boolean; streamKey: string | null; rtmpUrl: string | null; srtUrl: string | null };
  fallback: { mode: 'off' | 'standard' | 'image'; imageSet: boolean; minutes: number; switchBackSeconds: number };
  source: SourceState;
  playback: { hls: string; whep: string; hlsPage: string; webrtcPage: string; embed: string };
  status: IngestStatus;
  destinations: Destination[];
}
export type SourceName = 'main' | 'backup' | 'fallback' | 'none';
export interface SourceState {
  active: SourceName; since: string | null; fallbackEndsAt: string | null; fallbackExpired: boolean; backupConfigured: boolean; backup: IngestStatus;
}
export interface StreamsResponse { mediaEnabled: boolean; mediamtxOnline: boolean; streams: Stream[] }
export interface PlatformPreset {
  server: string; protocols: string[]; keyRequired: boolean; serverRequired: boolean; serverExample: string;
  recommendedKbps: number; maxKbps: number; maxHeight: 720 | 1080; maxFps: 30 | 60; orientation: Orientation; defaultMode: 'copy' | 'transcode';
  audioSampleRate: number; keyframeSeconds: number; keyPerBroadcast: boolean;
}

export interface ApiKey {
  id: string; name: string; prefix: string; role: Role; createdAt: string; expiresAt: string | null; lastUsedAt: string | null;
  lastUsedIp: string | null; revokedAt: string | null; createdBy: string; active: boolean;
}
export interface Webhook {
  id: string; name: string; url: string; secret: string; events: string[]; enabled: boolean; createdAt: string;
  stats: { delivered: number; failed: number; pending: number; lastAt: string | null; lastStatus: 'pending' | 'delivered' | 'failed' | null; lastError: string | null };
}
export interface WebhookDelivery {
  id: string; eventId: string; event: string; status: 'pending' | 'delivered' | 'failed'; attempts: number; responseCode: number | null; error: string | null;
  durationMs: number | null; createdAt: string; deliveredAt: string | null; nextAttemptAt: string | null; payload: unknown;
}

export type OAuthProvider = 'youtube' | 'facebook' | 'twitch' | 'x';
export interface Account {
  id: string; provider: OAuthProvider; name: string; handle: string; imageUrl: string; status: 'ok' | 'error'; lastError: string | null;
  createdAt: string; destinations: number; missingScopes: string[];
}
export interface AccountsResponse { publicUrlSet: boolean; apps: Record<OAuthProvider, { configured: boolean }>; accounts: Account[] }
export type OAuthApps = Record<OAuthProvider, { clientId: string; clientSecretSet: boolean; redirectUri: string; scopes: string[] }>;

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

export type ChatState = 'off' | 'connecting' | 'on' | 'error' | 'unsupported';
export interface LiveDestination {
  destinationId: string; name: string; platform: Platform; onAir: boolean; supported: boolean;
  viewers: number | null; updatedAt: string | null; error: string | null; chat: ChatState; chatError: string | null;
}
export interface BroadcastOutput {
  id: string; destinationId: string | null; platform: Platform; name: string; watchUrl: string | null; stats: boolean;
  peakViewers: number; avgViewers: number; chatMessages: number;
}
export interface Broadcast {
  id: string; streamId: string | null; streamName: string; eventId: string | null; title: string;
  startedAt: string; endedAt: string | null; live: boolean; durationSeconds: number;
  peakViewers: number; avgViewers: number; chatMessages: number; currentViewers: number | null; outputs: BroadcastOutput[];
}
export interface BroadcastDetail extends Broadcast { series: { at: string; total: number; outputs: Record<string, number> }[] }
export interface ChatMessage { seq: number; outputId: string; destination: string; platform: Platform; author: string; text: string; highlight: string | null; at: string }
export interface LiveResponse { broadcast: Broadcast | null; destinations: LiveDestination[]; totalViewers: number | null; chat: ChatMessage[]; cursor: number }
