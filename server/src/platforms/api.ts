import type { Sql } from '../db.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { getSettings, type OAuthProvider, type Settings } from '../lib/settings.js';

/**
 * Platform endpoints. Mutable so the tests can point them at a local fake.
 * Checked against the platform documentation in November 2026 (Graph API v26.0, YouTube Data API v3, Twitch Helix).
 */
export const endpoints = {
  googleAuth: 'https://accounts.google.com/o/oauth2/v2/auth',
  googleToken: 'https://oauth2.googleapis.com/token',
  youtube: 'https://www.googleapis.com/youtube/v3',
  facebookDialog: 'https://www.facebook.com/v26.0/dialog/oauth',
  facebookGraph: 'https://graph.facebook.com/v26.0',
  twitchAuth: 'https://id.twitch.tv/oauth2',
  twitchApi: 'https://api.twitch.tv/helix',
};

export const scopes: Record<OAuthProvider, string> = {
  // Manage the channel's live broadcasts (and later read live chat and viewer counts).
  youtube: 'https://www.googleapis.com/auth/youtube',
  // Pages the user manages, and posting live videos on them.
  facebook: 'pages_show_list,pages_read_engagement,pages_manage_posts,publish_video',
  twitch: 'channel:read:stream_key channel:manage:broadcast channel:manage:schedule',
};

export class PlatformError extends Error {
  constructor(public provider: OAuthProvider, message: string, public status = 0) { super(message); }
}

interface CallOpts {
  method?: string;
  token?: string;
  json?: unknown;
  form?: Record<string, string>;
  headers?: Record<string, string>;
}

/** Calls a platform API and returns the JSON body; non-2xx answers become a PlatformError with the platform's message. */
export async function call<T = Record<string, unknown>>(provider: OAuthProvider, url: string, o: CallOpts = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...o.headers };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  let body: string | undefined;
  if (o.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.json); }
  if (o.form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(o.form).toString(); }
  let res: Response;
  try {
    res = await fetch(url, { method: o.method ?? (body ? 'POST' : 'GET'), headers, body, signal: AbortSignal.timeout(15000) });
  } catch (err) {
    throw new PlatformError(provider, `cannot reach ${new URL(url).host}: ${(err as Error).message}`);
  }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new PlatformError(provider, errorMessage(data) ?? `HTTP ${res.status}`, res.status);
  return (data ?? {}) as T;
}

function errorMessage(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const e = d.error;
  if (typeof e === 'string') return typeof d.error_description === 'string' ? `${e}: ${d.error_description}` : typeof d.message === 'string' ? `${e}: ${d.message}` : e;
  if (e && typeof e === 'object') {
    const eo = e as Record<string, unknown>;
    const reason = Array.isArray(eo.errors) && eo.errors[0] && typeof eo.errors[0] === 'object' ? (eo.errors[0] as Record<string, unknown>).reason : null;
    return [eo.message, reason].filter(Boolean).join(' · ') || null;
  }
  return typeof d.message === 'string' ? d.message : null;
}

export function appConfigured(s: Settings, p: OAuthProvider) {
  return !!(s.platforms[p].clientId && s.platforms[p].clientSecretEnc);
}

// ---------------------------------------------------------------------------------------------
// OAuth

export function redirectUri(s: Settings, p: OAuthProvider) {
  return `${s.publicUrl.replace(/\/+$/, '')}/api/accounts/oauth/${p}/callback`;
}

export function authorizeUrl(s: Settings, p: OAuthProvider, state: string, challenge: string): string {
  const app = s.platforms[p];
  const common = { client_id: app.clientId, redirect_uri: redirectUri(s, p), response_type: 'code', state };
  if (p === 'youtube') {
    return `${endpoints.googleAuth}?${new URLSearchParams({
      ...common, scope: scopes.youtube, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
      code_challenge: challenge, code_challenge_method: 'S256',
    })}`;
  }
  if (p === 'facebook') return `${endpoints.facebookDialog}?${new URLSearchParams({ ...common, scope: scopes.facebook })}`;
  return `${endpoints.twitchAuth}/authorize?${new URLSearchParams({ ...common, scope: scopes.twitch, force_verify: 'true' })}`;
}

