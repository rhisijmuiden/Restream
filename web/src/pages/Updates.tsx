import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { clsx } from 'clsx';
import { ArrowRightLeft, CheckCircle2, Download, RefreshCw, TriangleAlert } from 'lucide-react';
import { api, type SystemInfo } from '../lib/api';
import { formatDate, shortSha } from '../lib/format';
import { Badge, Button, Card, ErrorText, KeyValue, Modal, PageHeader } from '../components/ui';

type Channel = 'production' | 'test';
interface Remote { channel: Channel; branch: string; version: string | null; commit: string; date: string | null; message: string }
interface Check {
  checkedAt: string;
  current: { version: string; commit: string; channel: Channel };
  channels: Record<Channel, Remote | { error: string }>;
  updateAvailable: boolean;
}
interface Status { state: 'idle' | 'queued' | 'running' | 'success' | 'failed' | 'rolled_back'; step?: string; channel?: Channel; message?: string; finishedAt?: string; log: string }

export function Updates() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const info = useQuery({ queryKey: ['info'], queryFn: () => api<SystemInfo>('/api/system/info') });
  const check = useQuery({ queryKey: ['update-check'], queryFn: () => api<Check>('/api/system/update/check'), enabled: false, retry: false });
  const [watching, setWatching] = useState(false);
  const status = useQuery({
    queryKey: ['update-status'],
    queryFn: () => api<Status>('/api/system/update/status'),
    refetchInterval: watching ? 2000 : false,
    retry: true,
  });
  const [confirmFor, setConfirmFor] = useState<Channel | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const startCommit = useRef<string | null>(null);

  // Deep links from the Info dialog (?check=1) and the sidebar channel switch (?switch=test).
  useEffect(() => {
    if (params.get('check')) check.refetch();
    const sw = params.get('switch');
    if (sw === 'production' || sw === 'test') { setConfirmFor(sw); check.refetch(); }
    if (params.size) setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const st = status.data;
  const active = st && (st.state === 'running' || st.state === 'queued');
  useEffect(() => { if (active) setWatching(true); }, [active]);

  // When the update finishes and the server reports a new build, reload the whole app.
  useEffect(() => {
    if (!watching || !st || active) return;
    if (st.state === 'success') {
      api<SystemInfo>('/api/system/info').then((i) => {
        if (i.commit !== startCommit.current) setTimeout(() => window.location.reload(), 1500);
      }).catch(() => {});
    }
    if (st.state !== 'success') setWatching(false);
  }, [st, active, watching]);

  async function install(channel: Channel) {
    setBusy(true); setError(null);
    try {
      startCommit.current = info.data?.commit ?? null;
      await api('/api/system/update', { method: 'POST', body: { channel } });
      setConfirmFor(null);
      setWatching(true);
      qc.invalidateQueries({ queryKey: ['update-status'] });
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  const current = info.data?.channel;
  const c = check.data;

  return (
    <>
      <PageHeader eyebrow={t('nav.administration')} title={t('updates.title')} subtitle={t('updates.subtitle')}
        actions={<Button variant="primary" onClick={() => check.refetch()} loading={check.isFetching}><RefreshCw size={16} /> {check.isFetching ? t('updates.checking') : t('updates.check')}</Button>} />

      {info.data && !info.data.updaterEnabled && (
        <div className="mb-6 flex items-start gap-3 rounded-2xl border border-warn/40 bg-warn/10 p-4 text-sm text-warn">
          <TriangleAlert size={18} className="mt-0.5 shrink-0" /> {t('updates.unavailable')}
        </div>
      )}
      <div className="mb-6 flex flex-col gap-3"><ErrorText error={error ?? check.error} /></div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card eyebrow={t('updates.current')} className="lg:col-span-1">
          {info.data && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <span className="font-display text-4xl font-semibold">v{info.data.version}</span>
                <Badge tone={info.data.channel === 'production' ? 'ok' : 'warn'} dot>{t(`channel.${info.data.channel}`)}</Badge>
              </div>
              <KeyValue items={[[t('updates.commit'), shortSha(info.data.commit)], [t('info.built'), info.data.builtAt ? formatDate(info.data.builtAt) : '—']]} />
              {c && 'commit' in c.channels[c.current.channel] && (
                <p className={clsx('flex items-center gap-2 text-sm', c.updateAvailable ? 'text-accent' : 'text-ok')}>
                  {c.updateAvailable ? <Download size={16} /> : <CheckCircle2 size={16} />}
                  {c.updateAvailable ? t('updates.available', { channel: t(`channel.${c.current.channel}`) }) : t('updates.upToDate')}
                </p>
              )}
              {c && <span className="text-xs text-fg-3">{t('updates.checkedAt', { time: formatDate(c.checkedAt) })}</span>}
            </div>
          )}
        </Card>

        {(['production', 'test'] as const).map((ch) => {
          const r = c?.channels[ch];
          const isCurrent = ch === current;
          const remote = r && 'commit' in r ? r : null;
          const newer = remote && remote.commit !== info.data?.commit;
          return (
            <Card key={ch} eyebrow={t('updates.latest', { channel: t(`channel.${ch}`) })} className={clsx(isCurrent && 'border-accent/40')}
              actions={isCurrent ? <Badge tone="accent">{t('updates.current')}</Badge> : undefined}>
              {!c && <p className="text-sm text-fg-3">—</p>}
              {r && 'error' in r && <p className="text-sm text-danger">{r.error}</p>}
              {remote && (
                <div className="flex flex-col gap-4">
                  <span className="font-display text-2xl font-semibold">{remote.version ? `v${remote.version}` : '—'}</span>
                  <KeyValue items={[[t('updates.commit'), shortSha(remote.commit)], [t('updates.published'), formatDate(remote.date)]]} />
                  <p className="line-clamp-2 text-sm text-fg-2">{remote.message}</p>
                  {isCurrent
                    ? <Button variant="primary" disabled={!newer || !info.data?.updaterEnabled || !!active} onClick={() => setConfirmFor(ch)}><Download size={16} /> {t('updates.install')}</Button>
                    : <Button disabled={!info.data?.updaterEnabled || !!active} onClick={() => setConfirmFor(ch)}><ArrowRightLeft size={16} /> {t('updates.switchTo', { channel: t(`channel.${ch}`) })}</Button>}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      <Card title={t('updates.progress')} className="mt-6"
        actions={st && <Badge dot tone={st.state === 'success' ? 'ok' : st.state === 'idle' ? 'neutral' : active ? 'accent' : 'danger'}>{t(`updates.state_${st.state}`)}{st.step && active ? ` · ${st.step}` : ''}</Badge>}>
        {st?.message && <p className="mb-3 text-sm text-fg-2">{st.message}</p>}
        <pre className="max-h-80 overflow-auto rounded-xl border border-line bg-bg p-4 font-mono text-xs leading-relaxed text-fg-2" aria-label={t('updates.log')}>
          {st?.log || '—'}
        </pre>
      </Card>

      <Modal open={!!confirmFor} onClose={() => setConfirmFor(null)} title={confirmFor && confirmFor !== current ? t('updates.switchTo', { channel: t(`channel.${confirmFor}`) }) : t('updates.install')}>
        {confirmFor && confirmFor !== current && <p className="text-sm text-fg-2">{t('updates.switchText')}</p>}
        <p className="text-sm text-fg-2">{confirmFor && t('updates.confirmInstall', { channel: t(`channel.${confirmFor}`) })}</p>
        {!info.data?.updaterEnabled && <p className="text-sm text-warn">{t('updates.unavailable')}</p>}
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmFor(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={!info.data?.updaterEnabled} onClick={() => confirmFor && install(confirmFor)}>{t('common.confirm')}</Button>
        </div>
      </Modal>
    </>
  );
}
