import type { FastifyInstance } from 'fastify';
import * as oidc from 'openid-client';
import type { Sql } from '../db.js';
import { decrypt, encrypt, randomToken } from '../lib/crypto.js';
import { hashPassword } from '../lib/password.js';
import { createSession } from '../lib/session.js';
import { audit } from '../lib/audit.js';
import { getSettings, type Settings } from '../lib/settings.js';
import { config } from '../config.js';

const FLOW_COOKIE = 'restream_sso';
let cached: { key: string; cfg: oidc.Configuration } | null = null;

async function oidcConfig(s: Settings) {
  const key = `${s.sso.tenantId}|${s.sso.clientId}|${s.sso.clientSecretEnc}`;
  if (cached?.key === key) return cached.cfg;
  const cfg = await oidc.discovery(
    new URL(`https://login.microsoftonline.com/${encodeURIComponent(s.sso.tenantId)}/v2.0`),
    s.sso.clientId,
    undefined,
    oidc.ClientSecretPost(decrypt(s.sso.clientSecretEnc)),
  );
  cached = { key, cfg };
  return cfg;
}

export function redirectUri(s: Settings) {
  return `${s.publicUrl.replace(/\/+$/, '')}/api/auth/sso/microsoft/callback`;
}

/** Microsoft 365 / Entra ID single sign-on (OpenID Connect, authorization code + PKCE). */
export async function ssoRoutes(app: FastifyInstance, { sql }: { sql: Sql }) {
  app.get('/api/auth/sso/microsoft/start', async (req, reply) => {
    const s = await getSettings(sql);
    if (!s.sso.enabled || !s.sso.clientId || !s.publicUrl) return reply.redirect('/login?error=sso_not_configured');
    try {
      const cfg = await oidcConfig(s);
      const verifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const url = oidc.buildAuthorizationUrl(cfg, {
        redirect_uri: redirectUri(s),
        scope: 'openid profile email',
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
        state,
        nonce,
        prompt: 'select_account',
      });
      reply.setCookie(FLOW_COOKIE, encrypt(JSON.stringify({ verifier, state, nonce, t: Date.now() })), {
        path: '/api/auth/sso', httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', maxAge: 600,
      });
      return reply.redirect(url.href);
    } catch (err) {
      req.log.error({ err }, 'sso start failed');
      return reply.redirect('/login?error=sso_failed');
    }
  });

  app.get('/api/auth/sso/microsoft/callback', async (req, reply) => {
    const s = await getSettings(sql);
    const raw = req.cookies[FLOW_COOKIE];
    reply.clearCookie(FLOW_COOKIE, { path: '/api/auth/sso' });
    if (!s.sso.enabled || !raw) return reply.redirect('/login?error=sso_failed');
    try {
      const flow = JSON.parse(decrypt(raw)) as { verifier: string; state: string; nonce: string; t: number };
      if (Date.now() - flow.t > 600_000) throw new Error('flow expired');
      const cfg = await oidcConfig(s);
      const current = new URL(req.url, s.publicUrl);
      const tokens = await oidc.authorizationCodeGrant(cfg, current, {
        pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce,
      });
      const claims = tokens.claims();
      if (!claims) throw new Error('no id_token');
      const subject = `${claims.tid ?? s.sso.tenantId}:${claims.oid ?? claims.sub}`;
      const email = String(claims.email ?? claims.preferred_username ?? '').toLowerCase();
      const name = String(claims.name ?? '');
      if (!email) throw new Error('no email claim');

      if (s.sso.allowedGroupId) {
        const groups = (claims.groups as string[] | undefined) ?? [];
        if (!groups.includes(s.sso.allowedGroupId)) {
          await audit(sql, req, 'auth.sso_denied', { email, reason: 'group' });
          return reply.redirect('/login?error=sso_not_allowed');
        }
      }

      let [u] = await sql<{ id: string; disabled: boolean }[]>`
        SELECT id, disabled FROM users WHERE sso_subject = ${subject} OR (sso_subject IS NULL AND lower(email) = ${email})
        ORDER BY (sso_subject = ${subject}) DESC NULLS LAST LIMIT 1`;
      if (!u) {
        if (!s.sso.autoProvision) {
          await audit(sql, req, 'auth.sso_denied', { email, reason: 'no_account' });
          return reply.redirect('/login?error=sso_no_account');
        }
        [u] = await sql<{ id: string; disabled: boolean }[]>`
          INSERT INTO users (email, name, password_hash, role, auth_source, sso_subject)
          VALUES (${email}, ${name}, ${await hashPassword(randomToken())}, ${s.sso.defaultRole}, 'microsoft', ${subject})
          RETURNING id, disabled`;
        await audit(sql, req, 'user.provisioned_sso', { email }, u.id);
      } else {
        // Link an existing local account by e-mail on first SSO login.
        await sql`UPDATE users SET sso_subject = ${subject}, name = CASE WHEN name = '' THEN ${name} ELSE name END WHERE id = ${u.id}`;
      }
      if (u.disabled) return reply.redirect('/login?error=account_disabled');
      await sql`UPDATE users SET last_login_at = now() WHERE id = ${u.id}`;
      // MFA is enforced by Microsoft (Conditional Access), so the session is complete.
      await createSession(sql, req, reply, u.id, 'full');
      await audit(sql, req, 'auth.login', { method: 'microsoft' }, u.id);
      return reply.redirect('/');
    } catch (err) {
      req.log.warn({ err }, 'sso callback failed');
      return reply.redirect('/login?error=sso_failed');
    }
  });
}
