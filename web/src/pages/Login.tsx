import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../lib/api';
import { useMe, useRefreshMe } from '../lib/auth';
import { Button, ErrorText, Field, Input } from '../components/ui';
import { AuthShell } from './AuthShell';

export function Login() {
  const { t } = useTranslation();
  const me = useMe().data;
  const refresh = useRefreshMe();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(params.get('error') ? new ApiError(400, params.get('error')!) : null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api<{ next: string }>('/api/auth/login', { method: 'POST', body: { email, password } });
      await refresh();
      nav(r.next === 'mfa' ? '/login/2fa' : '/setup-2fa');
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  return (
    <AuthShell>
      <form onSubmit={submit} className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <h2 className="font-display text-[26px] font-semibold">{t('login.title')}</h2>
          <p className="text-sm text-fg-3">{t('login.subtitle', { name: me?.instanceName ?? 'Restream' })}</p>
        </div>
        <ErrorText error={error} />
        <Field label={t('common.email')}>{(id) => <Input id={id} type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />}</Field>
        <Field label={t('login.password')}>{(id) => <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <Button type="submit" variant="primary" loading={busy} className="min-h-12 text-[15px]">{t('login.submit')}</Button>
        {me?.ssoEnabled && (
          <>
            <div className="flex items-center gap-3 text-xs text-fg-3"><span className="h-px flex-1 bg-line" />{t('login.or')}<span className="h-px flex-1 bg-line" /></div>
            <a href="/api/auth/sso/microsoft/start" className="inline-flex min-h-12 items-center justify-center gap-3 rounded-xl border border-line bg-surface-2 text-sm font-medium text-fg no-underline hover:border-line-strong">
              <MicrosoftMark /> {t('login.microsoft')}
            </a>
          </>
        )}
        <p className="text-xs leading-relaxed text-fg-3">{t('login.forgot')}</p>
      </form>
    </AuthShell>
  );
}

function MicrosoftMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden>
      <rect x="1" y="1" width="9" height="9" fill="#F25022" /><rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" /><rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}

export function LoginMfa() {
  const { t } = useTranslation();
  const refresh = useRefreshMe();
  const nav = useNavigate();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api('/api/auth/mfa', { method: 'POST', body: { code } });
      await refresh();
      nav('/');
    } catch (err) { setError(err); setCode(''); } finally { setBusy(false); }
  }

  async function startOver() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    await refresh();
    nav('/login');
  }

  return (
    <AuthShell>
      <form onSubmit={submit} className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <h2 className="font-display text-[26px] font-semibold">{t('login.mfaTitle')}</h2>
          <p className="text-sm leading-relaxed text-fg-3">{t('login.mfaText')}</p>
        </div>
        <ErrorText error={error} />
        <Field label={t('login.mfaCode')}>
          {(id) => <Input id={id} autoComplete="one-time-code" inputMode="text" autoFocus required maxLength={20} value={code} onChange={(e) => setCode(e.target.value)} placeholder="000 000" className="font-mono tracking-[0.25em]" />}
        </Field>
        <Button type="submit" variant="primary" loading={busy} className="min-h-12 text-[15px]">{t('login.verify')}</Button>
        <button type="button" onClick={startOver} className="text-sm text-fg-3 hover:text-fg">{t('login.startOver')}</button>
      </form>
    </AuthShell>
  );
}
