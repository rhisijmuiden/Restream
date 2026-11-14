import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { BookOpen, Building2, Check, CheckCircle2, ExternalLink, HelpCircle, KeyRound, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { api, type Account, type AccountsResponse, type OAuthApps, type OAuthProvider } from '../lib/api';
import { useMe } from '../lib/auth';
import { Badge, Button, Card, CopyButton, ErrorText, Field, Input, Modal, PageHeader } from '../components/ui';
import { PlatformChip } from '../components/media';
import { PaidNotice } from '../components/PaidNotice';
import { platformMeta } from '../lib/streams';

const providers: OAuthProvider[] = ['youtube', 'facebook', 'twitch', 'x', 'linkedin'];

/** LinkedIn: go live as the person who signs in, or on the company pages they administer (connected separately). */
type Target = 'member' | 'organization';

/** Deep links for the steps of the setup guides (the texts are in the translations). */
const links: Record<string, string> = {
  googleProject: 'https://console.cloud.google.com/projectcreate',
  googleApi: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com',
  googleBranding: 'https://console.cloud.google.com/auth/branding',
  googleAudience: 'https://console.cloud.google.com/auth/audience',
  googleScopes: 'https://console.cloud.google.com/auth/scopes',
  googleClient: 'https://console.cloud.google.com/auth/clients/create',
  metaCreate: 'https://developers.facebook.com/apps/creation/',
  metaApps: 'https://developers.facebook.com/apps/',
  twitchCreate: 'https://dev.twitch.tv/console/apps/create',
  twitchApps: 'https://dev.twitch.tv/console/apps',
  xConsole: 'https://console.x.com',
  xProducer: 'https://studio.x.com/producer',
  linkedinCreate: 'https://www.linkedin.com/developers/apps/new',
  linkedinApps: 'https://www.linkedin.com/developers/apps',
  linkedinLiveDocs: 'https://learn.microsoft.com/en-us/linkedin/consumer/integrations/live-video',
};

type CopyKind = 'redirectUri' | 'origin' | 'domain' | 'scopes';
interface GuideStep { title: string; text: string; link?: string; copy?: CopyKind[]; note?: string }

const POPUP = 'restream-oauth';

/**
 * Opens "Connect with ..." in a pop-up window, like other apps do. The pop-up ends on /oauth-done.html, which reports
 * the result over a BroadcastChannel (the platform's pages cut window.opener) and closes. A blocked pop-up falls back
 * to a normal page navigation.
 */
function useOAuthPopup(onDone: (query: string) => void) {
  const [waiting, setWaiting] = useState<OAuthProvider | null>(null);
  const win = useRef<Window | null>(null);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const finish = (query: string) => { setWaiting(null); win.current = null; done.current(query); };
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel(POPUP);
      bc.onmessage = (e: MessageEvent<{ query?: string }>) => { if (typeof e.data?.query === 'string') finish(e.data.query); };
    } catch { /* not supported: the storage event below still works */ }
    const onStorage = (e: StorageEvent) => {
      if (e.key !== POPUP || !e.newValue) return;
      try { finish((JSON.parse(e.newValue) as { query: string }).query); } catch { /* ignore */ }
    };
    window.addEventListener('storage', onStorage);
    return () => { bc?.close(); window.removeEventListener('storage', onStorage); };
  }, []);

  const start = useCallback((p: OAuthProvider, target: Target = 'member') => {
    const w = 520, h = 720;
    const left = Math.max(0, window.screenX + (window.outerWidth - w) / 2);
    const top = Math.max(0, window.screenY + (window.outerHeight - h) / 2);
    const extra = target === 'organization' ? '&target=organization' : '';
    const popup = window.open(`/api/accounts/oauth/${p}/start?popup=1${extra}`, POPUP, `popup=yes,width=${w},height=${h},left=${left},top=${top}`);
    if (!popup) { window.location.href = `/api/accounts/oauth/${p}/start?${extra.slice(1)}`; return; }
    win.current = popup;
    setWaiting(p);
  }, []);

  const focus = () => { try { win.current?.focus(); } catch { /* window is gone */ } };
  return { start, waiting, cancel: () => { try { win.current?.close(); } catch { /* ignore */ } setWaiting(null); }, focus };
}

