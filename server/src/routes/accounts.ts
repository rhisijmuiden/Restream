import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { config } from '../config.js';
import { HttpError, requireAuth } from '../lib/guards.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { getSettings, oauthProviders, setSettings, type OAuthProvider } from '../lib/settings.js';
import { appConfigured, authorizeUrl, exchangeCode, PlatformError, redirectUri } from '../platforms/api.js';

const FLOW_COOKIE = 'restream_oauth';
const providerParam = z.object({ provider: z.enum(oauthProviders) });

interface Flow { p: OAuthProvider; state: string; verifier: string; user: string; session: string; t: number }

/**
 * Connected accounts: YouTube channels, Facebook pages and Twitch channels, linked with OAuth.
 * Administrators register the OAuth app of each platform once; operators connect and remove accounts.
 */
export async function accountRoutes(app: FastifyInstance, { sql }: { sql: Sql }) {
  const viewer = { preHandler: requireAuth('viewer') };
  const operator = { preHandler: requireAuth('operator') };
  const admin = { preHandler: requireAuth('admin') };

  app.get('/api/accounts', viewer, async () => {
    const s = await getSettings(sql);
    const rows = await sql<{ id: string; provider: OAuthProvider; name: string; handle: string; image_url: string; status: string; last_error: string | null; created_at: Date; uses: number }[]>`
      SELECT a.id, a.provider, a.name, a.handle, a.image_url, a.status, a.last_error, a.created_at,
             (SELECT count(*)::int FROM destinations d WHERE d.account_id = a.id) AS uses
      FROM platform_accounts a ORDER BY a.provider, a.name`;
    return {
      publicUrlSet: !!s.publicUrl,
      apps: Object.fromEntries(oauthProviders.map((p) => [p, { configured: appConfigured(s, p) }])),
      accounts: rows.map((r) => ({
        id: r.id, provider: r.provider, name: r.name, handle: r.handle, imageUrl: r.image_url, status: r.status,
        lastError: r.last_error, createdAt: r.created_at, destinations: r.uses,
      })),
    };
  });

  app.get('/api/accounts/apps', admin, async () => {
    const s = await getSettings(sql);
    return Object.fromEntries(oauthProviders.map((p) => [p, {
      clientId: s.platforms[p].clientId,
      clientSecretSet: !!s.platforms[p].clientSecretEnc,
      redirectUri: s.publicUrl ? redirectUri(s, p) : '',
    }]));
  });

  app.put('/api/accounts/apps/:provider', admin, async (req) => {
    const { provider } = providerParam.parse(req.params);
    const body = z.object({
      clientId: z.string().trim().max(200).regex(/^[A-Za-z0-9._-]*$/),
      /** Omitted keeps the stored secret, empty clears it. */
      clientSecret: z.string().trim().max(300).optional(),
    }).parse(req.body);
    const s = await getSettings(sql);
    const cur = s.platforms[provider];
    await setSettings(sql, { platforms: { ...s.platforms, [provider]: {
      clientId: body.clientId,
      clientSecretEnc: body.clientSecret === undefined ? cur.clientSecretEnc : body.clientSecret ? encrypt(body.clientSecret) : '',
    } } });
    await audit(sql, req, 'platform_app.updated', { provider, secretChanged: body.clientSecret !== undefined });
    return { ok: true };
  });

  /** Starts the OAuth flow (a normal navigation from the console, so the session cookie is sent). */
  app.get('/api/accounts/oauth/:provider/start', operator, async (req, reply) => {
    const { provider } = providerParam.parse(req.params);
    const s = await getSettings(sql);
    if (!s.publicUrl) return reply.redirect('/accounts?error=public_url_missing');
    if (!appConfigured(s, provider)) return reply.redirect('/accounts?error=app_not_configured');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(16).toString('base64url');
    const flow: Flow = { p: provider, state, verifier, user: req.user!.id, session: req.session!.id, t: Date.now() };
    // The session cookie is SameSite=Strict and is not sent when the platform redirects back, so the flow cookie
    // (Lax, encrypted, ten minutes) carries who started it; the callback checks that this session is still valid.
    reply.setCookie(FLOW_COOKIE, encrypt(JSON.stringify(flow)), {
      path: '/api/accounts/oauth', httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', maxAge: 600,
    });
    return reply.redirect(authorizeUrl(s, provider, state, challenge));
  });

  app.get('/api/accounts/oauth/:provider/callback', async (req, reply) => {
    const { provider } = providerParam.parse(req.params);
    const q = z.object({ code: z.string().max(2000).optional(), state: z.string().max(200).optional(), error: z.string().max(200).optional() }).parse(req.query);
    const raw = req.cookies[FLOW_COOKIE];
    reply.clearCookie(FLOW_COOKIE, { path: '/api/accounts/oauth' });
    const fail = (code: string) => reply.redirect(`/accounts?error=${encodeURIComponent(code)}`);
    if (!raw) return fail('oauth_failed');
    let flow: Flow;
    try { flow = JSON.parse(decrypt(raw)) as Flow; } catch { return fail('oauth_failed'); }
    if (flow.p !== provider || flow.state !== q.state || Date.now() - flow.t > 600_000) return fail('oauth_failed');
    if (q.error || !q.code) return fail(q.error === 'access_denied' ? 'oauth_denied' : 'oauth_failed');

    const [who] = await sql<{ role: string; disabled: boolean }[]>`
      SELECT u.role, u.disabled FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ${flow.session} AND s.user_id = ${flow.user} AND s.stage = 'full' AND s.expires_at > now()`;
    if (!who || who.disabled || who.role === 'viewer') return fail('oauth_failed');

    const s = await getSettings(sql);
    try {
      const ids = await exchangeCode(s, provider, q.code, flow.verifier);
      for (const i of ids) {
        await sql`
          INSERT INTO platform_accounts (provider, external_id, name, handle, image_url, access_token_enc, refresh_token_enc, expires_at, scopes, created_by)
          VALUES (${provider}, ${i.externalId}, ${i.name}, ${i.handle}, ${i.imageUrl}, ${encrypt(i.accessToken)},
                  ${i.refreshToken ? encrypt(i.refreshToken) : ''}, ${i.expiresAt}, ${i.scopes}, ${flow.user})
          ON CONFLICT (provider, external_id) DO UPDATE SET
            name = EXCLUDED.name, handle = EXCLUDED.handle, image_url = EXCLUDED.image_url, access_token_enc = EXCLUDED.access_token_enc,
            refresh_token_enc = CASE WHEN EXCLUDED.refresh_token_enc = '' THEN platform_accounts.refresh_token_enc ELSE EXCLUDED.refresh_token_enc END,
            expires_at = EXCLUDED.expires_at, scopes = EXCLUDED.scopes, status = 'ok', last_error = NULL, updated_at = now()`;
      }
      await audit(sql, req, 'account.connected', { provider, accounts: ids.map((i) => i.name) }, flow.user);
      return reply.redirect(`/accounts?connected=${ids.length}`);
    } catch (err) {
      req.log.warn({ err, provider }, 'connecting account failed');
      const msg = err instanceof PlatformError ? err.message : 'oauth_failed';
      return fail(['no_channel', 'no_pages'].includes(msg) ? msg : 'oauth_failed');
    }
  });

  app.delete('/api/accounts/:id', operator, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const [a] = await sql<{ provider: string; name: string }[]>`SELECT provider, name FROM platform_accounts WHERE id = ${id}`;
    if (!a) throw new HttpError(404, 'not_found');
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM destinations WHERE account_id = ${id} AND live`;
    if (n > 0) throw new HttpError(409, 'account_in_use');
    // Its destinations stay "via account" and show that the account is missing until another one is chosen.
    await sql`UPDATE destinations SET remote_stream_id = NULL WHERE account_id = ${id}`;
    await sql`DELETE FROM platform_accounts WHERE id = ${id}`;
    await audit(sql, req, 'account.removed', { provider: a.provider, name: a.name });
    return { ok: true };
  });
}
