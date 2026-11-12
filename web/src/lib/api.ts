export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    credentials: 'same-origin',
    headers: { 'x-restream': '1', ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'request_failed');
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
}
