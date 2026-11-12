import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { requireAuth } from '../lib/guards.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { encrypt } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { redirectUri } from './sso.js';

export async function settingsRoutes(app: FastifyInstance, { sql }: { sql: Sql }) {
  const admin = { preHandler: requireAuth('admin') };

  app.get('/api/settings', admin, async () => {
    const s = await getSettings(sql);
    const { clientSecretEnc, ...sso } = s.sso;
    return {
      instanceName: s.instanceName,
      defaultLanguage: s.defaultLanguage,
      publicUrl: s.publicUrl,
      githubTokenSet: !!s.githubTokenEnc,
      sso: { ...sso, clientSecretSet: !!clientSecretEnc, redirectUri: s.publicUrl ? redirectUri(s) : '' },
    };
  });

  app.put('/api/settings', admin, async (req) => {
    const body = z.object({
      instanceName: z.string().trim().min(1).max(60).optional(),
      defaultLanguage: z.enum(['en', 'nl']).optional(),
      publicUrl: z.union([z.url({ protocol: /^https?$/ }), z.literal('')]).optional(),
      /** Empty string clears the token; omitted keeps it. */
      githubToken: z.string().max(200).optional(),
      sso: z.object({
        enabled: z.boolean(),
        tenantId: z.string().trim().max(64).regex(/^[A-Za-z0-9.-]*$/),
        clientId: z.string().trim().max(64),
        clientSecret: z.string().max(200).optional(),
        allowedGroupId: z.string().trim().max(64),
        autoProvision: z.boolean(),
        defaultRole: z.enum(['admin', 'operator', 'viewer']),
      }).optional(),
    }).parse(req.body);

    const cur = await getSettings(sql);
    const patch: Parameters<typeof setSettings>[1] = {
      instanceName: body.instanceName,
      defaultLanguage: body.defaultLanguage,
      publicUrl: body.publicUrl?.replace(/\/+$/, ''),
    };
    if (body.githubToken !== undefined) patch.githubTokenEnc = body.githubToken ? encrypt(body.githubToken) : '';
    if (body.sso) {
      const { clientSecret, ...rest } = body.sso;
      patch.sso = {
        ...cur.sso, ...rest,
        clientSecretEnc: clientSecret === undefined ? cur.sso.clientSecretEnc : clientSecret ? encrypt(clientSecret) : '',
      };
    }
    await setSettings(sql, patch);
    await audit(sql, req, 'settings.updated', { keys: Object.keys(body) });
    return { ok: true };
  });
}
