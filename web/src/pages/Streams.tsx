import { useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Pencil, Plus, Power, RotateCw, Trash2, ExternalLink } from 'lucide-react';
import { api, type Stream } from '../lib/api';
import { useMe } from '../lib/auth';
import { useStreams } from '../lib/streams';
import { Button, Card, CopyButton, ErrorText, Field, Input, Modal, PageHeader, Toggle } from '../components/ui';
import { IngestBadge } from '../components/media';

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
    </Card>
  );
}
