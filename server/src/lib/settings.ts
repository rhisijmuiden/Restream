import type { Sql } from '../db.js';
import type { Role } from './session.js';

export interface SsoSettings {
  enabled: boolean;
  tenantId: string;
  clientId: string;
  /** Encrypted with APP_KEY; never sent to the browser. */
  clientSecretEnc: string;
  /** Optional Entra group object id; when set, only members may sign in. */
  allowedGroupId: string;
  autoProvision: boolean;
  defaultRole: Role;
}

export interface Settings {
  instanceName: string;
  defaultLanguage: 'en' | 'nl';
  /** Public base URL, e.g. https://restream.example.com (used for SSO redirects). */
  publicUrl: string;
  /** Optional GitHub token, only needed when the repository is private. */
  githubTokenEnc: string;
  sso: SsoSettings;
}

export const defaultSettings: Settings = {
  instanceName: 'Restream',
  defaultLanguage: 'en',
  publicUrl: process.env.PUBLIC_URL ?? '',
  githubTokenEnc: '',
  sso: {
    enabled: false, tenantId: '', clientId: '', clientSecretEnc: '', allowedGroupId: '',
    autoProvision: true, defaultRole: 'operator',
  },
};

export async function getSettings(sql: Sql): Promise<Settings> {
  const rows = await sql<{ key: string; value: unknown }[]>`SELECT key, value FROM settings`;
  const out = structuredClone(defaultSettings) as unknown as Record<string, unknown>;
  for (const r of rows) {
    if (!(r.key in defaultSettings)) continue;
    const def = (defaultSettings as unknown as Record<string, unknown>)[r.key];
    out[r.key] = def && typeof def === 'object' ? { ...def, ...(r.value as object) } : r.value;
  }
  return out as unknown as Settings;
}

export async function setSettings(sql: Sql, patch: Partial<Settings>) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || !(k in defaultSettings)) continue;
    await sql`
      INSERT INTO settings (key, value) VALUES (${k}, ${sql.json(v as never)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  }
}
