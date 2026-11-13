import type { Sql } from '../db.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { getSettings, type OAuthProvider, type Settings } from '../lib/settings.js';

/**
 * Platform endpoints. Mutable so the tests can point them at a local fake.
 * Checked against the platform documentation in November 2026 (Graph API v26.0, YouTube Data API v3, Twitch Helix,
 * X API v2 with the Livestream API routes /2/sources and /2/broadcasts).
 */
export const endpoints = {
  googleAuth: 'https://accounts.google.com/o/oauth2/v2/auth',
  googleToken: 'https://oauth2.googleapis.com/token',
  youtube: 'https://www.googleapis.com/youtube/v3',
  youtubeUpload: 'https://www.googleapis.com/upload/youtube/v3',
  facebookDialog: 'https://www.facebook.com/v26.0/dialog/oauth',
  facebookGraph: 'https://graph.facebook.com/v26.0',
  twitchAuth: 'https://id.twitch.tv/oauth2',
  twitchApi: 'https://api.twitch.tv/helix',
  /** Twitch chat (IRC over WebSocket); read anonymously, so no extra scope is needed. */
  twitchChat: 'wss://irc-ws.chat.twitch.tv:443',
  xAuth: 'https://x.com/i/oauth2/authorize',
  xApi: 'https://api.x.com/2',
};

export const scopes: Record<OAuthProvider, string> = {
  // Manage the channel's live broadcasts (and later read live chat and viewer counts).
  youtube: 'https://www.googleapis.com/auth/youtube',
  // Pages the user manages, posting live videos on them, and reading the comments on them (live chat).
  facebook: 'pages_show_list,pages_read_engagement,pages_read_user_content,pages_manage_posts,publish_video',
  twitch: 'channel:read:stream_key channel:manage:broadcast channel:manage:schedule',
  // Who the account is (users/me needs tweet.read and users.read), its stream sources and broadcasts, and a refresh token.
  x: 'tweet.read users.read broadcast.read broadcast.write offline.access',
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
  // X: RFC 7807 problem ({ title, detail }) or { errors: [{ message }] }.
  if (typeof d.detail === 'string') return typeof d.title === 'string' ? `${d.title}: ${d.detail}` : d.detail;
  if (Array.isArray(d.errors) && d.errors[0] && typeof d.errors[0] === 'object') {
    const e0 = d.errors[0] as Record<string, unknown>;
    if (typeof e0.message === 'string') return e0.message;
    if (typeof e0.detail === 'string') return e0.detail;
  }
  if (typeof d.title === 'string') return d.title;
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
  if (p === 'x') {
    return `${endpoints.xAuth}?${new URLSearchParams({ ...common, scope: scopes.x, code_challenge: challenge, code_challenge_method: 'S256' })}`;
  }
  return `${endpoints.twitchAuth}/authorize?${new URLSearchParams({ ...common, scope: scopes.twitch, force_verify: 'true' })}`;
}

/** X takes the client credentials of a confidential client as HTTP Basic authentication. */
function xBasic(s: Settings) {
  const app = s.platforms.x;
  return { authorization: `Basic ${Buffer.from(`${encodeURIComponent(app.clientId)}:${encodeURIComponent(decrypt(app.clientSecretEnc))}`).toString('base64')}` };
}