/** An identity that becomes a connected account: a YouTube channel, a Facebook page or a Twitch channel. */
export interface Identity {
  externalId: string;
  name: string;
  handle: string;
  imageUrl: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date | null;
  scopes: string;
}

interface TokenReply { access_token: string; refresh_token?: string; expires_in?: number; scope?: string | string[] }
const expiry = (sec?: number) => (sec ? new Date(Date.now() + sec * 1000) : null);
const scopeText = (v: TokenReply['scope']) => (Array.isArray(v) ? v.join(' ') : v ?? '');

/** Exchanges the authorization code and returns the identities it gives access to. */
export async function exchangeCode(s: Settings, p: OAuthProvider, code: string, verifier: string): Promise<Identity[]> {
  const app = s.platforms[p];
  const secret = decrypt(app.clientSecretEnc);
  if (p === 'youtube') {
    const t = await call<TokenReply>(p, endpoints.googleToken, { form: {
      code, client_id: app.clientId, client_secret: secret, redirect_uri: redirectUri(s, p), grant_type: 'authorization_code', code_verifier: verifier,
    } });
    const ch = await call<{ items?: { id: string; snippet: { title: string; customUrl?: string; thumbnails?: { default?: { url: string } } } }[] }>(
      p, `${endpoints.youtube}/channels?part=snippet&mine=true`, { token: t.access_token });
    if (!ch.items?.length) throw new PlatformError(p, 'no_channel');
    return ch.items.map((c) => ({
      externalId: c.id, name: c.snippet.title, handle: c.snippet.customUrl ?? '', imageUrl: c.snippet.thumbnails?.default?.url ?? '',
      accessToken: t.access_token, refreshToken: t.refresh_token ?? '', expiresAt: expiry(t.expires_in), scopes: scopeText(t.scope),
    }));
  }
  if (p === 'facebook') {
    const short = await call<TokenReply>(p, `${endpoints.facebookGraph}/oauth/access_token?${new URLSearchParams({
      client_id: app.clientId, client_secret: secret, redirect_uri: redirectUri(s, p), code,
    })}`);
    // A long-lived user token gives page tokens that do not expire.
    const long = await call<TokenReply>(p, `${endpoints.facebookGraph}/oauth/access_token?${new URLSearchParams({
      grant_type: 'fb_exchange_token', client_id: app.clientId, client_secret: secret, fb_exchange_token: short.access_token,
    })}`);
    const pages = await call<{ data?: { id: string; name: string; access_token: string; picture?: { data?: { url: string } } }[] }>(
      p, `${endpoints.facebookGraph}/me/accounts?${new URLSearchParams({ fields: 'id,name,access_token,picture{url}', limit: '100' })}`, { token: long.access_token });
    if (!pages.data?.length) throw new PlatformError(p, 'no_pages');
    return pages.data.map((pg) => ({
      externalId: pg.id, name: pg.name, handle: '', imageUrl: pg.picture?.data?.url ?? '',
      accessToken: pg.access_token, refreshToken: '', expiresAt: null, scopes: scopes.facebook,
    }));
  }
  const t = await call<TokenReply>(p, `${endpoints.twitchAuth}/token`, { form: {
    client_id: app.clientId, client_secret: secret, code, grant_type: 'authorization_code', redirect_uri: redirectUri(s, p),
  } });
  const u = await call<{ data: { id: string; login: string; display_name: string; profile_image_url: string }[] }>(
    p, `${endpoints.twitchApi}/users`, { token: t.access_token, headers: { 'client-id': app.clientId } });
  const me = u.data?.[0];
  if (!me) throw new PlatformError(p, 'no_channel');
  return [{
    externalId: me.id, name: me.display_name, handle: me.login, imageUrl: me.profile_image_url,
    accessToken: t.access_token, refreshToken: t.refresh_token ?? '', expiresAt: expiry(t.expires_in), scopes: scopeText(t.scope),
  }];
}

