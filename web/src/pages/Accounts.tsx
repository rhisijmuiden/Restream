import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { CheckCircle2, ExternalLink, KeyRound, Link2, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { api, type Account, type AccountsResponse, type OAuthApps, type OAuthProvider } from '../lib/api';
import { useMe } from '../lib/auth';
import { Button, Card, CopyButton, ErrorText, Field, Input, PageHeader } from '../components/ui';
import { PlatformChip } from '../components/media';
import { platformMeta } from '../lib/streams';

const providers: OAuthProvider[] = ['youtube', 'facebook', 'twitch'];
const consoles: Record<OAuthProvider, string> = {
  youtube: 'https://console.cloud.google.com/apis/credentials',
  facebook: 'https://developers.facebook.com/apps/',
  twitch: 'https://dev.twitch.tv/console/apps',
};

export function Accounts() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const role = useMe().data!.user!.role;
  const canOperate = role !== 'viewer';
  const isAdmin = role === 'admin';
  const [params, setParams] = useSearchParams();
  const q = useQuery({ queryKey: ['accounts'], queryFn: () => api<AccountsResponse>('/api/accounts') });
  const apps = useQuery({ queryKey: ['oauth-apps'], queryFn: () => api<OAuthApps>('/api/accounts/apps'), enabled: isAdmin });

  const remove = useMutation({
    mutationFn: async (a: Account) => {
      if (!confirm(t('accounts.confirmRemove', { name: a.name }))) return;
      return api(`/api/accounts/${a.id}`, { method: 'DELETE' });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['accounts'] }),
  });

  const connected = params.get('connected');
  const error = params.get('error');
  const dismiss = () => setParams({}, { replace: true });

  return (
    <>
      <PageHeader eyebrow={t('nav.broadcast')} title={t('accounts.title')} subtitle={t('accounts.subtitle')} />
      {connected && (
        <Banner tone="ok" onClose={dismiss}><CheckCircle2 size={18} /> {t('accounts.connected', { count: Number(connected) })}</Banner>
      )}
      {error && (
        <Banner tone="danger" onClose={dismiss}>
          <TriangleAlert size={18} /> {i18n.exists(`errors.${error}`) ? t(`errors.${error}`) : t('errors.oauth_failed')}
        </Banner>
      )}
      {q.data && !q.data.publicUrlSet && (
        <Banner tone="warn">
          <TriangleAlert size={18} />
          <span>{t('accounts.publicUrlMissing')} {isAdmin && <Link to="/admin/settings">{t('accounts.openSettings')} →</Link>}</span>
        </Banner>
      )}

      <div className="grid gap-6 xl:grid-cols-3">
        {providers.map((p) => {
          const list = q.data?.accounts.filter((a) => a.provider === p) ?? [];
          const configured = q.data?.apps[p].configured;
          return (
            <Card
              key={p}
              eyebrow={<span className="flex items-center gap-2"><PlatformChip platform={p} size={20} /> {platformMeta[p].label}</span>}
              title={t(`accounts.kind.${p}`)}
              actions={canOperate && (
                configured && q.data?.publicUrlSet
                  ? <a href={`/api/accounts/oauth/${p}/start`} className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-ink glow hover:bg-accent-hover"><Plus size={16} /> {t('accounts.connect')}</a>
                  : <Button disabled title={t('accounts.appMissing')}><Plus size={16} /> {t('accounts.connect')}</Button>
              )}
            >
              <p className="mb-4 text-xs leading-relaxed text-fg-3">{t(`accounts.what.${p}`)}</p>
              {list.length === 0 ? (
                <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-fg-3">
                  {configured ? t('accounts.none') : t('accounts.appMissing')}
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {list.map((a) => (
                    <li key={a.id} className={clsx('flex items-center gap-3 rounded-xl border p-3', a.status === 'error' ? 'border-warn/40 bg-warn/[0.05]' : 'border-line bg-bg/40')}>
                      <div className="relative flex size-9 shrink-0 items-center justify-center rounded-full border border-line bg-surface-2 font-mono text-xs text-fg-2">
                        {a.name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('')}
                        <span
                          className={clsx('absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-surface', a.status === 'ok' ? 'bg-ok' : 'bg-warn')}
                          title={a.status === 'ok' ? t('accounts.ok') : t('accounts.error')}
                        />
                      </div>
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-medium">{a.name}</span>
                        <span className="truncate text-xs text-fg-3">
                          {a.handle && `${a.handle} · `}{t('accounts.usedBy', { count: a.destinations })}
                        </span>
                        {a.status === 'error' && <span className="truncate font-mono text-[11px] text-warn" title={a.lastError ?? ''}>{t('accounts.reconnect')}</span>}
                      </div>
                      {canOperate && (
                        <Button variant="ghost" className="min-h-9 px-2.5 text-danger hover:text-danger" onClick={() => remove.mutate(a)} aria-label={t('accounts.remove')}><Trash2 size={15} /></Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          );
        })}
      </div>
      <ErrorText error={remove.error} />

      {isAdmin && apps.data && (
        <section className="mt-8 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="eyebrow">{t('nav.administration')}</span>
            <h2 className="font-display text-xl font-semibold">{t('accounts.appsTitle')}</h2>
            <p className="max-w-3xl text-sm leading-relaxed text-fg-2">{t('accounts.appsText')}</p>
          </div>
          <div className="grid gap-6 xl:grid-cols-3">
            {providers.map((p) => <AppForm key={p} provider={p} app={apps.data![p]} />)}
          </div>
        </section>
      )}
    </>
  );
}

function Banner({ tone, children, onClose }: { tone: 'ok' | 'warn' | 'danger'; children: React.ReactNode; onClose?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className={clsx('mb-6 flex flex-wrap items-center gap-3 rounded-2xl border px-5 py-4 text-sm',
      tone === 'ok' ? 'border-ok/40 bg-ok/[0.07] text-ok' : tone === 'warn' ? 'border-warn/40 bg-warn/[0.07] text-warn' : 'border-danger/40 bg-danger/[0.07] text-danger')}>
      {children}
      {onClose && <button onClick={onClose} className="ml-auto text-xs text-fg-3 hover:text-fg">{t('common.close')}</button>}
    </div>
  );
}

function AppForm({ provider, app }: { provider: OAuthProvider; app: OAuthApps[OAuthProvider] }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [clientId, setClientId] = useState(app.clientId);
  const [secret, setSecret] = useState('');
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => api(`/api/accounts/apps/${provider}`, { method: 'PUT', body: { clientId: clientId.trim(), ...(secret ? { clientSecret: secret.trim() } : {}) } }),
    onSuccess: () => {
      setSecret(''); setSaved(true); setTimeout(() => setSaved(false), 2000);
      qc.invalidateQueries({ queryKey: ['oauth-apps'] }); qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };
  return (
    <Card eyebrow={<span className="flex items-center gap-2"><KeyRound size={13} /> {platformMeta[provider].label}</span>} title={t(`accounts.app.${provider}`)}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-xs leading-relaxed text-fg-2">
          {(t(`accounts.steps.${provider}`, { returnObjects: true }) as string[]).map((s, i) => <li key={i}>{s}</li>)}
        </ol>
        <a href={consoles[provider]} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-sm">{t('accounts.openConsole')} <ExternalLink size={13} /></a>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-fg-2">{t('accounts.redirectUri')}</span>
          {app.redirectUri ? (
            <div className="flex items-center gap-1 rounded-xl border border-line bg-bg pl-3">
              <code className="min-w-0 flex-1 truncate py-2 font-mono text-xs text-fg-2"><Link2 size={12} className="mr-1.5 inline" />{app.redirectUri}</code>
              <CopyButton value={app.redirectUri} className="min-h-9 px-3" />
            </div>
          ) : <span className="text-xs text-warn">{t('accounts.publicUrlMissing')}</span>}
        </div>
        <Field label={t('accounts.clientId')}>
          {(id) => <Input id={id} value={clientId} onChange={(e) => setClientId(e.target.value)} className="font-mono text-[13px]" autoComplete="off" />}
        </Field>
        <Field label={t('accounts.clientSecret')} hint={app.clientSecretSet ? t('accounts.secretKeep') : undefined}>
          {(id) => <Input id={id} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} className="font-mono text-[13px]" autoComplete="off" placeholder={app.clientSecretSet ? '••••••••' : ''} />}
        </Field>
        <ErrorText error={save.error} />
        <div className="flex items-center justify-end gap-3">
          {saved && <span className="text-sm text-ok">{t('common.saved')}</span>}
          <Button type="submit" variant="primary" loading={save.isPending}>{t('common.save')}</Button>
        </div>
      </form>
    </Card>
  );
}
