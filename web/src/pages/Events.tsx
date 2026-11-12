import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { CalendarClock, CalendarPlus, CircleDot, ExternalLink, Pencil, Play, RotateCw, Square, Trash2, X } from 'lucide-react';
import { api, type LiveEvent, type Privacy, type Stream } from '../lib/api';
import { useMe } from '../lib/auth';
import { useStreams } from '../lib/streams';
import { Badge, Button, Card, ErrorText, Field, Input, Modal, PageHeader, Select, Toggle, inputClass } from '../components/ui';
import { PlatformChip } from '../components/media';
import i18n from '../i18n';

export function useEvents() {
  return useQuery({ queryKey: ['events'], queryFn: () => api<LiveEvent[]>('/api/events'), refetchInterval: 10_000 });
}

const locale = () => (i18n.language === 'nl' ? 'nl-NL' : 'en-GB');
const fmt = (v: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale(), o).format(new Date(v));
const time = (v: string) => fmt(v, { hour: '2-digit', minute: '2-digit' });

/** "in 3 days", "in 2 hours" */
function relative(v: string, now = Date.now()) {
  const diff = new Date(v).getTime() - now;
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 3600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3600_000), 'hour');
  return rtf.format(Math.round(diff / 86_400_000), 'day');
}

export function Events() {
  const { t } = useTranslation();
  const canOperate = useMe().data!.user!.role !== 'viewer';
  const q = useEvents();
  const streams = useStreams().data?.streams ?? [];
  const [editing, setEditing] = useState<LiveEvent | 'new' | null>(null);
  const events = q.data ?? [];
  const live = events.filter((e) => e.status === 'live');
  const upcoming = events.filter((e) => e.status === 'scheduled');
  const past = events.filter((e) => e.status === 'ended' || e.status === 'cancelled').reverse();

  return (
    <>
      <PageHeader
        eyebrow={t('nav.broadcast')} title={t('events.title')} subtitle={t('events.subtitle')}
        actions={canOperate && streams.length > 0 && <Button variant="primary" onClick={() => setEditing('new')}><CalendarPlus size={16} /> {t('events.add')}</Button>}
      />
      {q.data && events.length === 0 && (
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-line bg-surface/60 px-6 py-16 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl border border-accent/30 bg-accent/10 text-accent"><CalendarClock size={26} /></div>
          <h2 className="font-display text-xl font-semibold">{t('events.emptyTitle')}</h2>
          <p className="max-w-md text-sm leading-relaxed text-fg-2">{t('events.emptyText')}</p>
        </div>
      )}
      <div className="flex flex-col gap-8">
        {live.length > 0 && <Section title={t('events.liveNow')}>{live.map((e) => <EventCard key={e.id} e={e} canOperate={canOperate} onEdit={() => setEditing(e)} />)}</Section>}
        {upcoming.length > 0 && <Section title={t('events.upcoming')}>{upcoming.map((e) => <EventCard key={e.id} e={e} canOperate={canOperate} onEdit={() => setEditing(e)} />)}</Section>}
        {past.length > 0 && <Section title={t('events.past')}>{past.map((e) => <EventCard key={e.id} e={e} canOperate={canOperate} onEdit={() => setEditing(e)} compact />)}</Section>}
      </div>
      <EventModal editing={editing} streams={streams} onClose={() => setEditing(null)} />
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="eyebrow">{title}</h2>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

function EventCard({ e, canOperate, onEdit, compact }: { e: LiveEvent; canOperate: boolean; onEdit: () => void; compact?: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const act = useMutation({
    mutationFn: async (a: 'start' | 'stop' | 'cancel' | 'retry' | 'delete') => {
      if (a === 'start' && !confirm(t('events.confirmStart', { title: e.title }))) return;
      if (a === 'stop' && !confirm(t('events.confirmStop', { title: e.title }))) return;
      if (a === 'cancel' && !confirm(t('events.confirmCancel', { title: e.title }))) return;
      if (a === 'delete') return api(`/api/events/${e.id}`, { method: 'DELETE' });
      return api(`/api/events/${e.id}/${a}`, { method: 'POST' });
    },
    onSettled: () => { qc.invalidateQueries({ queryKey: ['events'] }); qc.invalidateQueries({ queryKey: ['streams'] }); },
  });
  const failed = e.targets.some((x) => x.status === 'failed');
  const statusBadge = {
    scheduled: <Badge tone="accent">{relative(e.startsAt)}</Badge>,
    live: <Badge tone="live" dot>{t('events.status.live')}</Badge>,
    ended: <Badge tone="neutral">{e.startedAt ? t('events.status.ended') : t('events.status.missed')}</Badge>,
    cancelled: <Badge tone="neutral">{t('events.status.cancelled')}</Badge>,
  }[e.status];

  return (
    <div className={clsx('flex flex-wrap gap-5 rounded-2xl border bg-surface p-5', e.status === 'live' ? 'border-live/50' : 'border-line', compact && 'opacity-80')}>
      <div className={clsx('flex w-16 shrink-0 flex-col items-center justify-center rounded-xl border py-2', e.status === 'live' ? 'border-live/40 text-live' : 'border-accent/30 text-accent')}>
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase">{fmt(e.startsAt, { month: 'short' })}</span>
        <span className="font-display text-2xl leading-tight font-semibold">{fmt(e.startsAt, { day: 'numeric' })}</span>
        <span className="font-mono text-[10px] text-fg-3">{fmt(e.startsAt, { weekday: 'short' })}</span>
      </div>
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-display text-lg font-semibold">{e.title}</h3>
          {statusBadge}
          {e.record && <Badge tone="danger"><CircleDot size={10} /> {t('events.rec')}</Badge>}
        </div>
        <span className="text-sm text-fg-2">
          {time(e.startsAt)}{e.endsAt ? ` – ${time(e.endsAt)}` : ''} · {e.streamName}
          {e.status === 'scheduled' && !e.autoStart && ` · ${t('events.manualStart')}`}
        </span>
        {!compact && e.description && <p className="line-clamp-2 text-xs leading-relaxed text-fg-3">{e.description}</p>}
        {e.targets.length > 0 && (
          <ul className="mt-1 flex flex-wrap gap-2">
            {e.targets.map((x) => (
              <li key={x.destinationId} title={x.error ?? undefined}
                className={clsx('flex items-center gap-2 rounded-lg border py-1 pr-2.5 pl-1 text-xs', x.status === 'failed' ? 'border-warn/50 text-warn' : 'border-line text-fg-2')}>
                <PlatformChip platform={x.platform} size={20} />
                <span>{x.name}</span>
                <span className="text-fg-3">· {t(`events.target.${x.status}`)}</span>
                {x.watchUrl && <a href={x.watchUrl} target="_blank" rel="noreferrer" aria-label={t('events.openOnPlatform')}><ExternalLink size={12} /></a>}
              </li>
            ))}
          </ul>
        )}
        <ErrorText error={act.error} />
      </div>
      {canOperate && (
        <div className="flex flex-wrap items-start gap-1">
          {e.status === 'scheduled' && <>
            <Button variant="ghost" onClick={onEdit}><Pencil size={15} /> {t('common.edit')}</Button>
            {failed && <Button variant="ghost" onClick={() => act.mutate('retry')}><RotateCw size={15} /> {t('events.retry')}</Button>}
            <Button onClick={() => act.mutate('start')}><Play size={15} /> {t('events.startNow')}</Button>
            <Button variant="ghost" className="text-danger hover:text-danger" onClick={() => act.mutate('cancel')}><X size={15} /> {t('events.cancelEvent')}</Button>
          </>}
          {e.status === 'live' && <Button variant="danger" onClick={() => act.mutate('stop')}><Square size={14} /> {t('events.stop')}</Button>}
          {(e.status === 'ended' || e.status === 'cancelled') && (
            <Button variant="ghost" className="min-h-9 px-2.5 text-danger hover:text-danger" onClick={() => act.mutate('delete')} aria-label={t('common.delete')}><Trash2 size={15} /></Button>
          )}
        </div>
      )}
    </div>
  );
}

/** yyyy-mm-ddThh:mm in local time, for <input type="datetime-local">. */
function localInput(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

interface Form {
  streamId: string; title: string; description: string; start: string; end: string; autoStart: boolean; autoStop: boolean;
  record: boolean; privacy: Privacy; destinationIds: string[];
}

function EventModal({ editing, streams, onClose }: { editing: LiveEvent | 'new' | null; streams: Stream[]; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [f, setF] = useState<Form | null>(null);
  const [lastFor, setLastFor] = useState<string | null>(null);
  const key = editing === 'new' ? 'new' : editing?.id ?? null;
  if (key !== lastFor) {
    setLastFor(key);
    if (editing === 'new') {
      const start = new Date(Date.now() + 86_400_000); start.setMinutes(0, 0, 0);
      const s = streams[0];
      setF({
        streamId: s?.id ?? '', title: '', description: s?.description ?? '', start: localInput(start), end: localInput(new Date(start.getTime() + 90 * 60_000)),
        autoStart: true, autoStop: true, record: s?.autoRecord ?? false, privacy: 'public', destinationIds: s?.destinations.filter((d) => d.enabled).map((d) => d.id) ?? [],
      });
    } else if (editing) {
      setF({
        streamId: editing.streamId, title: editing.title, description: editing.description, start: localInput(new Date(editing.startsAt)),
        end: editing.endsAt ? localInput(new Date(editing.endsAt)) : '', autoStart: editing.autoStart, autoStop: editing.autoStop,
        record: editing.record, privacy: editing.privacy, destinationIds: editing.targets.map((x) => x.destinationId),
      });
    } else setF(null);
  }
  const set = (p: Partial<Form>) => setF((c) => (c ? { ...c, ...p } : c));
  const stream = streams.find((s) => s.id === f?.streamId);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        streamId: f!.streamId, title: f!.title, description: f!.description, startsAt: new Date(f!.start).toISOString(),
        endsAt: f!.end ? new Date(f!.end).toISOString() : null, autoStart: f!.autoStart, autoStop: f!.autoStop && !!f!.end,
        record: f!.record, privacy: f!.privacy, destinationIds: f!.destinationIds,
      };
      return editing === 'new' ? api('/api/events', { method: 'POST', body }) : api(`/api/events/${(editing as LiveEvent).id}`, { method: 'PUT', body });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['events'] }); onClose(); },
  });

  if (!f) return null;
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };
  const toggleDest = (id: string) => set({ destinationIds: f.destinationIds.includes(id) ? f.destinationIds.filter((x) => x !== id) : [...f.destinationIds, id] });

  return (
    <Modal open={!!editing} onClose={onClose} wide title={editing === 'new' ? t('events.addTitle') : t('events.editTitle')}>
      <form onSubmit={submit} className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('events.titleLabel')}>
            {(id) => <Input id={id} value={f.title} onChange={(e) => set({ title: e.target.value })} required maxLength={100} autoFocus placeholder={t('events.titlePlaceholder')} />}
          </Field>
          <Field label={t('events.stream')}>
            {(id) => (
              <Select id={id} value={f.streamId} disabled={editing !== 'new'}
                onChange={(e) => { const s = streams.find((x) => x.id === e.target.value); set({ streamId: e.target.value, destinationIds: s?.destinations.filter((d) => d.enabled).map((d) => d.id) ?? [] }); }}>
                {streams.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            )}
          </Field>
          <Field label={t('events.starts')}>
            {(id) => <Input id={id} type="datetime-local" value={f.start} onChange={(e) => set({ start: e.target.value })} required />}
          </Field>
          <Field label={t('events.ends')} hint={t('events.endsHint')}>
            {(id) => <Input id={id} type="datetime-local" value={f.end} min={f.start} onChange={(e) => set({ end: e.target.value })} />}
          </Field>
        </div>
        <Field label={t('events.description')} hint={t('events.descriptionHint')}>
          {(id) => <textarea id={id} rows={3} value={f.description} onChange={(e) => set({ description: e.target.value })} maxLength={5000} className={clsx(inputClass, 'py-2.5')} />}
        </Field>

        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-medium text-fg-2">{t('events.destinations')}</span>
          {stream && stream.destinations.length > 0 ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {stream.destinations.map((d) => {
                const on = f.destinationIds.includes(d.id);
                return (
                  <button key={d.id} type="button" role="checkbox" aria-checked={on} onClick={() => toggleDest(d.id)}
                    className={clsx('flex items-center gap-3 rounded-xl border p-3 text-left transition-colors', on ? 'border-accent bg-accent/[0.07]' : 'border-line hover:border-line-strong')}>
                    <PlatformChip platform={d.platform} size={30} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium">{d.name}</span>
                      <span className="truncate text-xs text-fg-3">{d.auth === 'account' ? t('events.announced', { account: d.account?.name ?? '—' }) : t('events.keyOnly')}</span>
                    </span>
                    <span className={clsx('flex size-5 items-center justify-center rounded-md border text-[11px]', on ? 'border-accent bg-accent text-ink' : 'border-line')}>{on ? '✓' : ''}</span>
                  </button>
                );
              })}
            </div>
          ) : <p className="text-sm text-fg-3">{t('dashboard.destinationsEmpty')}</p>}
          <p className="text-xs leading-relaxed text-fg-3">{t('events.destinationsHint')}</p>
        </div>

        <div className="grid gap-3 rounded-xl border border-line bg-bg/40 p-4 sm:grid-cols-2">
          <Toggle checked={f.autoStart} onChange={(v) => set({ autoStart: v })} label={t('events.autoStart')} />
          <Toggle checked={f.autoStop && !!f.end} disabled={!f.end} onChange={(v) => set({ autoStop: v })} label={t('events.autoStop')} />
          <Toggle checked={f.record} onChange={(v) => set({ record: v })} label={t('events.record')} />
          <Field label={t('events.privacy')}>
            {(id) => (
              <Select id={id} value={f.privacy} onChange={(e) => set({ privacy: e.target.value as Privacy })}>
                {(['public', 'unlisted', 'private'] as const).map((p) => <option key={p} value={p}>{t(`privacy.${p}`)}</option>)}
              </Select>
            )}
          </Field>
        </div>

        <ErrorText error={save.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>{editing === 'new' ? t('events.create') : t('common.save')}</Button>
        </div>
      </form>
    </Modal>
  );
}