/** An identity that becomes a connected account: a YouTube channel, a Facebook page, a Twitch channel or an X account. */
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
  if (p === 'x') {
    const t = await call<TokenReply>(p, `${endpoints.xApi}/oauth2/token`, { headers: xBasic(s), form: {
      code, grant_type: 'authorization_code', client_id: app.clientId, redirect_uri: redirectUri(s, p), code_verifier: verifier,
    } });
    const u = await call<{ data?: { id: string; name: string; username: string; profile_image_url?: string } }>(
      p, `${endpoints.xApi}/users/me?user.fields=profile_image_url`, { token: t.access_token });
    if (!u.data?.id) throw new PlatformError(p, 'no_channel');
    return [{
      externalId: u.data.id, name: u.data.name || u.data.username, handle: u.data.username ? `@${u.data.username}` : '', imageUrl: u.data.profile_image_url ?? '',
      accessToken: t.access_token, refreshToken: t.refresh_token ?? '', expiresAt: expiry(t.expires_in), scopes: scopeText(t.scope),
    }];
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
    const refresh = decrypt(a.refresh_token_enc);
    // X rotates the refresh token on every use; the new one is stored below.
    const t = a.provider === 'x'
      ? await call<TokenReply>('x', `${endpoints.xApi}/oauth2/token`, { headers: xBasic(settings), form: { grant_type: 'refresh_token', refresh_token: refresh, client_id: app.clientId } })
      : await call<TokenReply>(a.provider, a.provider === 'youtube' ? endpoints.googleToken : `${endpoints.twitchAuth}/token`, {
        form: { grant_type: 'refresh_token', refresh_token: refresh, client_id: app.clientId, client_secret: decrypt(app.clientSecretEnc) },
      });
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

/**
 * Checks that a connected account still works: refreshes the token when needed and makes one cheap call
 * (YouTube 1 quota unit). Throws a PlatformError with the platform's reason when it does not.
 */
export async function verifyAccount(sql: Sql, a: AccountRow, s: Settings): Promise<void> {
  const token = await accessToken(sql, a, s);
  if (a.provider === 'youtube') await call('youtube', `${endpoints.youtube}/channels?part=id&mine=true`, { token });
  else if (a.provider === 'facebook') await call('facebook', `${endpoints.facebookGraph}/${encodeURIComponent(a.external_id)}?fields=id`, { token });
  else if (a.provider === 'x') await call('x', `${endpoints.xApi}/users/me`, { token });
  else await call('twitch', `${endpoints.twitchApi}/users?id=${encodeURIComponent(a.external_id)}`, { token, headers: { 'client-id': s.platforms.twitch.clientId } });
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

  /**
   * Changes the title and description of a broadcast, also while it is live. The snippet is read first,
   * because YouTube wants its planned start back and would otherwise reset other fields.
   */
  async setInfo(token: string, id: string, title: string, description: string) {
    type Snippet = { title?: string; description?: string; scheduledStartTime?: string; scheduledEndTime?: string };
    const r = await call<{ items?: { snippet?: Snippet }[] }>('youtube', `${endpoints.youtube}/liveBroadcasts?part=snippet&id=${encodeURIComponent(id)}`, { token });
    const cur = r.items?.[0]?.snippet;
    if (!cur) throw new PlatformError('youtube', 'broadcast not found', 404);
    await call('youtube', `${endpoints.youtube}/liveBroadcasts?part=snippet`, {
      method: 'PUT', token, json: {
        id,
        snippet: {
          title: ytTitle(title), description: ytDescription(description),
          ...(cur.scheduledStartTime ? { scheduledStartTime: cur.scheduledStartTime } : {}),
          ...(cur.scheduledEndTime ? { scheduledEndTime: cur.scheduledEndTime } : {}),
        },
      },
    });
  },

  /** Sets the thumbnail of a broadcast (JPEG or PNG, at most 2 MB; the channel must be verified for custom thumbnails). */
  async setThumbnail(token: string, videoId: string, image: Buffer, type: 'png' | 'jpg') {
    let res: Response;
    try {
      res = await fetch(`${endpoints.youtubeUpload}/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': type === 'png' ? 'image/png' : 'image/jpeg' },
        body: new Uint8Array(image), signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new PlatformError('youtube', `cannot reach ${new URL(endpoints.youtubeUpload).host}: ${(err as Error).message}`);
    }
    if (!res.ok) {
      let data: unknown = null;
      try { data = await res.json(); } catch { /* not JSON */ }
      throw new PlatformError('youtube', errorMessage(data) ?? `HTTP ${res.status}`, res.status);
    }
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

  /** Changes only the title and description of a live video (also while it is live). */
  async setInfo(token: string, id: string, title: string, description: string) {
    await call('facebook', `${endpoints.facebookGraph}/${encodeURIComponent(id)}`, { token, form: fbForm({ title, description }) });
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

// ---------------------------------------------------------------------------------------------
// Live viewers and chat (phase 4)

/** A chat message as Restream stores it, whatever platform it came from. */
export interface ChatMessage { id: string; author: string; text: string; at: Date; highlight: string | null }

const clip = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

export const youtubeLive = {
  /** Concurrent viewers and the chat id of a broadcast (videos.list, 1 quota unit). */
  async details(token: string, videoId: string): Promise<{ viewers: number | null; chatId: string | null; ended: boolean }> {
    const r = await call<{ items?: { liveStreamingDetails?: { concurrentViewers?: string; activeLiveChatId?: string; actualEndTime?: string } }[] }>(
      'youtube', `${endpoints.youtube}/videos?part=liveStreamingDetails&id=${encodeURIComponent(videoId)}`, { token });
    const d = r.items?.[0]?.liveStreamingDetails;
    if (!r.items?.length) throw new PlatformError('youtube', 'broadcast not found', 404);
    return { viewers: d?.concurrentViewers !== undefined ? Number(d.concurrentViewers) || 0 : null, chatId: d?.activeLiveChatId ?? null, ended: !!d?.actualEndTime };
  },

  /** New chat messages since pageToken (liveChatMessages.list, 5 quota units). */
  async chat(token: string, chatId: string, pageToken: string | null) {
    type Item = {
      id: string;
      snippet?: { type?: string; publishedAt?: string; displayMessage?: string; textMessageDetails?: { messageText?: string };
        superChatDetails?: { amountDisplayString?: string }; superStickerDetails?: { amountDisplayString?: string } };
      authorDetails?: { displayName?: string };
    };
    const r = await call<{ items?: Item[]; nextPageToken?: string; pollingIntervalMillis?: number; offlineAt?: string }>('youtube',
      `${endpoints.youtube}/liveChat/messages?${new URLSearchParams({ liveChatId: chatId, part: 'snippet,authorDetails', maxResults: '200', ...(pageToken ? { pageToken } : {}) })}`, { token });
    const shown = new Set(['textMessageEvent', 'superChatEvent', 'superStickerEvent', 'memberMilestoneChatEvent', 'newSponsorEvent', 'membershipGiftingEvent']);
    const messages: ChatMessage[] = (r.items ?? [])
      .filter((i) => shown.has(i.snippet?.type ?? 'textMessageEvent'))
      .map((i) => ({
        id: i.id,
        author: clip(i.authorDetails?.displayName, 100) || '?',
        text: clip(i.snippet?.displayMessage ?? i.snippet?.textMessageDetails?.messageText, 1000),
        at: new Date(i.snippet?.publishedAt ?? Date.now()),
        highlight: clip(i.snippet?.superChatDetails?.amountDisplayString ?? i.snippet?.superStickerDetails?.amountDisplayString, 40) || null,
      }))
      .filter((m) => m.text || m.highlight);
    return { messages, nextPageToken: r.nextPageToken ?? pageToken, pollMs: r.pollingIntervalMillis ?? 5000, offline: !!r.offlineAt };
  },
};

export const facebookLive = {
  /** Viewers watching the live video right now. */
  async viewers(token: string, liveVideoId: string): Promise<number> {
    const r = await call<{ live_views?: number }>('facebook', `${endpoints.facebookGraph}/${encodeURIComponent(liveVideoId)}?fields=live_views`, { token });
    return Number(r.live_views ?? 0) || 0;
  },

  /** The newest comments on the live video (needs pages_read_user_content). */
  async comments(token: string, liveVideoId: string): Promise<ChatMessage[]> {
    const r = await call<{ data?: { id: string; message?: string; created_time?: string; from?: { name?: string } }[] }>('facebook',
      `${endpoints.facebookGraph}/${encodeURIComponent(liveVideoId)}/comments?${new URLSearchParams({
        fields: 'id,message,created_time,from{name}', order: 'reverse_chronological', filter: 'stream', live_filter: 'no_filter', limit: '100',
      })}`, { token });
    return (r.data ?? []).map((c) => ({
      id: c.id, author: clip(c.from?.name, 100) || 'Facebook', text: clip(c.message, 1000),
      at: new Date(c.created_time ?? Date.now()), highlight: null,
    })).filter((m) => m.text).reverse();
  },
};

export const twitchLive = {
  /** Viewers of the channel's current stream; 0 while Twitch does not see it live (yet). */
  async viewers(s: Settings, token: string, userId: string): Promise<number> {
    const r = await call<{ data?: { viewer_count?: number }[] }>('twitch', `${endpoints.twitchApi}/streams?user_id=${encodeURIComponent(userId)}`, { token, headers: twitch.headers(s) });
    return Number(r.data?.[0]?.viewer_count ?? 0) || 0;
  },
};

// ---------------------------------------------------------------------------------------------
// X (Livestream API)

/** A broadcast can only go live once X sees video on the source; these answers mean "try again shortly". */
export const xNotReady = (err: unknown) => err instanceof PlatformError && (err.status === 409 || err.status === 404 || err.status === 503);

/** Regions X accepts when creating a source; Europe is served from US East. */
const xRegions = new Set(['us-east-1', 'us-west-2']);

export const x = {
  /** The ingest region X recommends for this server; US East when X does not say. */
  async region(token: string): Promise<string> {
    try {
      const r = await call<{ region?: string; data?: { region?: string } }>('x', `${endpoints.xApi}/region`, { token });
      const v = r.region ?? r.data?.region;
      return v && xRegions.has(v) ? v : 'us-east-1';
    } catch {
      return 'us-east-1';
    }
  },

  /**
   * Returns the publish URL of the destination's reusable X source (Media Studio Producer source), creating it when needed.
   * The stream key only comes with a new source or from the stream_key route, never in other answers.
   */
  async ensureSource(token: string, existingId: string | null, name: string): Promise<{ id: string; url: string }> {
    type Source = { id: string; rtmps_url?: string; rtmp_url?: string; stream_key?: string };
    const urlOf = (src: Source, key: string | undefined) => {
      const server = src.rtmps_url || src.rtmp_url;
      if (!server || !key) throw new PlatformError('x', 'no ingest URL or stream key');
      return `${server.replace(/\/+$/, '')}/${key}`;
    };
    if (existingId) {
      try {
        const src = await call<{ data?: Source }>('x', `${endpoints.xApi}/sources/${encodeURIComponent(existingId)}`, { token });
        const k = await call<{ data?: { stream_key?: string; key?: string } }>('x', `${endpoints.xApi}/sources/${encodeURIComponent(existingId)}/stream_key`, { token });
        if (src.data) return { id: existingId, url: urlOf(src.data, k.data?.stream_key ?? k.data?.key) };
      } catch (err) {
        // Removed in Media Studio: create a new one below.
        if (!(err instanceof PlatformError && err.status === 404)) throw err;
      }
    }
    const region = await x.region(token);
    const r = await call<{ data?: Source }>('x', `${endpoints.xApi}/sources`, { token, json: { name: name.slice(0, 80) || 'Restream', region } });
    if (!r.data?.id) throw new PlatformError('x', 'no source id');
    return { id: r.data.id, url: urlOf(r.data, r.data.stream_key) };
  },

  /** Whether X receives video on the source right now. */
  async sourceActive(token: string, sourceId: string): Promise<boolean> {
    const r = await call<{ data?: { is_stream_active?: boolean } }>('x', `${endpoints.xApi}/sources/${encodeURIComponent(sourceId)}`, { token });
    return !!r.data?.is_stream_active;
  },

  /** Takes the source live: creates and publishes the broadcast in one call (safe to retry; a live source returns its broadcast). */
  async goLive(token: string, sourceId: string, title: string): Promise<{ id: string; watchUrl: string | null }> {
    const r = await call<{ data?: { id?: string; broadcast_id?: string; share_url?: string } }>('x', `${endpoints.xApi}/broadcasts`, {
      token, json: { source_id: sourceId, title: title.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 100) || 'Live' },
    });
    const id = r.data?.id ?? r.data?.broadcast_id;
    if (!id) throw new PlatformError('x', 'no broadcast id');
    return { id, watchUrl: r.data?.share_url ?? null };
  },

  async end(token: string, broadcastId: string) {
    await call('x', `${endpoints.xApi}/broadcasts/${encodeURIComponent(broadcastId)}/state`, { method: 'PUT', token, json: { state: 'END' } });
  },
};