export interface AccountRow {
  id: string; provider: OAuthProvider; external_id: string; name: string; handle: string; image_url: string;
  access_token_enc: string; refresh_token_enc: string; expires_at: Date | null; status: 'ok' | 'error'; last_error: string | null;
}

/** A valid access token for the account, refreshed when it (nearly) expired. Marks the account on failure. */
export async function accessToken(sql: Sql, a: AccountRow, s?: Settings): Promise<string> {
  if (!a.expires_at || a.expires_at.getTime() - Date.now() > 120_000 || !a.refresh_token_enc) return decrypt(a.access_token_enc);
  const settings = s ?? await getSettings(sql);
  const app = settings.platforms[a.provider];
  try {
    if (!app.clientId || !app.clientSecretEnc) throw new PlatformError(a.provider, 'app_not_configured');
    const form = { grant_type: 'refresh_token', refresh_token: decrypt(a.refresh_token_enc), client_id: app.clientId, client_secret: decrypt(app.clientSecretEnc) };
    const t = await call<TokenReply>(a.provider, a.provider === 'youtube' ? endpoints.googleToken : `${endpoints.twitchAuth}/token`, { form });
    const exp = expiry(t.expires_in);
    await sql`
      UPDATE platform_accounts SET access_token_enc = ${encrypt(t.access_token)},
             refresh_token_enc = ${t.refresh_token ? encrypt(t.refresh_token) : a.refresh_token_enc},
             expires_at = ${exp}, status = 'ok', last_error = NULL, updated_at = now()
      WHERE id = ${a.id}`;
    a.access_token_enc = encrypt(t.access_token);
    a.expires_at = exp;
    return t.access_token;
  } catch (err) {
    const msg = (err as Error).message;
    await sql`UPDATE platform_accounts SET status = 'error', last_error = ${`refresh: ${msg}`.slice(0, 300)}, updated_at = now() WHERE id = ${a.id}`;
    throw err instanceof PlatformError ? err : new PlatformError(a.provider, msg);
  }
}

// ---------------------------------------------------------------------------------------------
// Broadcasts

export interface BroadcastInfo {
  title: string;
  description: string;
  /** Planned start; now for an ad-hoc Go live. */
  start: Date;
  end: Date | null;
  privacy: 'public' | 'unlisted' | 'private';
}

const ytTitle = (v: string) => v.replace(/[<>]/g, '').slice(0, 100) || 'Live';
const ytDescription = (v: string) => v.replace(/[<>]/g, '').slice(0, 5000);

