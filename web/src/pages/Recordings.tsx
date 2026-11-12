import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { CircleDot, Download, HardDrive, Pencil, Play, Trash2, Film } from 'lucide-react';
import { api, type Recording, type RecordingsResponse } from '../lib/api';
import { useMe } from '../lib/auth';
import { formatBytes, formatDate } from '../lib/format';
import { clock } from '../lib/streams';
import { Badge, Button, Card, ErrorText, Field, Input, Modal, PageHeader, Select } from '../components/ui';

export function Recordings() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const role = useMe().data!.user!.role;
  const canOperate = role !== 'viewer';
  const q = useQuery({
    queryKey: ['recordings'],
    queryFn: () => api<RecordingsResponse>('/api/recordings'),
    refetchInterval: (query) => (query.state.data?.recordings.some((r) => r.status === 'recording') ? 2000 : 15000),
  });
  const [playing, setPlaying] = useState<Recording | null>(null);
  const [renaming, setRenaming] = useState<Recording | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['recordings'] });

  const del = useMutation({
    mutationFn: async (r: Recording) => {
      if (!confirm(t('recordings.confirmDelete', { name: r.title || r.streamName }))) return;
      return api(`/api/recordings/${r.id}`, { method: 'DELETE' });
    },
    onSettled: refresh,
  });
  const retention = useMutation({
    mutationFn: (days: number) => api('/api/recordings/settings', { method: 'PUT', body: { retentionDays: days } }),
    onSettled: refresh,
  });

  const d = q.data;
  const recs = d?.recordings ?? [];
  const active = recs.filter((r) => r.status === 'recording');
  const usedPct = d?.disk ? Math.round(((d.disk.totalBytes - d.disk.freeBytes) / d.disk.totalBytes) * 100) : null;

  return (
    <>
      <PageHeader eyebrow={t('nav.broadcast')} title={t('recordings.title')} subtitle={t('recordings.subtitle')} />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat label={t('recordings.statCount')} value={String(recs.length)} sub={active.length ? t('recordings.activeNow', { count: active.length }) : undefined} live={active.length > 0} />
        <Stat label={t('recordings.statUsed')} icon={<HardDrive size={20} className="text-fg-3" />} value={formatBytes(d?.usedBytes ?? 0)} sub={d?.disk ? t('recordings.diskFree', { free: formatBytes(d.disk.freeBytes) }) : undefined}>
          {usedPct !== null && (
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-label={t('recordings.diskUsed', { pct: usedPct })}>
              <div className={clsx('h-full rounded-full', usedPct > 90 ? 'bg-danger' : usedPct > 75 ? 'bg-warn' : 'bg-accent')} style={{ width: `${usedPct}%` }} />
            </div>
          )}
        </Stat>
        <div className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-5">
          <span className="eyebrow">{t('recordings.retention')}</span>
          {role === 'admin' ? (
            <Select aria-label={t('recordings.retention')} value={d?.retentionDays ?? 0} onChange={(e) => retention.mutate(Number(e.target.value))}>
              {[0, 7, 30, 90, 180, 365].map((n) => <option key={n} value={n}>{n === 0 ? t('recordings.keepForever') : t('recordings.keepDays', { count: n })}</option>)}
            </Select>
          ) : (
            <span className="font-display text-2xl font-semibold">{d?.retentionDays ? t('recordings.keepDays', { count: d.retentionDays }) : t('recordings.keepForever')}</span>
          )}
          <span className="text-xs leading-relaxed text-fg-3">{t('recordings.retentionHint')}</span>
          <ErrorText error={retention.error} />
        </div>
      </div>

      <ErrorText error={del.error} />
      {q.data && recs.length === 0 ? (
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-line bg-surface/60 px-6 py-16 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl border border-accent/30 bg-accent/10 text-accent"><Film size={26} /></div>
          <h2 className="font-display text-xl font-semibold">{t('recordings.emptyTitle')}</h2>
          <p className="max-w-md text-sm leading-relaxed text-fg-2">{t('recordings.emptyText')}</p>
        </div>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {recs.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-5 gap-y-3 py-4 first:pt-0 last:pb-0">
                <button
                  onClick={() => r.status !== 'failed' && setPlaying(r)} disabled={r.status === 'failed'}
                  aria-label={t('recordings.play')}
                  className={clsx('relative flex aspect-video w-28 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-[radial-gradient(ellipse_at_center,#101830_0%,#070A12_75%)]',
                    r.status === 'recording' ? 'border-live/50' : 'border-line hover:border-accent/50')}
                >
                  {r.status === 'recording' ? <CircleDot size={20} className="pulse-dot text-live" /> : <Play size={18} className="text-fg-2" />}
                  <span className="absolute right-1 bottom-1 rounded bg-bg/80 px-1 font-mono text-[10px] text-fg-2">{clock(r.durationSeconds)}</span>
                </button>
                <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
                  <span className="truncate font-medium">{r.title || r.streamName}</span>
                  <span className="truncate text-xs text-fg-3">
                    {r.title ? `${r.streamName} · ` : ''}{formatDate(r.startedAt)}{r.startedBy ? ` · ${r.startedBy}` : ''}
                  </span>
                  {r.error && r.status === 'failed' && <span className="truncate font-mono text-[11px] text-warn" title={r.error}>{r.error}</span>}
                </div>
                <span className="font-mono text-xs text-fg-2">{formatBytes(r.sizeBytes)}</span>
                {r.status === 'recording' ? <Badge tone="live" dot>{t('recordings.recording')}</Badge>
                  : r.status === 'failed' ? <Badge tone="danger">{t('recordings.failed')}</Badge>
                    : <Badge tone="neutral">{r.video ? r.video.split(' ')[0].replace('H265', 'HEVC').replace('H264', 'H.264') : 'MP4'}</Badge>}
                <div className="flex gap-1">
                  {r.status !== 'failed' && (
                    <a href={`/api/recordings/${r.id}/file?download=1`} download={r.fileName} className="inline-flex min-h-9 items-center gap-2 rounded-xl px-3 text-sm text-fg-2 hover:bg-surface-2 hover:text-fg">
                      <Download size={15} /> <span className="hidden sm:inline">{t('recordings.download')}</span>
                    </a>
                  )}
                  {canOperate && <Button variant="ghost" className="min-h-9 px-2.5" onClick={() => setRenaming(r)} aria-label={t('recordings.rename')}><Pencil size={15} /></Button>}
                  {canOperate && r.status !== 'recording' && (
                    <Button variant="ghost" className="min-h-9 px-2.5 text-danger hover:text-danger" onClick={() => del.mutate(r)} aria-label={t('common.delete')}><Trash2 size={15} /></Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Modal open={!!playing} onClose={() => setPlaying(null)} wide title={playing ? playing.title || playing.streamName : ''}>
        {playing && (
          <div className="flex flex-col gap-4">
            <video src={`/api/recordings/${playing.id}/file`} controls autoPlay playsInline className="aspect-video w-full rounded-xl bg-black" />
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-fg-3">
              <span>{formatDate(playing.startedAt)} · {clock(playing.durationSeconds)} · {formatBytes(playing.sizeBytes)}{playing.video ? ` · ${playing.video}` : ''}</span>
              <a href={`/api/recordings/${playing.id}/file?download=1`} download={playing.fileName} className="flex items-center gap-1.5 text-sm"><Download size={14} /> {t('recordings.download')}</a>
            </div>
          </div>
        )}
      </Modal>
      <RenameModal rec={renaming} onClose={() => setRenaming(null)} onDone={refresh} />
    </>
  );
}

function Stat({ label, value, sub, live, icon, children }: { label: string; value: string; sub?: string; live?: boolean; icon?: ReactNode; children?: ReactNode }) {
  return (
    <div className={clsx('flex flex-col gap-1 rounded-2xl border bg-surface p-5', live ? 'border-live/40' : 'border-line')}>
      <span className="eyebrow flex items-center gap-2">{label}{live && <CircleDot size={12} className="pulse-dot text-live" />}</span>
      <span className="flex items-center gap-2 font-display text-3xl font-semibold">{icon}{value}</span>
      {sub && <span className="text-xs text-fg-3">{sub}</span>}
      {children}
    </div>
  );
}

function RenameModal({ rec, onClose, onDone }: { rec: Recording | null; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [lastFor, setLastFor] = useState<string | null>(null);
  if ((rec?.id ?? null) !== lastFor) { setLastFor(rec?.id ?? null); setTitle(rec?.title ?? ''); }
  const save = useMutation({
    mutationFn: () => api(`/api/recordings/${rec!.id}`, { method: 'PATCH', body: { title } }),
    onSuccess: () => { onDone(); onClose(); },
  });
  return (
    <Modal open={!!rec} onClose={onClose} title={t('recordings.rename')}>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="flex flex-col gap-4">
        <Field label={t('recordings.titleLabel')} hint={t('recordings.titleHint')}>
          {(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} autoFocus placeholder={rec?.streamName} />}
        </Field>
        <ErrorText error={save.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>{t('common.save')}</Button>
        </div>
      </form>
    </Modal>
  );
}
