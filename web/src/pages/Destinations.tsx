import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { ExternalLink, Pencil, Plus, Trash2, Link2 } from 'lucide-react';
import { api, type AccountsResponse, type Destination, type Orientation, type Platform, type PlatformPreset, type Privacy, type Stream } from '../lib/api';
import { useMe } from '../lib/auth';
import { formatKbps, platformMeta, usePresets, useStreams } from '../lib/streams';
import { Button, Card, ErrorText, Field, Input, Modal, PageHeader, Select, Toggle } from '../components/ui';
import { OutputBadge, PlatformChip, Segmented } from '../components/media';

type Editing = { stream: Stream; dest: Destination | null } | null;

export function Destinations() {
  const { t } = useTranslation();
  const canOperate = useMe().data!.user!.role !== 'viewer';
  const q = useStreams();
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<Editing>(null);
  const streams = q.data?.streams ?? [];
  // "?new=1" from the dashboard opens the form for the first stream.
  const first = streams[0];
  useEffect(() => {
    if (params.get('new') && first && canOperate) {
      setEditing({ stream: first, dest: null });
      setParams({}, { replace: true });
    }
  }, [params, first, canOperate, setParams]);

  return (
    <>
      <PageHeader eyebrow={t('nav.broadcast')} title={t('destinations.title')} subtitle={t('destinations.subtitle')} />
      {q.data && streams.length === 0 && (
        <div className="rounded-2xl border border-dashed border-line bg-surface/60 px-6 py-12 text-center text-sm text-fg-2">
          {t('destinations.noStreams')} <Link to="/streams?new=1">{t('streams.add')} →</Link>
        </div>
      )}
      <div className="flex flex-col gap-6">
        {streams.map((s) => (
          <Card
            key={s.id}
            eyebrow={t('destinations.forStream')}
            title={s.name}
            actions={canOperate && <Button variant="primary" onClick={() => setEditing({ stream: s, dest: null })}><Plus size={16} /> {t('destinations.add')}</Button>}
          >
            {s.destinations.length === 0 ? (
              <p className="text-sm text-fg-3">{t('dashboard.destinationsEmpty')}</p>
            ) : (
              <ul className="divide-y divide-line">
                {s.destinations.map((d) => <DestinationRow key={d.id} d={d} canOperate={canOperate} onEdit={() => setEditing({ stream: s, dest: d })} />)}
              </ul>
            )}
          </Card>
        ))}
      </div>
      <DestinationModal editing={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function DestinationRow({ d, canOperate, onEdit }: { d: Destination; canOperate: boolean; onEdit: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const act = useMutation({
    mutationFn: async (a: 'include' | 'delete') => {
      if (a === 'delete') {
        if (!confirm(t('destinations.confirmDelete', { name: d.name }))) return;
        return api(`/api/destinations/${d.id}`, { method: 'DELETE' });
      }
      return api(`/api/destinations/${d.id}`, { method: 'PUT', body: toBody(d, { enabled: !d.enabled }) });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['streams'] }),
  });
  return (
    <li className="flex flex-wrap items-center gap-x-5 gap-y-3 py-4 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
        <PlatformChip platform={d.platform} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{d.name}</span>
          {d.auth === 'account' ? (
            <span className="flex items-center gap-1.5 truncate text-xs text-fg-3">
              <Link2 size={12} className="text-accent" />
              {d.account ? t('destinations.viaAccountName', { name: d.account.name }) : <span className="text-warn">{t('destinations.accountMissing')}</span>}
              {d.platform === 'youtube' && ` · ${t(`privacy.${d.privacy}`)}`}
            </span>
          ) : (
            <span className="truncate font-mono text-xs text-fg-3">{d.serverUrl}{d.streamKeyMasked && ` · ${d.streamKeyMasked}`}</span>
          )}
        </div>
      </div>
      <span className="text-xs text-fg-2">
        {d.mode === 'copy' ? t('destinations.passthrough') : t('destinations.transcodeLong', { rate: formatKbps(d.videoBitrate), height: d.maxHeight, fps: d.fps ?? 50, audio: d.audioBitrate })}
        {d.mode === 'transcode' && d.orientation === 'portrait' && ` · ${t('destinations.portraitShort')}`}
      </span>
      <OutputBadge status={d.status} />
      <Toggle checked={d.enabled} onChange={() => act.mutate('include')} disabled={!canOperate} label={<span className="text-xs text-fg-2">{t('destinations.included')}</span>} />
      {canOperate && (
        <div className="flex gap-1">
          <Button variant="ghost" className="min-h-9 px-2.5" onClick={onEdit} aria-label={t('destinations.edit')}><Pencil size={15} /></Button>
          <Button variant="ghost" className="min-h-9 px-2.5 text-danger hover:text-danger" onClick={() => act.mutate('delete')} aria-label={t('common.delete')}><Trash2 size={15} /></Button>
        </div>
      )}
      {act.error && <div className="basis-full"><ErrorText error={act.error} /></div>}
    </li>
  );
}

interface FormState {
  name: string; platform: Platform; serverUrl: string; streamKey: string; passphrase: string; enabled: boolean;
  mode: 'copy' | 'transcode'; videoBitrate: number; audioBitrate: number; maxHeight: 480 | 720 | 1080; fps: 25 | 30 | 50 | 60 | null;
  auth: 'key' | 'account'; accountId: string | null; privacy: Privacy; orientation: Orientation;
}

function toBody(d: Destination, patch: Partial<FormState> = {}) {
  return {
    name: d.name, platform: d.platform, serverUrl: d.serverUrl, enabled: d.enabled, mode: d.mode,
    videoBitrate: d.videoBitrate, audioBitrate: d.audioBitrate, maxHeight: d.maxHeight, fps: d.fps, orientation: d.orientation,
    auth: d.auth, accountId: d.account?.id ?? null, privacy: d.privacy, ...patch,
  };
}

const accountPlatforms: Platform[] = ['youtube', 'facebook', 'twitch'];

const platformsList: Platform[] = ['youtube', 'facebook', 'twitch', 'instagram', 'kick', 'x', 'linkedin', 'rtmp', 'srt'];

/** Settings a new destination starts with, from the platform's preset. */
function fromPreset(p: Platform, preset: PlatformPreset | undefined): Partial<FormState> {
  if (!preset) return {};
  return {
    mode: preset.defaultMode, videoBitrate: preset.recommendedKbps, maxHeight: preset.maxHeight,
    fps: preset.maxFps === 30 ? 30 : null, orientation: preset.orientation, audioBitrate: p === 'instagram' ? 128 : 160,
  };
}

/** Where the operator finds the server URL and key on each platform. */
const keyHints: Partial<Record<Platform, string>> = {
  youtube: 'destinations.ytKeyHint', facebook: 'destinations.fbKeyHint', instagram: 'destinations.igKeyHint',
  kick: 'destinations.kickKeyHint', x: 'destinations.xKeyHint', linkedin: 'destinations.liKeyHint',
};

function DestinationModal({ editing, onClose }: { editing: Editing; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const presets = usePresets().data;
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<AccountsResponse>('/api/accounts'), enabled: !!editing });
  const [f, setF] = useState<FormState | null>(null);
  const [lastFor, setLastFor] = useState<string | null>(null);
  const key = editing ? editing.dest?.id ?? `new-${editing.stream.id}` : null;
  if (key !== lastFor) {
    setLastFor(key);
    const d = editing?.dest;
    setF(d
      ? { ...toBody(d), streamKey: '', passphrase: '' } as FormState
      : { name: 'YouTube', platform: 'youtube', serverUrl: '', streamKey: '', passphrase: '', enabled: true, mode: 'copy', videoBitrate: presets?.youtube.recommendedKbps ?? 9000, audioBitrate: 160, maxHeight: 1080, fps: null, auth: 'key', accountId: null, privacy: 'public', orientation: 'landscape' });
  }
  const set = (patch: Partial<FormState>) => setF((cur) => (cur ? { ...cur, ...patch } : cur));

  const save = useMutation({
    mutationFn: () => {
      const s = f!;
      const body = {
        name: s.name, platform: s.platform, serverUrl: s.serverUrl.trim() || undefined, enabled: s.enabled, mode: s.mode,
        videoBitrate: s.videoBitrate, audioBitrate: s.audioBitrate, maxHeight: s.maxHeight, fps: s.fps, orientation: s.orientation,
        auth: s.auth, accountId: s.auth === 'account' ? s.accountId : null, privacy: s.privacy,
        // Empty fields keep the stored secret when editing.
        ...(s.streamKey || (!editing?.dest && s.auth === 'key') ? { streamKey: s.streamKey.trim() } : {}),
        ...(s.passphrase ? { passphrase: s.passphrase } : {}),
      };
      return editing!.dest
        ? api(`/api/destinations/${editing!.dest.id}`, { method: 'PUT', body })
        : api(`/api/streams/${editing!.stream.id}/destinations`, { method: 'POST', body });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['streams'] }); onClose(); },
  });

  if (!f) return null;
  const preset = presets?.[f.platform];
  const isNew = !editing?.dest;
  const pickPlatform = (p: Platform) => {
    const wasDefaultName = !f.name || platformsList.some((x) => platformMeta[x].label === f.name);
    set({ platform: p, serverUrl: '', name: wasDefaultName ? platformMeta[p].label : f.name, ...fromPreset(p, presets?.[p]), auth: 'key', accountId: null });
  };
  const options = (accounts.data?.accounts ?? []).filter((a) => a.provider === f.platform);
  const viaAccount = f.auth === 'account';
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };

  return (
    <Modal open={!!editing} onClose={onClose} wide title={isNew ? t('destinations.addTitle', { stream: editing?.stream.name }) : t('destinations.editTitle')}>
      <form onSubmit={submit} className="flex flex-col gap-5">
        {isNew && (
          <div role="radiogroup" aria-label={t('destinations.platform')} className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {platformsList.map((p) => (
              <button
                key={p} type="button" role="radio" aria-checked={f.platform === p} onClick={() => pickPlatform(p)}
                className={clsx('flex flex-col items-center gap-2 rounded-xl border p-3 text-xs transition-colors',
                  f.platform === p ? 'border-accent bg-accent/[0.07] text-fg' : 'border-line text-fg-2 hover:border-line-strong')}
              >
                <PlatformChip platform={p} size={32} />
                {p === 'rtmp' ? t('destinations.customRtmp') : p === 'srt' ? t('destinations.customSrt') : platformMeta[p].label}
              </button>
            ))}
          </div>
        )}

        {preset && (preset.keyPerBroadcast || f.platform === 'kick') && (
          <p className="rounded-xl border border-info/30 bg-info/[0.06] px-4 py-3 text-xs leading-relaxed text-fg-2">{t(`destinations.about_${f.platform}`)}</p>
        )}

        {accountPlatforms.includes(f.platform) && (
          <div className="flex flex-col gap-3 rounded-xl border border-line bg-bg/40 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-sm font-medium">{t('destinations.connectWith')}</span>
              <Segmented
                label={t('destinations.connectWith')} value={f.auth}
                onChange={(v) => set({ auth: v, accountId: v === 'account' ? f.accountId ?? options[0]?.id ?? null : f.accountId })}
                options={[{ value: 'key', label: t('destinations.withKey') }, { value: 'account', label: t('destinations.withAccount') }]}
              />
            </div>
            <p className="text-xs leading-relaxed text-fg-3">{viaAccount ? t('destinations.withAccountHint') : t('destinations.withKeyHint')}</p>
            {viaAccount && (options.length ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('destinations.account')}>
                  {(id) => (
                    <Select id={id} value={f.accountId ?? ''} onChange={(e) => set({ accountId: e.target.value })} required>
                      {!f.accountId && <option value="">—</option>}
                      {options.map((a) => <option key={a.id} value={a.id}>{a.name}{a.status === 'error' ? ' ⚠' : ''}</option>)}
                    </Select>
                  )}
                </Field>
                {f.platform === 'youtube' && (
                  <Field label={t('events.privacy')}>
                    {(id) => (
                      <Select id={id} value={f.privacy} onChange={(e) => set({ privacy: e.target.value as Privacy })}>
                        {(['public', 'unlisted', 'private'] as const).map((p) => <option key={p} value={p}>{t(`privacy.${p}`)}</option>)}
                      </Select>
                    )}
                  </Field>
                )}
              </div>
            ) : (
              <Link to="/accounts" className="flex items-center gap-1.5 text-sm">{t('destinations.noAccounts', { platform: platformMeta[f.platform].label })} <ExternalLink size={13} /></Link>
            ))}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('common.name')}>
            {(id) => <Input id={id} value={f.name} onChange={(e) => set({ name: e.target.value })} required maxLength={60} />}
          </Field>
          {(!viaAccount || f.platform === 'twitch') && <Field
            label={t('destinations.server')}
            hint={preset?.server ? t('destinations.serverDefault', { url: preset.server }) : f.platform === 'srt' ? t('destinations.srtServerHint') : f.platform === 'rtmp' ? t('destinations.rtmpServerHint') : t('destinations.serverFromPlatform', { platform: platformMeta[f.platform].label })}
          >
            {(id) => (
              <Input
                id={id} value={f.serverUrl} onChange={(e) => set({ serverUrl: e.target.value })}
                required={!preset?.server} placeholder={preset?.server || preset?.serverExample || (f.platform === 'srt' ? 'srt://host:port' : 'rtmp://host/app')}
                className="font-mono text-[13px]"
              />
            )}
          </Field>}
          {!viaAccount && <Field
            label={f.platform === 'srt' ? t('destinations.streamId') : t('destinations.streamKey')}
            hint={!isNew && editing?.dest?.streamKeyMasked ? t('destinations.keyKeep', { masked: editing.dest.streamKeyMasked }) : keyHints[f.platform] ? t(keyHints[f.platform]!) : undefined}
          >
            {(id) => (
              <Input id={id} type="password" autoComplete="off" value={f.streamKey} onChange={(e) => set({ streamKey: e.target.value })}
                required={(isNew || editing?.dest?.auth === 'account') && !!preset?.keyRequired && !editing?.dest?.streamKeyMasked} className="font-mono text-[13px]" />
            )}
          </Field>}
          {f.platform === 'srt' && (
            <Field label={t('destinations.passphrase')} hint={editing?.dest?.passphraseSet ? t('destinations.passphraseKeep') : t('destinations.passphraseHint')}>
              {(id) => <Input id={id} type="password" autoComplete="off" value={f.passphrase} onChange={(e) => set({ passphrase: e.target.value })} minLength={10} maxLength={79} />}
            </Field>
          )}
        </div>

        <Toggle checked={f.enabled} onChange={(v) => set({ enabled: v })} label={t('destinations.includedLong')} />

        <div className="flex flex-col gap-3 rounded-xl border border-line bg-bg/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm font-medium">{t('destinations.encoding')}</span>
            <Segmented
              label={t('destinations.encoding')} value={f.mode} onChange={(v) => set({ mode: v })}
              options={[{ value: 'copy', label: t('destinations.passthrough') }, { value: 'transcode', label: t('destinations.transcode') }]}
            />
          </div>
          <p className="text-xs leading-relaxed text-fg-3">{f.mode === 'copy' ? t('destinations.passthroughHint') : t('destinations.transcodeHint')}</p>
          {f.mode === 'transcode' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('destinations.videoBitrate')} hint={preset ? t('destinations.recommendedMax', { rate: formatKbps(preset.recommendedKbps), max: formatKbps(preset.maxKbps) }) : undefined}>
                {(id) => <Input id={id} type="number" min={300} max={Math.min(20000, preset?.maxKbps ?? 20000)} step={100} value={f.videoBitrate} onChange={(e) => set({ videoBitrate: Number(e.target.value) })} />}
              </Field>
              <Field label={t('destinations.audioBitrate')}>
                {(id) => (
                  <Select id={id} value={f.audioBitrate} onChange={(e) => set({ audioBitrate: Number(e.target.value) })}>
                    {[96, 128, 160, 192, 256, 320].map((v) => <option key={v} value={v}>{v} kbps</option>)}
                  </Select>
                )}
              </Field>
              <Field label={t('destinations.resolution')}>
                {(id) => (
                  <Select id={id} value={f.maxHeight} onChange={(e) => set({ maxHeight: Number(e.target.value) as FormState['maxHeight'] })}>
                    {[1080, 720, 480].filter((v) => v <= (preset?.maxHeight ?? 1080)).map((v) => <option key={v} value={v}>{v}p</option>)}
                  </Select>
                )}
              </Field>
              <Field label={t('destinations.fps')}>
                {(id) => (
                  <Select id={id} value={f.fps ?? ''} onChange={(e) => set({ fps: e.target.value ? Number(e.target.value) as FormState['fps'] : null })}>
                    {(preset?.maxFps ?? 60) > 30 && <option value="">{t('destinations.fpsDefault')}</option>}
                    {[25, 30, 50, 60].filter((v) => v <= (preset?.maxFps ?? 60)).map((v) => <option key={v} value={v}>{v} fps</option>)}
                  </Select>
                )}
              </Field>
              <div className="flex flex-col gap-2 sm:col-span-2">
                <span className="text-[13px] font-medium text-fg-2">{t('destinations.orientation')}</span>
                <Segmented
                  className="self-start" label={t('destinations.orientation')} value={f.orientation} onChange={(v) => set({ orientation: v })}
                  options={[{ value: 'landscape', label: t('destinations.landscape') }, { value: 'portrait', label: t('destinations.portrait') }]}
                />
                <p className="text-xs leading-relaxed text-fg-3">{f.orientation === 'portrait' ? t('destinations.portraitHint') : t('destinations.landscapeHint')}</p>
              </div>
            </div>
          )}
          {f.mode === 'copy' && preset?.defaultMode === 'transcode' && (
            <p className="text-xs leading-relaxed text-warn">{t('destinations.transcodeAdvised', { platform: platformMeta[f.platform].label, height: preset.maxHeight, fps: preset.maxFps })}</p>
          )}
        </div>

        <ErrorText error={save.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>{isNew ? t('destinations.create') : t('common.save')}</Button>
        </div>
      </form>
    </Modal>
  );
}
