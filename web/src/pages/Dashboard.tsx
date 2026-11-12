import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CircleDot, Radio, Sparkles, MonitorPlay } from 'lucide-react';
import { api, type SystemInfo } from '../lib/api';
import { useMe } from '../lib/auth';
import { formatDuration } from '../lib/format';
import { Badge, Button, Card, KeyValue } from '../components/ui';

export function Dashboard() {
  const { t } = useTranslation();
  const me = useMe().data!;
  const sys = useQuery({ queryKey: ['info'], queryFn: () => api<SystemInfo>('/api/system/info') });
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<unknown[]>('/api/users'), enabled: me.user!.role === 'admin' });

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center gap-4">
        <div className="flex flex-1 flex-col gap-1">
          <span className="eyebrow">{t('dashboard.eyebrow')}</span>
          <h1 className="font-display text-3xl font-semibold tracking-tight">{t('dashboard.title')}</h1>
        </div>
        <Badge tone="neutral" dot>{t('dashboard.noIngest')}</Badge>
        <Button disabled title={t('comingSoon')}><CircleDot size={16} className="text-live" /> {t('dashboard.record')}</Button>
        <Button variant="primary" disabled title={t('comingSoon')}><Radio size={16} /> {t('dashboard.goLive')}</Button>
      </header>

      <div className="flex items-start gap-4 rounded-2xl border border-accent/30 bg-accent/[0.06] p-5">
        <Sparkles size={20} className="mt-0.5 shrink-0 text-accent" />
        <div className="flex flex-col gap-1">
          <span className="font-medium">{t('dashboard.phaseTitle')}</span>
          <span className="text-sm leading-relaxed text-fg-2">{t('dashboard.phaseText')}</span>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <div className="flex min-w-0 flex-col gap-6">
          <section aria-label={t('dashboard.preview')} className="overflow-hidden rounded-2xl border border-line bg-surface">
            <div className="relative flex aspect-video items-center justify-center bg-[radial-gradient(ellipse_at_center,#101830_0%,#070A12_70%)]">
              <div className="flex flex-col items-center gap-3 px-6 text-center text-fg-3">
                <MonitorPlay size={40} strokeWidth={1.4} />
                <span className="text-sm">{t('dashboard.previewEmpty')}</span>
              </div>
              <span className="absolute top-4 left-4 font-mono text-xs text-fg-3">00:00:00:00</span>
            </div>
            <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
              {[['PROTOCOL', '—'], ['VIDEO', '—'], ['AUDIO', '—'], ['BITRATE', '—']].map(([k, v]) => (
                <div key={k} className="flex flex-col gap-1 bg-surface px-4 py-3">
                  <span className="eyebrow">{k}</span><span className="font-mono text-sm text-fg-2">{v}</span>
                </div>
              ))}
            </div>
          </section>
          <Card title={t('dashboard.destinations')}>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {[['YT', 'YouTube', 'var(--rs-youtube)'], ['FB', 'Facebook', 'var(--rs-facebook)'], ['SRT', 'Custom SRT', 'var(--rs-accent)']].map(([s, n, c]) => (
                <div key={s} className="flex items-center gap-3 rounded-xl border border-dashed border-line p-4 opacity-60">
                  <div className="flex size-9 items-center justify-center rounded-lg font-mono text-xs font-semibold text-ink" style={{ background: c }}>{s}</div>
                  <div className="flex flex-col"><span className="text-sm">{n}</span><span className="text-xs text-fg-3">{t('comingSoon')}</span></div>
                </div>
              ))}
            </div>
          </Card>
        </div>
        <aside className="flex flex-col gap-6">
          <Card eyebrow={t('dashboard.viewers')}>
            <span className="font-display text-5xl font-semibold text-fg-3">—</span>
          </Card>
          <Card eyebrow={t('dashboard.nextEvent')}>
            <span className="text-sm text-fg-3">{t('dashboard.nothingScheduled')}</span>
          </Card>
          <Card title={t('dashboard.system')}>
            {sys.data && (
              <KeyValue items={[
                [t('dashboard.version'), `v${sys.data.version}`],
                [t('dashboard.channel'), t(`channel.${sys.data.channel}`)],
                [t('dashboard.uptime'), formatDuration(sys.data.uptimeSeconds)],
                ...(users.data ? [[t('dashboard.users'), String(users.data.length)] as [string, string]] : []),
              ]} />
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}
