import { useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Pencil, Plus, Power, RotateCw, Trash2, ExternalLink, ShieldPlus, ImageUp } from 'lucide-react';
import { api, ApiError, type Stream } from '../lib/api';
import { useMe } from '../lib/auth';
import { useStreams } from '../lib/streams';
import { Button, Card, CopyButton, ErrorText, Field, Input, Modal, PageHeader, Toggle } from '../components/ui';
import { IngestBadge, Segmented } from '../components/media';
import { StreamEmbed } from '../components/StreamEmbed';
import { inputClass } from '../components/ui';

export function Streams() {
  const { t } = useTranslation();
  const role = useMe().data!.user!.role;
  const canOperate = role !== 'viewer';
  const q = useStreams();
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<Stream | 'new' | null>(params.get('new') ? 'new' : null);

  const close = () => { setEditing(null); if (params.get('new')) setParams({}); };

  return (
    <>
      <PageHeader
        eyebrow={t('nav.broadcast')} title={t('streams.title')} subtitle={t('streams.subtitle')}
        actions={canOperate && <Button variant="primary" onClick={() => setEditing('new')}><Plus size={16} /> {t('streams.add')}</Button>}
      />
      <div className="flex flex-col gap-6">
        {q.data?.streams.length === 0 && (
          <div className="rounded-2xl border border-dashed border-line bg-surface/60 px-6 py-12 text-center text-sm text-fg-2">{t('streams.empty')}</div>
        )}
        {q.data?.streams.map((s) => <StreamCard key={s.id} s={s} role={role} onEdit={() => setEditing(s)} />)}
      </div>
      <StreamModal stream={editing} onClose={close} />
    </>
  );
}

function StreamModal({ stream, onClose }: { stream: Stream | 'new' | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [lastFor, setLastFor] = useState<string | null>(null);
  const key = stream === 'new' ? 'new' : stream?.id ?? null;
  if (key !== lastFor) { setLastFor(key); setName(stream && stream !== 'new' ? stream.name : ''); }

  const save = useMutation({
    mutationFn: () => stream === 'new'
      ? api('/api/streams', { method: 'POST', body: { name } })
      : api(`/api/streams/${(stream as Stream).id}`, { method: 'PATCH', body: { name } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['streams'] }); onClose(); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };

  return (
    <Modal open={stream !== null} onClose={onClose} title={stream === 'new' ? t('streams.addTitle') : t('streams.rename')}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label={t('common.name')} hint={stream === 'new' ? t('streams.nameHint') : undefined}>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} autoFocus placeholder={t('streams.namePlaceholder')} />}
        </Field>
        <ErrorText error={save.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>{stream === 'new' ? t('streams.create') : t('common.save')}</Button>
        </div>
      </form>
    </Modal>
  );
}

function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="eyebrow">{label}</span>
      {children}
      {hint && <span className="text-xs leading-relaxed text-fg-3">{hint}</span>}
    </div>
  );
}

function CopyField({ value, secret }: { value: string; secret?: boolean }) {
  const { t } = useTranslation();
  const [show, setShow] = useState(!secret);
  return (
    <div className="flex items-center gap-1 rounded-xl border border-line bg-bg pl-3">
      <code className="min-w-0 flex-1 truncate py-2 font-mono text-[13px] text-fg">{show ? value : '•'.repeat(24)}</code>
      {secret && (
        <Button type="button" variant="ghost" className="min-h-9 px-2.5" onClick={() => setShow((v) => !v)} aria-label={show ? t('streams.hide') : t('streams.show')}>
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </Button>
      )}
      <CopyButton value={value} className="min-h-9 px-3" />
    </div>
  );
}

