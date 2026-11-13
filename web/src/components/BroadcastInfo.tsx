import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Clock, ImagePlus, Info, OctagonAlert, Pencil, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import { api, type Destination, type InfoOutcome, type InfoResult, type Stream } from '../lib/api';
import { Button, Card, ErrorText, Field, Input, Modal, inputClass } from './ui';
import { PlatformChip } from './media';

/** What Restream can change on a destination's platform. */
function reach(d: Destination): 'full' | 'textOnly' | 'titleOnly' | 'atStart' | 'manual' {
  if (d.auth !== 'account') return 'manual';
  if (d.platform === 'youtube') return 'full';
  if (d.platform === 'facebook') return 'textOnly';
  if (d.platform === 'twitch') return 'titleOnly';
  return 'atStart';
}

const resultTone: Record<InfoResult, string> = { updated: 'text-ok', pending: 'text-accent', next: 'text-fg-3', manual: 'text-warn', unsupported: 'text-fg-3', failed: 'text-danger' };
const resultIcon: Record<InfoResult, typeof Info> = { updated: CheckCircle2, pending: Clock, next: Clock, manual: Info, unsupported: Info, failed: OctagonAlert };

/** Dashboard card: the title, description and thumbnail viewers see, changed for every platform at once. */
export function BroadcastInfoCard({ stream, canOperate }: { stream: Stream; canOperate: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const title = stream.liveEvent?.title || stream.title;
  const description = stream.liveEvent ? stream.liveEvent.description : stream.description;
  const [thumbVersion] = useThumbVersion(stream);
  return (
    <Card
      eyebrow={t('broadcastInfo.eyebrow')}
      actions={canOperate ? <button onClick={() => setOpen(true)} className="flex items-center gap-1.5 text-sm text-accent hover:text-accent-hover"><Pencil size={14} /> {t('common.edit')}</button> : undefined}
    >
      <div className="flex gap-3">
        {stream.thumbnailSet && (
          <img src={`/api/streams/${stream.id}/thumbnail?v=${thumbVersion}`} alt="" className="aspect-video w-24 shrink-0 rounded-lg border border-line object-cover" />
        )}
        <div className="flex min-w-0 flex-col gap-1">
          <span className={clsx('font-display text-lg leading-snug font-semibold', !title && 'text-fg-3')}>{title || t('broadcastInfo.noTitle', { name: stream.name })}</span>
          {description && <p className="line-clamp-2 text-sm text-fg-2">{description}</p>}
          {stream.liveEvent && <span className="text-xs text-fg-3">{t('broadcastInfo.fromEvent')}</span>}
        </div>
      </div>
      {canOperate && <BroadcastInfoDialog stream={stream} open={open} onClose={() => setOpen(false)} />}
    </Card>
  );
}

/** Bumped after an upload so the browser fetches the new image. */
const versions = new Map<string, number>();
function useThumbVersion(stream: Stream): [number, () => void] {
  const [, force] = useState(0);
  return [versions.get(stream.id) ?? 0, () => { versions.set(stream.id, Date.now()); force((n) => n + 1); }];
}

function BroadcastInfoDialog({ stream, open, onClose }: { stream: Stream; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [title, setTitle] = useState(stream.liveEvent?.title || stream.title);
  const [description, setDescription] = useState(stream.liveEvent ? stream.liveEvent.description : stream.description);
  const [results, setResults] = useState<InfoOutcome[] | null>(null);
  const [thumbVersion, bump] = useThumbVersion(stream);
  const file = useRef<HTMLInputElement>(null);
  const anyLive = stream.destinations.some((d) => d.live);

  const save = useMutation({
    mutationFn: () => api<{ results: InfoOutcome[] }>(`/api/streams/${stream.id}/broadcast-info`, { method: 'PUT', body: { title, description, apply: true } }),
    onSuccess: (r) => setResults(r.results.filter((x) => x.result !== 'next')),
    onSettled: () => { qc.invalidateQueries({ queryKey: ['streams'] }); qc.invalidateQueries({ queryKey: ['events'] }); },
  });
  const upload = useMutation({
    mutationFn: async (f: File) => {
      if (f.size > 2 * 1024 * 1024) throw new Error(t('errors.thumbnail_too_large'));
      return api<{ results: InfoOutcome[] }>(`/api/streams/${stream.id}/thumbnail`, { method: 'PUT', raw: f, headers: { 'content-type': f.type } });
    },
    onSuccess: (r) => { bump(); if (r.results.length) setResults(r.results); },
    onSettled: () => qc.invalidateQueries({ queryKey: ['streams'] }),
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/streams/${stream.id}/thumbnail`, { method: 'DELETE' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['streams'] }),
  });

  const submit = (e: FormEvent) => { e.preventDefault(); setResults(null); save.mutate(); };

  return (
    <Modal open={open} onClose={() => { setResults(null); onClose(); }} wide title={t('broadcastInfo.title')}>
      <form onSubmit={submit} className="flex flex-col gap-5">
        <p className="text-sm leading-relaxed text-fg-2">{anyLive ? t('broadcastInfo.introLive') : t('broadcastInfo.intro')}</p>
        <Field label={t('broadcastInfo.titleLabel')} hint={t('broadcastInfo.titleHint', { count: title.length })}>
          {(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} placeholder={stream.name} />}
        </Field>
        <Field label={t('broadcastInfo.description')}>
          {(id) => <textarea id={id} rows={5} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} className={clsx(inputClass, 'py-2.5 text-sm')} />}
        </Field>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">{t('broadcastInfo.thumbnail')}</span>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex aspect-video w-40 items-center justify-center overflow-hidden rounded-lg border border-line bg-bg">
              {stream.thumbnailSet
                ? <img src={`/api/streams/${stream.id}/thumbnail?v=${thumbVersion}`} alt={t('broadcastInfo.thumbnail')} className="h-full w-full object-cover" />
                : <ImagePlus size={22} className="text-fg-3" />}
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                <Button type="button" onClick={() => file.current?.click()} loading={upload.isPending}><ImagePlus size={15} /> {stream.thumbnailSet ? t('broadcastInfo.replace') : t('broadcastInfo.upload')}</Button>
                {stream.thumbnailSet && <Button type="button" variant="ghost" onClick={() => remove.mutate()} loading={remove.isPending}><Trash2 size={15} /> {t('broadcastInfo.remove')}</Button>}
              </div>
              <span className="text-xs text-fg-3">{t('broadcastInfo.thumbnailHint')}</span>
              <input ref={file} type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ''; }} />
            </div>
          </div>
          <ErrorText error={upload.error ?? remove.error} />
        </div>

        {stream.destinations.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="eyebrow">{t('broadcastInfo.where')}</span>
            <ul className="flex flex-col divide-y divide-line rounded-xl border border-line bg-bg/40">
              {stream.destinations.map((d) => {
                const r = results?.find((x) => x.destinationId === d.id);
                const Icon = r ? resultIcon[r.result] : null;
                return (
                  <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                    <PlatformChip platform={d.platform} size={22} />
                    <span className="font-medium">{d.name}</span>
                    <span className="text-xs text-fg-3">{t(`broadcastInfo.reach_${reach(d)}`)}</span>
                    {r && Icon && (
                      <span className={clsx('ml-auto flex items-center gap-1.5 text-xs', resultTone[r.result])} title={r.error ?? undefined}>
                        <Icon size={14} /> {t(`broadcastInfo.result_${r.result}`)}{r.thumbnail === 'failed' ? ` · ${t('broadcastInfo.thumbnailFailed')}` : ''}
                      </span>
                    )}
                    {r?.error && <span className="basis-full pl-9 text-xs text-danger">{r.error}</span>}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <ErrorText error={save.error} />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" loading={save.isPending}>{anyLive ? t('broadcastInfo.saveLive') : t('common.save')}</Button>
          {results && !save.isPending && <span className="text-sm text-ok">{t('common.saved')}</span>}
          <Button type="button" variant="ghost" className="ml-auto" onClick={() => { setResults(null); onClose(); }}>{t('common.close')}</Button>
        </div>
      </form>
    </Modal>
  );
}
