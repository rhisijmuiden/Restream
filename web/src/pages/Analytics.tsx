import { useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { BarChart3, Clock, Download, ExternalLink, Eye, MessageSquare, Trash2, TrendingUp } from 'lucide-react';
import { api, type Broadcast, type BroadcastDetail, type ChatMessage } from '../lib/api';
import { useMe } from '../lib/auth';
import { formatDate, formatDuration } from '../lib/format';
import { formatCount } from '../lib/live';
import { Badge, Button, Card, ErrorText, PageHeader } from '../components/ui';
import { PlatformChip } from '../components/media';
import { ChatList } from '../components/live';
import { ViewerChart } from '../components/ViewerChart';

/** Statistics per broadcast: duration, peak and average viewers, chat, and the viewer curve. */
export function Analytics() {
  const { t, i18n } = useTranslation();
  const [params, setParams] = useSearchParams();
  const list = useQuery({
    queryKey: ['broadcasts'],
    queryFn: () => api<{ broadcasts: Broadcast[] }>('/api/broadcasts?limit=200'),
    refetchInterval: (q) => (q.state.data?.broadcasts.some((b) => b.live) ? 5000 : 30000),
  });
  const items = list.data?.broadcasts ?? [];
  const selected = params.get('id') ?? items[0]?.id ?? null;

  const totals = useMemo(() => {
    const ended = items.filter((b) => !b.live);
    return {
      count: items.length,
      seconds: items.reduce((n, b) => n + b.durationSeconds, 0),
      best: items.reduce<Broadcast | null>((m, b) => (!m || b.peakViewers > m.peakViewers ? b : m), null),
      avg: ended.length ? Math.round(ended.reduce((n, b) => n + b.avgViewers, 0) / ended.length) : 0,
    };
  }, [items]);

  return (
    <>
      <PageHeader eyebrow={t('nav.broadcast')} title={t('analytics.title')} subtitle={t('analytics.subtitle')} />
      {list.isSuccess && items.length === 0 ? (
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-line bg-surface/60 px-6 py-16 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl border border-accent/30 bg-accent/10 text-accent"><BarChart3 size={26} /></div>
          <h2 className="font-display text-xl font-semibold">{t('analytics.emptyTitle')}</h2>
          <p className="max-w-md text-sm leading-relaxed text-fg-2">{t('analytics.emptyText')}</p>
        </div>
      ) : (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Tile icon={<BarChart3 size={15} />} label={t('analytics.broadcasts')} value={String(totals.count)} />
            <Tile icon={<Clock size={15} />} label={t('analytics.onAirTotal')} value={formatDuration(totals.seconds)} />
            <Tile icon={<TrendingUp size={15} />} label={t('analytics.bestPeak')} value={formatCount(totals.best?.peakViewers ?? 0, i18n.language)} sub={totals.best?.title} />
            <Tile icon={<Eye size={15} />} label={t('analytics.avgOfAvg')} value={formatCount(totals.avg, i18n.language)} />
          </div>
          <div className="grid gap-6 xl:grid-cols-[380px_1fr]">
            <Card title={t('analytics.history')} className="self-start">
              <ul className="-mx-2 flex max-h-[640px] flex-col overflow-y-auto">
                {items.map((b) => (
                  <li key={b.id}>
                    <button
                      onClick={() => setParams({ id: b.id })} aria-current={b.id === selected}
                      className={clsx('flex w-full flex-col gap-1 rounded-xl px-3 py-2.5 text-left transition-colors', b.id === selected ? 'bg-surface-2 shadow-[inset_2px_0_0_var(--rs-accent)]' : 'hover:bg-surface-2/60')}
                    >
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{b.title || b.streamName}</span>
                        {b.live && <Badge tone="live" dot>{t('analytics.live')}</Badge>}
                      </span>
                      <span className="flex flex-wrap gap-x-3 font-mono text-[11px] text-fg-3">
                        <span>{formatDate(b.startedAt)}</span>
                        <span>{formatDuration(b.durationSeconds)}</span>
                        <span className="flex items-center gap-1"><TrendingUp size={11} /> {formatCount(b.peakViewers, i18n.language)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
            {selected && <BroadcastView id={selected} />}
          </div>
        </>
      )}
    </>
  );
}

function Tile({ icon, label, value, sub }: { icon: ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-2xl border border-line bg-surface p-5">
      <span className="eyebrow flex items-center gap-2">{icon} {label}</span>
      <span className="truncate font-display text-3xl font-semibold tabular-nums">{value}</span>
      {sub && <span className="truncate text-xs text-fg-3">{sub}</span>}
    </div>
  );
}

function BroadcastView({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [, setParams] = useSearchParams();
  const isAdmin = useMe().data!.user!.role === 'admin';
  const q = useQuery({
    queryKey: ['broadcast', id],
    queryFn: () => api<BroadcastDetail>(`/api/broadcasts/${id}`),
    refetchInterval: (query) => (query.state.data?.live ? 10000 : false),
  });
  const chat = useQuery({
    queryKey: ['broadcast-chat', id],
    queryFn: () => api<{ messages: ChatMessage[]; more: boolean }>(`/api/broadcasts/${id}/chat?limit=1000`),
    refetchInterval: q.data?.live ? 10000 : false,
  });
  const del = useMutation({
    mutationFn: () => api(`/api/broadcasts/${id}`, { method: 'DELETE' }),
    onSuccess: () => { setParams({}); qc.invalidateQueries({ queryKey: ['broadcasts'] }); },
  });
  const b = q.data;
  if (!b) return <ErrorText error={q.error} />;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Card
        eyebrow={`${b.streamName} · ${formatDate(b.startedAt)}`}
        title={<span className="flex items-center gap-3">{b.title || b.streamName}{b.live && <Badge tone="live" dot>{t('analytics.live')}</Badge>}</span>}
        actions={isAdmin && !b.live ? (
          <Button variant="ghost" onClick={() => { if (confirm(t('analytics.confirmDelete'))) del.mutate(); }} loading={del.isPending} aria-label={t('analytics.delete')}>
            <Trash2 size={15} /> {t('analytics.delete')}
          </Button>
        ) : undefined}
      >
        <ErrorText error={del.error} />
        <div className="mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-4">
          {[
            [t('analytics.duration'), formatDuration(b.durationSeconds)],
            [t('analytics.peak'), formatCount(b.peakViewers, i18n.language)],
            [t('analytics.average'), formatCount(b.avgViewers, i18n.language)],
            [t('analytics.chatMessages'), formatCount(b.chatMessages, i18n.language)],
          ].map(([k, v]) => (
            <div key={k} className="flex flex-col gap-1 bg-surface px-4 py-3">
              <span className="eyebrow">{k}</span>
              <span className="font-display text-2xl font-semibold tabular-nums">{v}</span>
            </div>
          ))}
        </div>
        <span className="eyebrow mb-3 block">{t('analytics.viewersOverTime')}</span>
        <ViewerChart b={b} />
      </Card>

      <Card title={t('analytics.perDestination')}>
        <div className="-mx-2 overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="text-left">
                {[t('analytics.destination'), t('analytics.peak'), t('analytics.average'), t('analytics.chatMessages'), ''].map((h, i) => (
                  <th key={i} className={clsx('eyebrow px-2 pb-2 font-normal', i > 0 && i < 4 && 'text-right')}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.outputs.map((o) => (
                <tr key={o.id} className="border-t border-line">
                  <td className="px-2 py-2.5">
                    <span className="flex items-center gap-2.5"><PlatformChip platform={o.platform} size={24} /><span className="truncate">{o.name}</span></span>
                  </td>
                  {o.stats ? (
                    <>
                      <td className="px-2 text-right font-mono tabular-nums">{formatCount(o.peakViewers, i18n.language)}</td>
                      <td className="px-2 text-right font-mono tabular-nums">{formatCount(o.avgViewers, i18n.language)}</td>
                      <td className="px-2 text-right font-mono tabular-nums">{formatCount(o.chatMessages, i18n.language)}</td>
                    </>
                  ) : (
                    <td colSpan={3} className="px-2 text-right text-xs text-fg-3">{t('analytics.noStats')}</td>
                  )}
                  <td className="px-2 text-right">
                    {o.watchUrl && <a href={o.watchUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs">{t('dashboard.watch')} <ExternalLink size={12} /></a>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title={<span className="flex items-center gap-2"><MessageSquare size={17} /> {t('analytics.chat')}</span>}
        actions={b.chatMessages > 0 ? <a href={`/api/broadcasts/${b.id}/chat.csv`} className="flex items-center gap-1.5 text-sm"><Download size={14} /> {t('analytics.exportCsv')}</a> : undefined}
        className="flex h-[520px] flex-col"
      >
        <ChatList messages={chat.data?.messages ?? []} className="flex-1" empty={t('analytics.noChat')} />
        {chat.data?.more && <p className="mt-2 text-xs text-fg-3">{t('analytics.chatTruncated')}</p>}
      </Card>
    </div>
  );
}