export const youtube = {
  /** Returns the publish URL of the destination's reusable YouTube stream, creating the stream when needed. */
  async ensureStream(token: string, existingId: string | null): Promise<{ id: string; url: string }> {
    type Cdn = { ingestionInfo?: { ingestionAddress?: string; rtmpsIngestionAddress?: string; streamName?: string } };
    const urlOf = (cdn: Cdn | undefined) => {
      const i = cdn?.ingestionInfo;
      const addr = i?.rtmpsIngestionAddress || i?.ingestionAddress;
      if (!addr || !i?.streamName) throw new PlatformError('youtube', 'no ingestion info');
      return `${addr.replace(/\/+$/, '')}/${i.streamName}`;
    };
    if (existingId) {
      const r = await call<{ items?: { id: string; cdn: Cdn }[] }>('youtube', `${endpoints.youtube}/liveStreams?part=cdn&id=${encodeURIComponent(existingId)}`, { token });
      if (r.items?.[0]) return { id: r.items[0].id, url: urlOf(r.items[0].cdn) };
    }
    const r = await call<{ id: string; cdn: Cdn }>('youtube', `${endpoints.youtube}/liveStreams?part=snippet,cdn,contentDetails`, {
      token, json: {
        snippet: { title: 'Restream' },
        cdn: { frameRate: 'variable', ingestionType: 'rtmp', resolution: 'variable' },
        contentDetails: { isReusable: true },
      },
    });
    return { id: r.id, url: urlOf(r.cdn) };
  },

  async createBroadcast(token: string, b: BroadcastInfo): Promise<{ id: string; watchUrl: string }> {
    const r = await call<{ id: string }>('youtube', `${endpoints.youtube}/liveBroadcasts?part=snippet,status,contentDetails`, {
      token, json: {
        snippet: { title: ytTitle(b.title), description: ytDescription(b.description), scheduledStartTime: b.start.toISOString(), ...(b.end ? { scheduledEndTime: b.end.toISOString() } : {}) },
        status: { privacyStatus: b.privacy, selfDeclaredMadeForKids: false },
        // YouTube starts the broadcast when the video arrives and ends it when it stops.
        contentDetails: { enableAutoStart: true, enableAutoStop: true, latencyPreference: 'low', monitorStream: { enableMonitorStream: false } },
      },
    });
    return { id: r.id, watchUrl: `https://www.youtube.com/watch?v=${r.id}` };
  },

  async updateBroadcast(token: string, id: string, b: BroadcastInfo) {
    await call('youtube', `${endpoints.youtube}/liveBroadcasts?part=snippet,status`, {
      method: 'PUT', token, json: {
        id,
        snippet: { title: ytTitle(b.title), description: ytDescription(b.description), scheduledStartTime: b.start.toISOString(), ...(b.end ? { scheduledEndTime: b.end.toISOString() } : {}) },
        status: { privacyStatus: b.privacy, selfDeclaredMadeForKids: false },
      },
    });
  },

  async bind(token: string, broadcastId: string, streamId: string) {
    await call('youtube', `${endpoints.youtube}/liveBroadcasts/bind?${new URLSearchParams({ id: broadcastId, streamId, part: 'id,contentDetails' })}`, { method: 'POST', token });
  },

  async end(token: string, broadcastId: string) {
    await call('youtube', `${endpoints.youtube}/liveBroadcasts/transition?${new URLSearchParams({ broadcastStatus: 'complete', id: broadcastId, part: 'status' })}`, { method: 'POST', token });
  },

  async remove(token: string, broadcastId: string) {
    await call('youtube', `${endpoints.youtube}/liveBroadcasts?id=${encodeURIComponent(broadcastId)}`, { method: 'DELETE', token });
  },
};

const fbForm = (b: Partial<BroadcastInfo>) => ({
  ...(b.title !== undefined ? { title: b.title.slice(0, 254) } : {}),
  ...(b.description !== undefined ? { description: b.description.slice(0, 5000) } : {}),
});