function StreamCard({ s, role, onEdit }: { s: Stream; role: string; onEdit: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const canOperate = role !== 'viewer';
  const refresh = () => qc.invalidateQueries({ queryKey: ['streams'] });
  const act = useMutation({
    mutationFn: async (action: 'rotate' | 'toggle' | 'playback' | 'delete') => {
      switch (action) {
        case 'rotate':
          if (!confirm(t('streams.confirmRotate'))) return;
          return api(`/api/streams/${s.id}/rotate-key`, { method: 'POST' });
        case 'toggle':
          if (s.enabled && !confirm(t('streams.confirmDisable'))) return;
          return api(`/api/streams/${s.id}`, { method: 'PATCH', body: { enabled: !s.enabled } });
        case 'playback':
          return api(`/api/streams/${s.id}`, { method: 'PATCH', body: { playbackEnabled: !s.playbackEnabled } });
        case 'delete':
          if (!confirm(t('streams.confirmDelete', { name: s.name }))) return;
          return api(`/api/streams/${s.id}`, { method: 'DELETE' });
      }
    },
    onSettled: refresh,
  });

  return (
    <Card
      eyebrow={<span className="flex items-center gap-2"><IngestBadge status={s.status} enabled={s.enabled} /></span>}
      title={s.name}
      actions={canOperate && (
        <div className="flex flex-wrap gap-1">
          <Button variant="ghost" onClick={onEdit}><Pencil size={15} /> {t('streams.rename')}</Button>
          <Button variant="ghost" onClick={() => act.mutate('toggle')}><Power size={15} /> {s.enabled ? t('streams.disable') : t('streams.enable')}</Button>
          {role === 'admin' && <Button variant="ghost" className="text-danger hover:text-danger" onClick={() => act.mutate('delete')}><Trash2 size={15} /> {t('common.delete')}</Button>}
        </div>
      )}
    >
      <ErrorText error={act.error} />
      <div className="grid gap-8 lg:grid-cols-2">
        <section className="flex flex-col gap-4">
          <h3 className="font-display text-base font-semibold">{t('streams.ingest')}</h3>
          {s.ingest.streamKey ? (
            <>
              <Row label={t('streams.rtmpServer')} hint={t('streams.obsHint')}><CopyField value={s.ingest.rtmpServer} /></Row>
              <Row label={t('streams.streamKey')}><CopyField value={s.ingest.streamKey} secret /></Row>
              <Row label={t('streams.srtUrl')} hint={t('streams.srtHint')}><CopyField value={s.ingest.srtUrl!} secret /></Row>
              <div>
                <Button variant="secondary" onClick={() => act.mutate('rotate')} loading={act.isPending && act.variables === 'rotate'}>
                  <RotateCw size={15} /> {t('streams.rotate')}
                </Button>
                <p className="mt-2 text-xs leading-relaxed text-fg-3">{t('streams.rotateHint')}</p>
              </div>
            </>
          ) : (
            <p className="text-sm text-fg-3">{t('streams.keysHidden')}</p>
          )}
        </section>
        <section className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-display text-base font-semibold">{t('streams.playback')}</h3>
            <Toggle checked={s.playbackEnabled} onChange={() => act.mutate('playback')} disabled={!canOperate} label={t('streams.playbackPublic')} />
          </div>
          <p className="text-xs leading-relaxed text-fg-3">{t('streams.playbackHint')}</p>
          {s.playbackEnabled && (
            <>
              <Row label={t('streams.hls')}><CopyField value={s.playback.hls} /></Row>
              <Row label={t('streams.whep')}><CopyField value={s.playback.whep} /></Row>
              <Row label={t('streams.pages')}>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  <a href={s.playback.webrtcPage} target="_blank" rel="noreferrer" className="flex items-center gap-1">{t('dashboard.openWebrtc')} <ExternalLink size={13} /></a>
                  <a href={s.playback.hlsPage} target="_blank" rel="noreferrer" className="flex items-center gap-1">{t('dashboard.openHls')} <ExternalLink size={13} /></a>
                </div>
              </Row>
            </>
          )}
        </section>
      </div>
      <div className="mt-6"><Failover s={s} canOperate={canOperate} /></div>
      {s.playbackEnabled && <div className="mt-6"><StreamEmbed s={s} canOperate={canOperate} /></div>}
      <div className="mt-6"><BroadcastDetails s={s} canOperate={canOperate} /></div>
    </Card>
  );
}

/** Title and description for broadcasts Restream creates on connected accounts, and automatic recording. */
function BroadcastDetails({ s, canOperate }: { s: Stream; canOperate: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [title, setTitle] = useState(s.title);
  const [description, setDescription] = useState(s.description);
  const [lastFor, setLastFor] = useState(`${s.id}|${s.title}|${s.description}`);
  const sig = `${s.id}|${s.title}|${s.description}`;
  if (sig !== lastFor) { setLastFor(sig); setTitle(s.title); setDescription(s.description); }
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: (body: object) => api(`/api/streams/${s.id}`, { method: 'PATCH', body }),
    onSuccess: () => { setSaved(true); setTimeout(() => setSaved(false), 2000); qc.invalidateQueries({ queryKey: ['streams'] }); },
  });
  const dirty = title !== s.title || description !== s.description;
  return (
    <section className="grid gap-8 border-t border-line pt-6 lg:grid-cols-2">
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate({ title, description }); }}>
        <div className="flex flex-col gap-1">
          <h3 className="font-display text-base font-semibold">{t('streams.details')}</h3>
          <p className="text-xs leading-relaxed text-fg-3">{t('streams.detailsHint')}</p>
        </div>
        <Field label={t('streams.broadcastTitle')}>
          {(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} placeholder={s.name} disabled={!canOperate} />}
        </Field>
        <Field label={t('streams.broadcastDescription')}>
          {(id) => <textarea id={id} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} disabled={!canOperate} className={`${inputClass} py-2.5`} />}
        </Field>
        {canOperate && (
          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" disabled={!dirty} loading={save.isPending}>{t('common.save')}</Button>
            {saved && <span className="text-sm text-ok">{t('common.saved')}</span>}
          </div>
        )}
        <ErrorText error={save.error} />
      </form>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h3 className="font-display text-base font-semibold">{t('streams.recording')}</h3>
          <p className="text-xs leading-relaxed text-fg-3">{t('streams.recordingHint')}</p>
        </div>
        <Toggle checked={s.autoRecord} disabled={!canOperate} onChange={(v) => save.mutate({ autoRecord: v })} label={t('streams.autoRecord')} />
      </div>
    </section>
  );
}

