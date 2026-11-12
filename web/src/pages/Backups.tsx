import { Fragment, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import {
  ArchiveRestore, CheckCircle2, CloudUpload, DatabaseBackup, Fingerprint, KeyRound, Layers, Lock, PlugZap, RefreshCw, ShieldAlert, Trash2, TriangleAlert,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { formatBytes, formatDate } from '../lib/format';
import { Badge, Button, Card, CopyButton, ErrorText, Field, Input, Modal, PageHeader, Select, Toggle, inputClass } from '../components/ui';

type Protocol = 'scp' | 'ftps' | 'ftps-implicit' | 'ftp';
interface Target {
  protocol: Protocol; host: string; port: number; username: string; passwordSet: boolean; privateKeySet: boolean; publicKey: string;
  hostKeySha256: string; verifyCertificate: boolean; path: string;
}
interface BackupSettings {
  scheduleEnabled: boolean; time: string; full: 'daily' | 'weekly' | 'monthly'; fullWeekday: number;
  incremental: 'off' | 'daily' | 'every6h' | 'hourly'; keepChains: number; passphraseSet: boolean; configured: boolean; target: Target;
}
interface SettingsResponse { settings: BackupSettings; busy: boolean; serverTime: string; timeZone: string; safetyDumps: { name: string; size: number }[]; fileDirs: string[] }
interface RemoteBackup { id: string; type: 'full' | 'incremental'; chain: string; parent: string | null; level: number; createdAt: string; size: number; version: string; hostname: string; fileDirs: string[] }
interface Job {
  id: string; kind: 'backup' | 'restore'; type: 'full' | 'incremental' | null; trigger: 'manual' | 'schedule' | 'cli'; status: 'running' | 'success' | 'failed';
  backup_id: string | null; step: string | null; size_bytes: string | null; error: string | null; log: string; user_email: string | null; started_at: string; finished_at: string | null;
}

const ports: Record<Protocol, number> = { scp: 22, ftps: 21, 'ftps-implicit': 990, ftp: 21 };


export function Backups() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['backup-settings'], queryFn: () => api<SettingsResponse>('/api/backups/settings') });
  const [signedOut, setSignedOut] = useState(false);
  const jobs = useQuery({
    queryKey: ['backup-jobs'],
    queryFn: () => api<{ busy: boolean; jobs: Job[] }>('/api/backups/jobs'),
    refetchInterval: (query) => (query.state.data?.busy || query.state.data?.jobs.some((j) => j.status === 'running') ? 1500 : 15000),
    retry: (n, err) => !(err instanceof ApiError && err.status === 401) && n < 3,
  });
  const remote = useQuery({ queryKey: ['backups-remote'], queryFn: () => api<RemoteBackup[]>('/api/backups'), enabled: !!q.data?.settings.configured, retry: false });

  const [form, setForm] = useState<BackupSettings | null>(null);
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [passphrase2, setPassphrase2] = useState('');
  const [state, setState] = useState<{ busy?: string; ok?: string; error?: unknown; where?: string }>({});
  const [restoreFor, setRestoreFor] = useState<RemoteBackup | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [openLog, setOpenLog] = useState<string | null>(null);

  useEffect(() => { if (q.data) setForm(q.data.settings); }, [q.data]);
  useEffect(() => { if (jobs.error instanceof ApiError && jobs.error.status === 401) setSignedOut(true); }, [jobs.error]);

  const running = jobs.data?.jobs.find((j) => j.status === 'running');
  const wasRunning = useMemo(() => ({ id: '' }), []);
  useEffect(() => {
    // Refresh the remote list once a job finishes.
    if (running) wasRunning.id = running.id;
    else if (wasRunning.id) { wasRunning.id = ''; void qc.invalidateQueries({ queryKey: ['backups-remote'] }); }
  }, [running, wasRunning, qc]);

  const chains = useMemo(() => {
    const list = remote.data ?? [];
    const fulls = list.filter((b) => b.type === 'full');
    return fulls.map((f) => ({ full: f, items: list.filter((b) => b.chain === f.id && b.type === 'incremental').sort((a, b) => b.level - a.level) }));
  }, [remote.data]);

  if (signedOut) {
    return (
      <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-4 rounded-2xl border border-line bg-surface p-8 text-center">
        <ArchiveRestore size={40} className="text-accent" />
        <h1 className="font-display text-xl font-semibold">{t('backups.signedOutTitle')}</h1>
        <p className="text-sm leading-relaxed text-fg-2">{t('backups.signedOutText')}</p>
        <Button variant="primary" onClick={() => { qc.clear(); nav('/login'); }}>{t('backups.signInAgain')}</Button>
      </div>
    );
  }
  if (!form || !q.data) return null;

  const tg = form.target;
  const setT = (p: Partial<Target>) => setForm({ ...form, target: { ...tg, ...p } });

  async function act(where: string, fn: () => Promise<unknown>) {
    setState({ busy: where, where });
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['backup-settings'] });
      await qc.invalidateQueries({ queryKey: ['backup-jobs'] });
      setState({ ok: where, where });
      setTimeout(() => setState((s) => (s.ok ? {} : s)), 3500);
    } catch (error) { setState({ error, where }); }
  }

  function body(extra: Record<string, unknown> = {}) {
    return {
      scheduleEnabled: form!.scheduleEnabled, time: form!.time, full: form!.full, fullWeekday: Number(form!.fullWeekday),
      incremental: form!.incremental, keepChains: Number(form!.keepChains),
      target: {
        protocol: tg.protocol, host: tg.host.trim(), port: Number(tg.port) || 0, username: tg.username.trim(), verifyCertificate: tg.verifyCertificate, path: tg.path.trim(),
        ...(password ? { password } : {}), ...(privateKey ? { privateKey } : {}),
      },
      ...extra,
    };
  }

  const save = (where: string, extra: Record<string, unknown> = {}) => act(where, async () => {
    await api('/api/backups/settings', { method: 'PUT', body: body(extra) });
    setPassword(''); setPrivateKey(''); setShowPaste(false);
    await qc.invalidateQueries({ queryKey: ['backups-remote'] });
  });

  const err = (where: string) => (state.where === where ? <ErrorText error={state.error} /> : null);
  const ok = (where: string, text: string) => state.where === where && state.ok
    ? <span className="flex items-center gap-1.5 text-sm text-ok"><CheckCircle2 size={16} /> {text}</span> : null;

  const weekdays = Array.from({ length: 7 }, (_, d) => new Intl.DateTimeFormat(i18n.language === 'nl' ? 'nl-NL' : 'en-GB', { weekday: 'long' }).format(new Date(2026, 10, 8 + d)));
  const busy = !!running || q.data.busy;

  const savePassphrase = (e: FormEvent) => {
    e.preventDefault();
    if (passphrase !== passphrase2) { setState({ where: 'passphrase', error: new ApiError(400, 'passphrase_mismatch') }); return; }
    void save('passphrase', { passphrase }).then(() => { setPassphrase(''); setPassphrase2(''); });
  };

  return (
    <>
      <PageHeader eyebrow={t('nav.administration')} title={t('backups.title')} subtitle={t('backups.subtitle')}
        actions={(
          <>
            <Button disabled={!q.data.settings.configured || busy} loading={state.busy === 'runIncr'}
              onClick={() => act('runIncr', () => api('/api/backups/run', { method: 'POST', body: { type: 'incremental' } }))}>
              <Layers size={16} /> {t('backups.runIncremental')}
            </Button>
            <Button variant="primary" disabled={!q.data.settings.configured || busy} loading={state.busy === 'runFull'}
              onClick={() => act('runFull', () => api('/api/backups/run', { method: 'POST', body: { type: 'full' } }))}>
              <CloudUpload size={16} /> {t('backups.runFull')}
            </Button>
          </>
        )} />

      <div className="mb-6 flex flex-col gap-3">
        {err('runFull')}{err('runIncr')}
        {!q.data.settings.configured && (
          <div className="flex items-start gap-3 rounded-2xl border border-warn/40 bg-warn/10 p-4 text-sm text-warn">
            <TriangleAlert size={18} className="mt-0.5 shrink-0" /> {t('backups.notConfigured')}
          </div>
        )}
        {running && (
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-accent/40 bg-accent/5 p-4 text-sm">
            <span className="size-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" aria-hidden />
            <span className="font-medium">{t(running.kind === 'restore' ? 'backups.restoring' : 'backups.running')}</span>
            {running.step && <Badge tone="accent">{t(`backups.step_${running.step}`, { defaultValue: running.step })}</Badge>}
            <span className="font-mono text-xs text-fg-3">{running.backup_id}</span>
          </div>
        )}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card eyebrow={t('backups.locationEyebrow')} title={t('backups.location')}>
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void save('location'); }}>
            <Field label={t('backups.protocol')} hint={t(`backups.protocol_${tg.protocol}_hint`)}>
              {(id) => (
                <div id={id} role="radiogroup" className="grid grid-cols-2 gap-1 rounded-xl border border-line bg-bg p-1 sm:grid-cols-4">
                  {(['scp', 'ftps', 'ftps-implicit', 'ftp'] as const).map((p) => (
                    <button key={p} type="button" role="radio" aria-checked={tg.protocol === p}
                      onClick={() => setT({ protocol: p, port: Object.values(ports).includes(Number(tg.port)) || !tg.port ? ports[p] : tg.port })}
                      className={clsx('min-h-9 rounded-lg px-2 text-sm transition-colors', tg.protocol === p ? 'bg-surface-2 text-fg shadow-[inset_0_-2px_0_var(--rs-accent)]' : 'text-fg-3 hover:text-fg-2')}>
                      {t(`backups.protocol_${p}`)}
                    </button>
                  ))}
                </div>
              )}
            </Field>
            {tg.protocol === 'ftp' && <p className="flex items-start gap-2 rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn"><ShieldAlert size={16} className="shrink-0" /> {t('backups.ftpWarning')}</p>}
            <div className="grid gap-4 sm:grid-cols-[1fr_110px]">
              <Field label={t('backups.host')}>{(id) => <Input id={id} value={tg.host} onChange={(e) => setT({ host: e.target.value })} placeholder="backup.example.com" className="font-mono text-sm" />}</Field>
              <Field label={t('backups.port')}>{(id) => <Input id={id} type="number" min={1} max={65535} value={tg.port} onChange={(e) => setT({ port: Number(e.target.value) })} className="font-mono text-sm" />}</Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('backups.username')}>{(id) => <Input id={id} autoComplete="off" value={tg.username} onChange={(e) => setT({ username: e.target.value })} className="font-mono text-sm" />}</Field>
              <Field label={tg.protocol === 'scp' ? `${t('backups.password')} (${t('common.optional')})` : t('backups.password')} hint={tg.passwordSet ? t('backups.passwordSet') : undefined}>
                {(id) => <Input id={id} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={tg.passwordSet ? '••••••••' : ''} />}
              </Field>
            </div>
            <Field label={t('backups.path')} hint={t('backups.pathHint')}>{(id) => <Input id={id} value={tg.path} onChange={(e) => setT({ path: e.target.value })} placeholder="restream-backups" className="font-mono text-sm" />}</Field>

            {tg.protocol === 'scp' && (
              <div className="flex flex-col gap-3 rounded-xl border border-line bg-bg p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-medium"><KeyRound size={16} className="text-accent" /> {t('backups.sshKey')}</span>
                  <div className="flex gap-2">
                    <Button type="button" className="min-h-8 px-3" loading={state.busy === 'key'}
                      onClick={() => { if (!tg.privateKeySet || window.confirm(t('backups.keyRegenerateConfirm'))) void act('key', () => api('/api/backups/ssh-key', { method: 'POST' })); }}>
                      {tg.privateKeySet ? t('backups.keyRegenerate') : t('backups.keyGenerate')}
                    </Button>
                    <Button type="button" variant="ghost" className="min-h-8 px-3" onClick={() => setShowPaste(!showPaste)}>{t('backups.keyPaste')}</Button>
                  </div>
                </div>
                {tg.publicKey ? (
                  <>
                    <p className="text-xs leading-relaxed text-fg-3">{t('backups.keyHint')}</p>
                    <div className="flex items-start gap-2 rounded-lg border border-line bg-surface p-2">
                      <code className="flex-1 font-mono text-[11px] break-all text-accent">{tg.publicKey}</code>
                      <CopyButton value={tg.publicKey} className="min-h-8 px-2" />
                    </div>
                  </>
                ) : <p className="text-xs text-fg-3">{t('backups.keyNone')}</p>}
                {showPaste && (
                  <Field label={t('backups.keyPasteLabel')}>
                    {(id) => <textarea id={id} rows={5} value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" className={clsx(inputClass, 'py-2 font-mono text-xs')} />}
                  </Field>
                )}
                {err('key')}
                <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-xs">
                  <Fingerprint size={16} className="text-fg-3" />
                  <span className="text-fg-3">{t('backups.hostKey')}</span>
                  <code className="font-mono text-fg-2">{tg.hostKeySha256 || t('backups.hostKeyNone')}</code>
                  {tg.hostKeySha256 && (
                    <Button type="button" variant="ghost" className="ml-auto min-h-7 px-2 text-xs"
                      onClick={() => { if (window.confirm(t('backups.hostKeyForgetConfirm'))) void act('hostkey', () => api('/api/backups/forget-host-key', { method: 'POST' })); }}>
                      {t('backups.hostKeyForget')}
                    </Button>
                  )}
                </div>
              </div>
            )}
            {(tg.protocol === 'ftps' || tg.protocol === 'ftps-implicit') && (
              <Toggle checked={tg.verifyCertificate} onChange={(v) => setT({ verifyCertificate: v })} label={t('backups.verifyCertificate')} />
            )}

            {err('location')}{err('test')}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="primary" loading={state.busy === 'location'}>{t('common.save')}</Button>
              <Button type="button" loading={state.busy === 'test'} disabled={!tg.host}
                onClick={() => act('test', async () => { await api('/api/backups/settings', { method: 'PUT', body: body() }); setPassword(''); setPrivateKey(''); await api('/api/backups/test', { method: 'POST' }); })}>
                <PlugZap size={16} /> {t('backups.test')}
              </Button>
              {ok('location', t('common.saved'))}
              {ok('test', t('backups.testOk'))}
            </div>
          </form>
        </Card>

        <div className="flex flex-col gap-6">
          <Card eyebrow="AES-256-GCM" title={t('backups.encryption')} actions={<Lock size={20} className="text-accent" />}>
            <form className="flex flex-col gap-4" onSubmit={savePassphrase}>
              <p className="text-sm leading-relaxed text-fg-2">{t('backups.encryptionText')}</p>
              {form.passphraseSet && <Badge tone="ok" dot>{t('backups.passphraseSet')}</Badge>}
              <Field label={form.passphraseSet ? t('backups.passphraseNew') : t('backups.passphrase')} hint={t('backups.passphraseHint')}>
                {(id) => <Input id={id} type="password" autoComplete="new-password" minLength={12} required value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />}
              </Field>
              <Field label={t('backups.passphraseRepeat')}>
                {(id) => <Input id={id} type="password" autoComplete="new-password" minLength={12} required value={passphrase2} onChange={(e) => setPassphrase2(e.target.value)} />}
              </Field>
              {form.passphraseSet && <p className="text-xs leading-relaxed text-warn">{t('backups.passphraseChangeWarning')}</p>}
              {err('passphrase')}
              <div className="flex items-center gap-3">
                <Button type="submit" variant="primary" loading={state.busy === 'passphrase'}>{t('common.save')}</Button>
                {ok('passphrase', t('common.saved'))}
              </div>
            </form>
          </Card>

          <Card eyebrow={t('backups.scheduleEyebrow')} title={t('backups.schedule')}>
            <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void save('schedule'); }}>
              <Toggle checked={form.scheduleEnabled} onChange={(v) => setForm({ ...form, scheduleEnabled: v })} label={t('backups.scheduleEnabled')} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('backups.time')} hint={t('backups.serverTime', { time: q.data.serverTime, tz: q.data.timeZone })}>
                  {(id) => <Input id={id} type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} />}
                </Field>
                <Field label={t('backups.keepChains')} hint={t('backups.keepChainsHint')}>
                  {(id) => <Input id={id} type="number" min={1} max={52} value={form.keepChains} onChange={(e) => setForm({ ...form, keepChains: Number(e.target.value) })} />}
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('backups.fullEvery')}>
                  {(id) => (
                    <Select id={id} value={form.full} onChange={(e) => setForm({ ...form, full: e.target.value as BackupSettings['full'] })}>
                      {(['daily', 'weekly', 'monthly'] as const).map((v) => <option key={v} value={v}>{t(`backups.every_${v}`)}</option>)}
                    </Select>
                  )}
                </Field>
                {form.full === 'weekly' && (
                  <Field label={t('backups.weekday')}>
                    {(id) => (
                      <Select id={id} value={form.fullWeekday} onChange={(e) => setForm({ ...form, fullWeekday: Number(e.target.value) })}>
                        {weekdays.map((d, i) => <option key={d} value={i}>{d}</option>)}
                      </Select>
                    )}
                  </Field>
                )}
              </div>
              <Field label={t('backups.incrementalEvery')}>
                {(id) => (
                  <Select id={id} value={form.incremental} onChange={(e) => setForm({ ...form, incremental: e.target.value as BackupSettings['incremental'] })}>
                    {(['off', 'daily', 'every6h', 'hourly'] as const).map((v) => <option key={v} value={v}>{t(`backups.every_${v}`)}</option>)}
                  </Select>
                )}
              </Field>
              <p className="rounded-xl border border-line bg-bg p-3 text-xs leading-relaxed text-fg-2">
                {t('backups.summary', {
                  full: form.full === 'weekly' ? t('backups.summaryWeekly', { day: weekdays[form.fullWeekday], time: form.time }) : t(`backups.summary_${form.full}`, { time: form.time }),
                  incremental: t(`backups.summaryIncr_${form.incremental}`),
                  keep: form.keepChains,
                })}
              </p>
              {err('schedule')}
              <div className="flex items-center gap-3">
                <Button type="submit" variant="primary" loading={state.busy === 'schedule'}>{t('common.save')}</Button>
                {ok('schedule', t('common.saved'))}
              </div>
            </form>
          </Card>
        </div>
      </div>

      <Card eyebrow={t('backups.remoteEyebrow')} title={t('backups.remote')} className="mt-6"
        actions={<Button variant="ghost" disabled={!q.data.settings.configured} loading={remote.isFetching} onClick={() => remote.refetch()}><RefreshCw size={16} /> {t('backups.refresh')}</Button>}>
        {!q.data.settings.configured ? <p className="text-sm text-fg-3">{t('backups.notConfiguredShort')}</p>
          : remote.error ? <ErrorText error={remote.error} />
            : !chains.length ? <p className="text-sm text-fg-3">{remote.isLoading ? t('backups.loading') : t('backups.none')}</p> : (
              <div className="flex flex-col gap-4">
                {err('delete')}
                {chains.map(({ full, items }) => (
                  <div key={full.id} className="overflow-hidden rounded-xl border border-line">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-bg px-4 py-2.5">
                      <span className="flex items-center gap-2 text-xs text-fg-3"><DatabaseBackup size={14} /> {t('backups.chain', { n: items.length + 1 })}</span>
                      <Button variant="ghost" className="min-h-7 px-2 text-xs text-danger" disabled={busy}
                        onClick={() => { if (window.confirm(t('backups.deleteConfirm', { n: items.length + 1 }))) void act('delete', async () => { await api(`/api/backups/chains/${full.chain}`, { method: 'DELETE' }); await remote.refetch(); }); }}>
                        <Trash2 size={14} /> {t('backups.deleteChain')}
                      </Button>
                    </div>
                    <ul className="divide-y divide-line">
                      {[...items, full].map((b) => (
                        <li key={b.id} className={clsx('flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3', b.type === 'incremental' && 'pl-8')}>
                          <Badge tone={b.type === 'full' ? 'accent' : 'neutral'}>{t(`backups.type_${b.type}`)}{b.type === 'incremental' ? ` +${b.level}` : ''}</Badge>
                          <span className="min-w-36 text-sm">{formatDate(b.createdAt)}</span>
                          <span className="font-mono text-xs text-fg-3">{formatBytes(b.size)}</span>
                          <span className="font-mono text-xs text-fg-3">v{b.version} · {b.hostname}</span>
                          <Button className="ml-auto min-h-8 px-3" disabled={busy} onClick={() => { setRestoreFor(b); setConfirmText(''); setState({}); }}>
                            <ArchiveRestore size={16} /> {t('backups.restore')}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
      </Card>

      <Card title={t('backups.activity')} className="mt-6">
        {!jobs.data?.jobs.length ? <p className="text-sm text-fg-3">{t('backups.noActivity')}</p> : (
          <div className="-mx-5 overflow-x-auto sm:-mx-6">
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead className="border-b border-line">
                <tr className="eyebrow">
                  <th className="px-5 py-2.5 font-normal sm:px-6">{t('backups.started')}</th>
                  <th className="px-3 py-2.5 font-normal">{t('backups.job')}</th>
                  <th className="px-3 py-2.5 font-normal">{t('backups.backup')}</th>
                  <th className="px-3 py-2.5 font-normal">{t('backups.size')}</th>
                  <th className="px-5 py-2.5 font-normal sm:px-6">{t('common.status')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {jobs.data.jobs.map((j) => (
                  <Fragment key={j.id}>
                    <tr className="cursor-pointer align-top hover:bg-surface-2/40" onClick={() => setOpenLog(openLog === j.id ? null : j.id)}>
                      <td className="px-5 py-2.5 whitespace-nowrap text-fg-3 sm:px-6">{formatDate(j.started_at)}</td>
                      <td className="px-3 py-2.5">
                        {t(`backups.kind_${j.kind}`)}{j.type ? ` · ${t(`backups.type_${j.type}`)}` : ''}
                        <span className="block text-xs text-fg-3">{t(`backups.trigger_${j.trigger}`)}{j.user_email ? ` · ${j.user_email}` : ''}</span>
                      </td>
                      <td className="px-3 py-2.5 font-mono text-xs text-fg-2">{j.backup_id ?? '—'}</td>
                      <td className="px-3 py-2.5 font-mono text-xs text-fg-2">{j.size_bytes ? formatBytes(Number(j.size_bytes)) : '—'}</td>
                      <td className="px-5 py-2.5 sm:px-6">
                        <Badge dot tone={j.status === 'success' ? 'ok' : j.status === 'failed' ? 'danger' : 'accent'}>{t(`backups.status_${j.status}`)}</Badge>
                        {j.error && <span className="mt-1 block max-w-80 font-mono text-xs break-words text-danger">{j.error}</span>}
                      </td>
                    </tr>
                    {openLog === j.id && (
                      <tr><td colSpan={5} className="px-5 pb-4 sm:px-6">
                        <pre className="max-h-64 overflow-auto rounded-xl border border-line bg-bg p-3 font-mono text-xs leading-relaxed text-fg-2">{j.log || '—'}</pre>
                      </td></tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {q.data.safetyDumps.length > 0 && <p className="mt-4 text-xs text-fg-3">{t('backups.safetyDumps', { n: q.data.safetyDumps.length })}</p>}
      </Card>

      <Modal open={!!restoreFor} onClose={() => setRestoreFor(null)} title={t('backups.restoreTitle')} wide>
        {restoreFor && (
          <form className="flex flex-col gap-4" onSubmit={(e) => {
            e.preventDefault();
            void act('restore', async () => {
              await api('/api/backups/restore', { method: 'POST', body: { id: restoreFor.id, confirm: confirmText } });
              setRestoreFor(null);
            });
          }}>
            <div className="rounded-xl border border-line bg-bg p-3 font-mono text-xs text-fg-2">
              {restoreFor.id} · {formatDate(restoreFor.createdAt)} · v{restoreFor.version} · {restoreFor.hostname}
              {restoreFor.type === 'incremental' && <span className="mt-1 block text-fg-3">{t('backups.restoreChain', { n: restoreFor.level })}</span>}
            </div>
            <ul className="flex flex-col gap-2 text-sm leading-relaxed text-fg-2">
              {(['restoreWhat1', 'restoreWhat2', 'restoreWhat3', 'restoreWhat4'] as const).map((k) => (
                <li key={k} className="flex gap-2"><span className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" />{t(`backups.${k}`)}</li>
              ))}
            </ul>
            <Field label={t('backups.restoreConfirm')}>
              {(id) => <Input id={id} autoComplete="off" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="RESTORE" className="font-mono" />}
            </Field>
            {err('restore')}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setRestoreFor(null)}>{t('common.cancel')}</Button>
              <Button type="submit" variant="danger" disabled={confirmText !== 'RESTORE'} loading={state.busy === 'restore'}><ArchiveRestore size={16} /> {t('backups.restoreStart')}</Button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