export function Accounts() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const role = useMe().data!.user!.role;
  const canOperate = role !== 'viewer';
  const isAdmin = role === 'admin';
  const [params, setParams] = useSearchParams();
  const q = useQuery({ queryKey: ['accounts'], queryFn: () => api<AccountsResponse>('/api/accounts') });
  const apps = useQuery({ queryKey: ['oauth-apps'], queryFn: () => api<OAuthApps>('/api/accounts/apps'), enabled: isAdmin });
  const [guide, setGuide] = useState<OAuthProvider | null>(null);
  const [explain, setExplain] = useState<OAuthProvider | null>(null);

  const oauth = useOAuthPopup((query) => {
    setParams(new URLSearchParams(query), { replace: true });
    qc.invalidateQueries({ queryKey: ['accounts'] });
  });

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
  const publicUrlSet = !!q.data?.publicUrlSet;
  const anyApp = providers.some((p) => q.data?.apps[p].configured);
  const anyAccount = (q.data?.accounts.length ?? 0) > 0;

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

      {q.data && (
        <section className="mb-8 rounded-2xl border border-line bg-surface p-6" aria-labelledby="how-title">
          <div className="mb-5 flex flex-col gap-1.5">
            <span className="eyebrow">{t('accounts.how.eyebrow')}</span>
            <h2 id="how-title" className="font-display text-xl font-semibold">{t('accounts.how.title')}</h2>
            <p className="max-w-3xl text-sm leading-relaxed text-fg-2">{t('accounts.how.text')}</p>
          </div>
          <ol className="grid gap-3 lg:grid-cols-3">
            <HowStep n={1} done={publicUrlSet} title={t('accounts.how.step1')} who={t('accounts.how.admin')}>
              {publicUrlSet ? t('accounts.how.step1Done') : t('accounts.how.step1Text')}
              {!publicUrlSet && isAdmin && <> <Link to="/admin/settings">{t('accounts.openSettings')} →</Link></>}
            </HowStep>
            <HowStep n={2} done={anyApp} title={t('accounts.how.step2')} who={t('accounts.how.admin')}>
              {t('accounts.how.step2Text')}
              <span className="mt-2 flex flex-wrap gap-1.5">
                {providers.map((p) => (
                  <button
                    key={p} type="button" disabled={!isAdmin} onClick={() => setGuide(p)}
                    className={clsx('inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs', q.data!.apps[p].configured ? 'border-ok/40 text-ok' : 'border-line text-fg-3', isAdmin && 'hover:border-line-strong hover:text-fg')}
                  >
                    {q.data!.apps[p].configured ? <Check size={12} /> : <KeyRound size={12} />} {platformMeta[p].label}
                  </button>
                ))}
              </span>
            </HowStep>
            <HowStep n={3} done={anyAccount} title={t('accounts.how.step3')} who={t('accounts.how.operator')}>
              {t('accounts.how.step3Text')}
            </HowStep>
          </ol>
        </section>
      )}

      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        {providers.map((p) => {
          const list = q.data?.accounts.filter((a) => a.provider === p) ?? [];
          const configured = !!q.data?.apps[p].configured;
          const ready = configured && publicUrlSet;
          return (
            <Card
              key={p}
              eyebrow={<span className="flex items-center gap-2"><PlatformChip platform={p} size={20} /> {platformMeta[p].label}</span>}
              title={t(`accounts.kind.${p}`)}
            >
              <p className="mb-4 text-xs leading-relaxed text-fg-3">{t(`accounts.what.${p}`)}</p>
              {p === 'x' && <PaidNotice provider={p} />}
              {canOperate && (
                <div className="mb-4 flex flex-col gap-2">
                  {ready ? (
                    <>
                      <ConnectButton provider={p} onClick={() => oauth.start(p)} />
                      {p === 'linkedin' && (
                        <Button variant="secondary" className="w-full" onClick={() => oauth.start(p, 'organization')}>
                          <Building2 size={16} /> {t('accounts.connectPage')}
                        </Button>
                      )}
                    </>
                  ) : isAdmin ? (
                    <Button variant="primary" className="w-full" onClick={() => setGuide(p)} disabled={!publicUrlSet}>
                      <BookOpen size={16} /> {t('accounts.setUp', { platform: platformMeta[p].label })}
                    </Button>
                  ) : (
                    <p className="rounded-xl border border-warn/30 bg-warn/[0.05] px-3 py-2.5 text-xs leading-relaxed text-warn">{t('accounts.askAdmin', { platform: platformMeta[p].label })}</p>
                  )}
                  <button type="button" onClick={() => setExplain(p)} className="inline-flex items-center gap-1.5 self-start text-xs text-fg-3 hover:text-fg">
                    <HelpCircle size={13} /> {t('accounts.whatHappens')}
                  </button>
                </div>
              )}
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
                        {a.status !== 'error' && a.missingScopes.length > 0 && (
                          <span className="text-[11px] leading-snug text-warn" title={a.missingScopes.join(', ')}>{t('accounts.reconnectForChat')}</span>
                        )}
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
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {providers.map((p) => {
              const ok = !!(apps.data![p].clientId && apps.data![p].clientSecretSet);
              return (
                <div key={p} className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-4">
                  <div className="flex items-center gap-3">
                    <PlatformChip platform={p} size={32} />
                    <span className="min-w-0 flex-1 text-sm font-medium">{t(`accounts.app.${p}`)}</span>
                    <span className="shrink-0 whitespace-nowrap">{ok ? <Badge tone="ok" dot>{t('accounts.appReady')}</Badge> : <Badge tone="warn" dot>{t('accounts.appNotSet')}</Badge>}</span>
                  </div>
                  <Button variant={ok ? 'secondary' : 'primary'} onClick={() => setGuide(p)}><BookOpen size={15} /> {ok ? t('accounts.openGuide') : t('accounts.startGuide')}</Button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {guide && apps.data && (
        <SetupGuide
          provider={guide}
          app={apps.data[guide]}
          canConnect={publicUrlSet}
          onClose={() => setGuide(null)}
          onConnect={() => { const p = guide; setGuide(null); oauth.start(p); }}
        />
      )}

      <Modal open={!!explain} onClose={() => setExplain(null)} title={explain ? t('accounts.popup.explainTitle', { platform: platformMeta[explain].label }) : ''} wide>
        {explain && <PopupExplainer provider={explain} />}
      </Modal>

      <Modal open={!!oauth.waiting} onClose={oauth.cancel} title={oauth.waiting ? t('accounts.popup.waitingTitle', { platform: platformMeta[oauth.waiting].label }) : ''} wide>
        {oauth.waiting && (
          <>
            <p className="flex items-center gap-2.5 text-sm text-fg-2">
              <span className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent" aria-hidden />
              {t('accounts.popup.waitingText')}
            </p>
            <PopupExplainer provider={oauth.waiting} />
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={oauth.cancel}>{t('common.cancel')}</Button>
              <Button onClick={oauth.focus}>{t('accounts.popup.show')}</Button>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}

/** The platform-branded "Connect with ..." button that opens the consent pop-up. */
function ConnectButton({ provider, onClick }: { provider: OAuthProvider; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-11 w-full items-center justify-center gap-2.5 rounded-xl px-4 text-sm font-semibold text-ink transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      style={{ background: platformMeta[provider].color }}
    >
      <Plus size={16} /> {t('accounts.connectWith', { platform: platformMeta[provider].label })}
    </button>
  );
}

function HowStep({ n, done, title, who, children }: { n: number; done: boolean; title: string; who: string; children: ReactNode }) {
  return (
    <li className={clsx('flex gap-3 rounded-xl border p-4', done ? 'border-ok/30 bg-ok/[0.04]' : 'border-line bg-bg/40')}>
      <span className={clsx('flex size-7 shrink-0 items-center justify-center rounded-full font-mono text-xs font-semibold', done ? 'bg-ok text-ink' : 'border border-line-strong text-fg-2')}>
        {done ? <Check size={14} /> : n}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-[11px] tracking-wide text-fg-3 uppercase">{who}</span>
        <span className="text-xs leading-relaxed text-fg-2">{children}</span>
      </div>
    </li>
  );
}

const consentColor: Record<OAuthProvider, string> = { youtube: '#1A73E8', facebook: '#1877F2', twitch: '#9146FF', x: '#0F1419', linkedin: '#0A66C2' };

/** What the person sees in the pop-up, step by step, with an example of the permission screen. */
function PopupExplainer({ provider }: { provider: OAuthProvider }) {
  const { t } = useTranslation();
  const steps = t(`accounts.popup.steps.${provider}`, { returnObjects: true }) as string[];
  const perms = t(`accounts.popup.consent.${provider}.items`, { returnObjects: true }) as string[];
  return (
    <div className="grid gap-5 sm:grid-cols-[1fr_220px]">
      <ol className="flex flex-col gap-2.5">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-2.5 text-sm leading-relaxed text-fg-2">
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-line-strong font-mono text-[10px] text-fg-2">{i + 1}</span>
            <span>{s}</span>
          </li>
        ))}
        <li className="mt-1 rounded-xl border border-line bg-bg/40 px-3 py-2.5 text-xs leading-relaxed text-fg-3">{t(`accounts.popup.require.${provider}`)}</li>
      </ol>
      <figure className="flex flex-col gap-2" aria-label={t('accounts.popup.example')}>
        <figcaption className="eyebrow">{t('accounts.popup.example')}</figcaption>
        <div className="flex flex-col gap-3 rounded-xl bg-[#F5F6F8] p-4 text-[#1F2430] shadow-lg">
          <div className="flex items-center gap-2">
            <PlatformChip platform={provider} size={22} />
            <span className="text-[11px] text-[#5B6275]">{t(`accounts.popup.consent.${provider}.site`)}</span>
          </div>
          <p className="text-[13px] leading-snug font-semibold">{t(`accounts.popup.consent.${provider}.title`, { app: 'Restream' })}</p>
          <ul className="flex flex-col gap-1.5 border-t border-[#DDE0E6] pt-2.5">
            {perms.map((p, i) => <li key={i} className="flex gap-1.5 text-[11.5px] leading-snug"><Check size={12} className="mt-0.5 shrink-0 text-[#1E8E3E]" /> {p}</li>)}
          </ul>
          <div className="flex justify-end gap-2 pt-1">
            <span className="rounded-md px-2.5 py-1 text-[11px] text-[#5B6275]">{t('common.cancel')}</span>
            <span className="rounded-md px-2.5 py-1 text-[11px] font-semibold text-white" style={{ background: consentColor[provider] }}>
              {t(`accounts.popup.consent.${provider}.button`)}
            </span>
          </div>
        </div>
      </figure>
    </div>
  );
}

/** Step-by-step registration of the platform app, ending with the client ID and secret and a first connection. */
function SetupGuide({ provider, app, canConnect, onClose, onConnect }: {
  provider: OAuthProvider; app: OAuthApps[OAuthProvider]; canConnect: boolean; onClose: () => void; onConnect: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [clientId, setClientId] = useState(app.clientId);
  const [secret, setSecret] = useState('');
  const [saved, setSaved] = useState(false);
  const steps = t(`accounts.guide.${provider}`, { returnObjects: true }) as GuideStep[];
  const origin = app.redirectUri ? new URL(app.redirectUri).origin : '';
  const values: Record<CopyKind, string> = {
    redirectUri: app.redirectUri,
    origin,
    domain: origin ? new URL(origin).hostname : '',
    scopes: app.scopes.join(provider === 'facebook' ? ', ' : ' '),
  };
  const configured = !!(app.clientId && app.clientSecretSet);
  const save = useMutation({
    mutationFn: () => api(`/api/accounts/apps/${provider}`, { method: 'PUT', body: { clientId: clientId.trim(), ...(secret ? { clientSecret: secret.trim() } : {}) } }),
    onSuccess: async () => {
      setSecret(''); setSaved(true);
      await Promise.all([qc.invalidateQueries({ queryKey: ['oauth-apps'] }), qc.invalidateQueries({ queryKey: ['accounts'] })]);
    },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };

  return (
    <Modal open onClose={onClose} wide title={<span className="flex items-center gap-2.5"><PlatformChip platform={provider} size={24} /> {t('accounts.guideTitle', { platform: platformMeta[provider].label })}</span>}>
      <p className="-mt-2 text-sm leading-relaxed text-fg-2">{t(`accounts.guideIntro.${provider}`)}</p>
      {provider === 'x' && <PaidNotice provider={provider} className="mb-0" />}
      {!app.redirectUri && <p className="rounded-xl border border-warn/40 bg-warn/[0.07] px-3 py-2.5 text-sm text-warn">{t('accounts.publicUrlMissing')}</p>}
      <ol className="flex flex-col gap-4">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 font-mono text-[11px] font-semibold text-accent">{i + 1}</span>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <span className="text-sm font-medium">{s.title}</span>
              <span className="text-[13px] leading-relaxed text-fg-2">{s.text}</span>
              {s.copy?.map((c) => (
                <div key={c} className="flex flex-col gap-1">
                  <span className="text-[11px] tracking-wide text-fg-3 uppercase">{t(`accounts.copyLabel.${c}`)}</span>
                  {values[c] ? (
                    <div className="flex items-center gap-1 rounded-xl border border-line bg-bg pl-3">
                      <code className={clsx('min-w-0 flex-1 py-2 font-mono text-xs leading-relaxed text-fg', c === 'scopes' ? 'break-words' : 'truncate')} title={values[c]}>{values[c]}</code>
                      <CopyButton value={values[c]} className="min-h-9 px-3" />
                    </div>
                  ) : <span className="text-xs text-warn">{t('accounts.publicUrlMissing')}</span>}
                </div>
              ))}
              {s.note && <span className="rounded-lg border-l-2 border-warn/60 bg-warn/[0.05] px-3 py-2 text-xs leading-relaxed text-fg-2">{s.note}</span>}
              {s.link && links[s.link] && (
                <a href={links[s.link]} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 self-start text-[13px]">{t('accounts.openStep')} <ExternalLink size={12} /></a>
              )}
            </div>
          </li>
        ))}
        <li className="flex gap-3">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent font-mono text-[11px] font-semibold text-ink">{steps.length + 1}</span>
          <form onSubmit={submit} className="flex min-w-0 flex-1 flex-col gap-3">
            <span className="text-sm font-medium">{t('accounts.pasteTitle')}</span>
            <Field label={t(`accounts.clientIdLabel.${provider}`)}>
              {(id) => <Input id={id} value={clientId} onChange={(e) => { setClientId(e.target.value); setSaved(false); }} className="font-mono text-[13px]" autoComplete="off" />}
            </Field>
            <Field label={t(`accounts.clientSecretLabel.${provider}`)} hint={app.clientSecretSet ? t('accounts.secretKeep') : undefined}>
              {(id) => <Input id={id} type="password" value={secret} onChange={(e) => { setSecret(e.target.value); setSaved(false); }} className="font-mono text-[13px]" autoComplete="off" placeholder={app.clientSecretSet ? '••••••••' : ''} />}
            </Field>
            <ErrorText error={save.error} />
            <div className="flex flex-wrap items-center justify-end gap-3">
              {saved && <span className="text-sm text-ok">{t('common.saved')}</span>}
              <Button type="submit" loading={save.isPending} disabled={!clientId.trim() || (!secret && !app.clientSecretSet)}>{t('common.save')}</Button>
            </div>
          </form>
        </li>
        <li className="flex gap-3">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 font-mono text-[11px] font-semibold text-accent">{steps.length + 2}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <span className="text-sm font-medium">{t('accounts.tryTitle')}</span>
            <span className="text-[13px] leading-relaxed text-fg-2">{t('accounts.tryText')}</span>
            {configured && canConnect
              ? <div className="max-w-xs"><ConnectButton provider={provider} onClick={onConnect} /></div>
              : <span className="text-xs text-fg-3">{t('accounts.tryAfterSave')}</span>}
          </div>
        </li>
      </ol>
    </Modal>
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