/** Backup ingest (second key that takes over automatically) and the fallback image when no feed comes in. */
function Failover({ s, canOperate }: { s: Stream; canOperate: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['streams'] });
  const [minutes, setMinutes] = useState(s.fallback.minutes);
  const [switchBack, setSwitchBack] = useState(s.fallback.switchBackSeconds);
  const sig = `${s.id}|${s.fallback.minutes}|${s.fallback.switchBackSeconds}`;
  const [lastFor, setLastFor] = useState(sig);
  if (sig !== lastFor) { setLastFor(sig); setMinutes(s.fallback.minutes); setSwitchBack(s.fallback.switchBackSeconds); }
  const [imageVersion, setImageVersion] = useState(0);
  const [saved, setSaved] = useState(false);

  const backup = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (!enabled && !confirm(t('failover.confirmRemove'))) return;
      if (enabled && s.backupIngest.configured && !confirm(t('failover.confirmRotate'))) return;
      return api(`/api/streams/${s.id}/backup-key`, { method: 'POST', body: { enabled } });
    },
    onSettled: refresh,
  });
  const patch = useMutation({
    mutationFn: (body: object) => api(`/api/streams/${s.id}`, { method: 'PATCH', body }),
    onSuccess: () => { setSaved(true); setTimeout(() => setSaved(false), 2000); },
    onSettled: refresh,
  });
  const image = useMutation({
    mutationFn: async (file: File | null) => {
      if (!file) return api(`/api/streams/${s.id}/fallback-image`, { method: 'DELETE' });
      if (file.size > 8 * 1024 * 1024) throw new ApiError(413, 'image_too_large');
      const res = await fetch(`/api/streams/${s.id}/fallback-image`, {
        method: 'PUT', credentials: 'same-origin', headers: { 'x-restream': '1', 'content-type': file.type || 'image/png' }, body: file,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new ApiError(res.status, data?.error ?? 'request_failed');
      return data;
    },
    onSuccess: () => setImageVersion((v) => v + 1),
    onSettled: refresh,
  });

  return (
    <section className="grid gap-8 border-t border-line pt-6 lg:grid-cols-2">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="font-display text-base font-semibold">{t('failover.backupTitle')}</h3>
            {s.backupIngest.configured && <IngestBadge status={s.source.backup} enabled={s.enabled} />}
          </div>
          <p className="text-xs leading-relaxed text-fg-3">{t('failover.backupHint', { seconds: s.fallback.switchBackSeconds })}</p>
        </div>
        {s.backupIngest.configured ? (
          s.backupIngest.streamKey ? (
            <>
              <Row label={t('failover.backupKey')} hint={t('failover.backupKeyHint', { server: s.ingest.rtmpServer })}><CopyField value={s.backupIngest.streamKey} secret /></Row>
              <Row label={t('streams.srtUrl')}><CopyField value={s.backupIngest.srtUrl!} secret /></Row>
              {canOperate && (
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => backup.mutate(true)} loading={backup.isPending && backup.variables === true}><RotateCw size={15} /> {t('streams.rotate')}</Button>
                  <Button variant="ghost" className="text-danger hover:text-danger" onClick={() => backup.mutate(false)} loading={backup.isPending && backup.variables === false}><Trash2 size={15} /> {t('failover.remove')}</Button>
                </div>
              )}
            </>
          ) : <p className="text-sm text-fg-3">{t('streams.keysHidden')}</p>
        ) : canOperate ? (
          <div><Button variant="secondary" onClick={() => backup.mutate(true)} loading={backup.isPending}><ShieldPlus size={15} /> {t('failover.create')}</Button></div>
        ) : <p className="text-sm text-fg-3">{t('failover.none')}</p>}
        {s.backupIngest.configured && (
          <Field label={t('failover.switchBack')} hint={t('failover.switchBackHint')}>
            {(id) => (
              <div className="flex items-center gap-2">
                <Input id={id} type="number" min={0} max={600} value={switchBack} onChange={(e) => setSwitchBack(Number(e.target.value))} disabled={!canOperate} className="max-w-32" />
                <span className="text-sm text-fg-3">{t('failover.seconds')}</span>
                {canOperate && switchBack !== s.fallback.switchBackSeconds && <Button variant="primary" onClick={() => patch.mutate({ switchBackSeconds: switchBack })} loading={patch.isPending}>{t('common.save')}</Button>}
              </div>
            )}
          </Field>
        )}
        <ErrorText error={backup.error} />
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h3 className="font-display text-base font-semibold">{t('failover.fallbackTitle')}</h3>
          <p className="text-xs leading-relaxed text-fg-3">{t('failover.fallbackHint')}</p>
        </div>
        <Segmented
          className="self-start" label={t('failover.fallbackTitle')} value={s.fallback.mode}
          onChange={(v) => { if (canOperate && (v !== 'image' || s.fallback.imageSet)) patch.mutate({ fallbackMode: v }); }}
          options={[
            { value: 'off', label: t('failover.modeOff') },
            { value: 'standard', label: t('failover.modeStandard') },
            ...(s.fallback.imageSet ? [{ value: 'image' as const, label: t('failover.modeImage') }] : []),
          ]}
        />
        <div className="flex flex-wrap items-start gap-4">
          <img
            src={`/api/streams/${s.id}/fallback-image?v=${imageVersion}-${s.fallback.imageSet ? 1 : 0}`} alt={t('failover.previewAlt')}
            className={`aspect-video w-56 rounded-xl border border-line bg-bg object-contain ${s.fallback.mode === 'off' ? 'opacity-40' : ''}`}
          />
          {canOperate && (
            <div className="flex flex-col gap-2">
              <label className="inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border border-line bg-surface-2 px-4 text-sm font-medium text-fg transition-colors hover:border-line-strong">
                <ImageUp size={15} /> {s.fallback.imageSet ? t('failover.replaceImage') : t('failover.uploadImage')}
                <input type="file" accept="image/png,image/jpeg" className="sr-only" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) image.mutate(file); }} />
              </label>
              {s.fallback.imageSet && <Button variant="ghost" onClick={() => image.mutate(null)} loading={image.isPending && image.variables === null}>{t('failover.removeImage')}</Button>}
              <span className="max-w-56 text-xs leading-relaxed text-fg-3">{t('failover.imageHint')}</span>
            </div>
          )}
        </div>
        {s.fallback.mode !== 'off' && (
          <Field label={t('failover.maxMinutes')} hint={t('failover.maxMinutesHint')}>
            {(id) => (
              <div className="flex items-center gap-2">
                <Input id={id} type="number" min={1} max={720} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} disabled={!canOperate} className="max-w-32" />
                <span className="text-sm text-fg-3">{t('failover.minutes')}</span>
                {canOperate && minutes !== s.fallback.minutes && <Button variant="primary" onClick={() => patch.mutate({ fallbackMinutes: minutes })} loading={patch.isPending}>{t('common.save')}</Button>}
              </div>
            )}
          </Field>
        )}
        {saved && <span className="text-sm text-ok">{t('common.saved')}</span>}
        <ErrorText error={patch.error ?? image.error} />
      </div>
    </section>
  );
}