export const facebook = {
  /** Live video on a page: LIVE_NOW for Go live, SCHEDULED_UNPUBLISHED (with planned start) for an event. */
  async create(pageId: string, token: string, b: BroadcastInfo, scheduled: boolean): Promise<{ id: string; url: string | null; watchUrl: string }> {
    const r = await call<{ id: string; secure_stream_url?: string; stream_url?: string }>('facebook', `${endpoints.facebookGraph}/${encodeURIComponent(pageId)}/live_videos`, {
      token, form: {
        ...fbForm(b),
        status: scheduled ? 'SCHEDULED_UNPUBLISHED' : 'LIVE_NOW',
        ...(scheduled ? { planned_start_time: String(Math.floor(b.start.getTime() / 1000)) } : {}),
      },
    });
    return { id: r.id, url: r.secure_stream_url ?? r.stream_url ?? null, watchUrl: await facebook.watchUrl(token, r.id) };
  },

  async get(token: string, id: string) {
    return call<{ secure_stream_url?: string; stream_url?: string; permalink_url?: string; status?: string }>('facebook',
      `${endpoints.facebookGraph}/${encodeURIComponent(id)}?fields=secure_stream_url,stream_url,permalink_url,status`, { token });
  },

  async watchUrl(token: string, id: string) {
    try {
      const v = await facebook.get(token, id);
      if (v.permalink_url) return v.permalink_url.startsWith('http') ? v.permalink_url : `https://www.facebook.com${v.permalink_url}`;
    } catch { /* fall back to the plain video link */ }
    return `https://www.facebook.com/${id}`;
  },

  async update(token: string, id: string, b: BroadcastInfo) {
    await call('facebook', `${endpoints.facebookGraph}/${encodeURIComponent(id)}`, {
      token, form: { ...fbForm(b), planned_start_time: String(Math.floor(b.start.getTime() / 1000)) },
    });
  },

  /** Publishes a scheduled live video when its event starts. */
  async goLive(token: string, id: string) {
    await call('facebook', `${endpoints.facebookGraph}/${encodeURIComponent(id)}`, { token, form: { status: 'LIVE_NOW' } });
  },

  async end(token: string, id: string) {
    await call('facebook', `${endpoints.facebookGraph}/${encodeURIComponent(id)}`, { token, form: { end_live_video: 'true' } });
  },

  async remove(token: string, id: string) {
    await call('facebook', `${endpoints.facebookGraph}/${encodeURIComponent(id)}`, { method: 'DELETE', token });
  },
};

export const twitch = {
  headers: (s: Settings) => ({ 'client-id': s.platforms.twitch.clientId }),

  async streamKey(s: Settings, token: string, userId: string): Promise<string> {
    const r = await call<{ data: { stream_key: string }[] }>('twitch', `${endpoints.twitchApi}/streams/key?broadcaster_id=${encodeURIComponent(userId)}`, { token, headers: twitch.headers(s) });
    const key = r.data?.[0]?.stream_key;
    if (!key) throw new PlatformError('twitch', 'no stream key');
    return key;
  },

  async setTitle(s: Settings, token: string, userId: string, title: string) {
    await call('twitch', `${endpoints.twitchApi}/channels?broadcaster_id=${encodeURIComponent(userId)}`, {
      method: 'PATCH', token, headers: twitch.headers(s), json: { title: title.slice(0, 140) || 'Live' },
    });
  },

  segmentBody(b: BroadcastInfo) {
    const minutes = b.end ? Math.round((b.end.getTime() - b.start.getTime()) / 60000) : 120;
    return { start_time: b.start.toISOString(), timezone: 'UTC', duration: String(Math.min(1380, Math.max(30, minutes))), is_recurring: false, title: b.title.slice(0, 140) };
  },

  /** Adds the event to the channel's stream schedule (Twitch Affiliates and Partners). */
  async createSegment(s: Settings, token: string, userId: string, b: BroadcastInfo): Promise<string> {
    const r = await call<{ data: { segments: { id: string }[] } }>('twitch', `${endpoints.twitchApi}/schedule/segment?broadcaster_id=${encodeURIComponent(userId)}`, {
      token, headers: twitch.headers(s), json: twitch.segmentBody(b),
    });
    const id = r.data?.segments?.[0]?.id;
    if (!id) throw new PlatformError('twitch', 'no segment id');
    return id;
  },

  async updateSegment(s: Settings, token: string, userId: string, id: string, b: BroadcastInfo) {
    const { is_recurring: _r, ...body } = twitch.segmentBody(b);
    await call('twitch', `${endpoints.twitchApi}/schedule/segment?${new URLSearchParams({ broadcaster_id: userId, id })}`, {
      method: 'PATCH', token, headers: twitch.headers(s), json: body,
    });
  },

  async removeSegment(s: Settings, token: string, userId: string, id: string) {
    await call('twitch', `${endpoints.twitchApi}/schedule/segment?${new URLSearchParams({ broadcaster_id: userId, id })}`, {
      method: 'DELETE', token, headers: twitch.headers(s),
    });
  },
};
