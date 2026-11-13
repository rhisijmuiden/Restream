import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CalendarClock, Eye, Maximize2, CircleDot, MonitorPlay, Plus, Radio, Settings2, Square, ExternalLink, Wrench, Link2 } from 'lucide-react';
import { clsx } from 'clsx';
import { api, type Destination, type Stream, type SystemInfo } from '../lib/api';
import { useMe } from '../lib/auth';
import { formatBytes, formatDate, formatDuration } from '../lib/format';
import { useEvents } from './Events';
import { clock, formatKbps, sinceSeconds, useStreams } from '../lib/streams';
import { Button, Card, CopyButton, ErrorText, KeyValue } from '../components/ui';
import { IngestBadge, OutputBadge, OutputProblem, OutputSummary, PlatformChip, Segmented, SourceBadge, audioLabel, videoLabel, outputView } from '../components/media';
import { WhepPlayer } from '../components/WhepPlayer';
import { Audience, ChatList } from '../components/live';
import { formatCount, useLive } from '../lib/live';
import type { LiveDestination } from '../lib/api';

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

export function Dashboard() {
  const { t } = useTranslation();
  const me = useMe().data!;
  const canOperate = me.user!.role !== 'viewer';
  const sys = useQuery({ queryKey: ['info'], queryFn: () => api<SystemInfo>('/api/system/info') });
  const q = useStreams();
  const [params, setParams] = useSearchParams();
  const streams = q.data?.streams ?? [];
  const stream = streams.find((s) => s.id === params.get('stream')) ?? streams[0];

  if (q.isLoading) return null;

  return (
    <div className="flex flex-col gap-6">
      {q.data?.mediaEnabled === false && (
        <Notice tone="info" title={t('dashboard.mediaDisabledTitle')} text={t('dashboard.mediaDisabledText')} />
      )}
      {q.data?.mediaEnabled && !q.data.mediamtxOnline && (
        <Notice
          tone="danger" title={t('dashboard.mediaOfflineTitle')} text={t('dashboard.mediaOfflineText')}
          action={me.user!.role === 'admin' && sys.data?.updaterEnabled ? <RepairButton channel={sys.data.channel} /> : undefined}
        />
      )}
      {!stream ? (
        <EmptyState canOperate={canOperate} />
      ) : (
        <>
          {streams.length > 1 && (
            <Segmented
              label={t('dashboard.selectStream')}
              value={stream.id}
              options={streams.map((s) => ({ value: s.id, label: `${s.status.online ? '● ' : ''}${s.name}` }))}
              onChange={(id) => setParams({ stream: id })}
              className="self-start"
            />
          )}
          <StreamControl stream={stream} canOperate={canOperate} sys={sys.data} />
        </>
      )}
    </div>
  );
}

function Notice({ tone, title, text, action }: { tone: 'info' | 'danger'; title: string; text: string; action?: ReactNode }) {
  return (
    <div className={clsx('flex flex-wrap items-start gap-4 rounded-2xl border p-5', tone === 'danger' ? 'border-danger/40 bg-danger/[0.07]' : 'border-accent/30 bg-accent/[0.06]')}>
      <AlertTriangle size={20} className={clsx('mt-0.5 shrink-0', tone === 'danger' ? 'text-danger' : 'text-accent')} />
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
        <span className="font-medium">{title}</span>
        <span className="text-sm leading-relaxed text-fg-2">{text}</span>
      </div>
      {action}
    </div>
  );
}

/** Re-runs the updater on the current channel; it (re)installs and starts MediaMTX. */
function RepairButton({ channel }: { channel: 'production' | 'test' }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const repair = useMutation({
    mutationFn: () => api('/api/system/update', { method: 'POST', body: { channel } }),
    onSuccess: () => nav('/admin/updates'),
  });
  return (
    <div className="flex flex-col items-end gap-2">
      <Button onClick={() => repair.mutate()} loading={repair.isPending}><Wrench size={15} /> {t('dashboard.repairMedia')}</Button>
      <ErrorText error={repair.error} />
    </div>
  );
}

function EmptyState({ canOperate }: { canOperate: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-line bg-surface/60 px-6 py-16 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl border border-accent/30 bg-accent/10 text-accent"><Radio size={26} /></div>
      <h1 className="font-display text-2xl font-semibold">{t('dashboard.emptyTitle')}</h1>
      <p className="max-w-md text-sm leading-relaxed text-fg-2">{t('dashboard.emptyText')}</p>
      {canOperate && <Link to="/streams?new=1"><Button variant="primary"><Plus size={16} /> {t('streams.add')}</Button></Link>}
    </div>
  );
}

function StreamControl({ stream, canOperate, sys }: { stream: Stream; canOperate: boolean; sys?: SystemInfo }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const now = useNow();
  // While the backup feed is on air, the preview and the figures show the backup feed.
  const onBackup = stream.source.active === 'backup';
  const st = onBackup ? stream.source.backup : stream.status;
  const anyLive = stream.destinations.some((d) => d.live);
  const onAir = stream.destinations.some((d) => d.status.state === 'live');
  const included = stream.destinations.filter((d) => d.enabled);
  const liveData = useLive(stream.id);
  const audience = new Map((liveData.data?.destinations ?? []).map((d) => [d.destinationId, d]));

  const live = useMutation({
    mutationFn: (on: boolean) => api(`/api/streams/${stream.id}/live`, { method: 'POST', body: { live: on } }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['streams'] }),
  });

  const stopAll = () => { if (confirm(t('dashboard.confirmStopAll'))) live.mutate(false); };

  return (
    <>
      <header className="flex flex-wrap items-center gap-4">
        <div className="flex min-w-0 basis-full flex-col gap-1 sm:basis-0 sm:flex-1">
          <span className="eyebrow truncate">{t('dashboard.eyebrow', { name: stream.name })}</span>
          <h1 className="font-display text-3xl font-semibold tracking-tight">{t('dashboard.title')}</h1>
        </div>
        <IngestBadge status={stream.status} enabled={stream.enabled} />
        <SourceBadge source={stream.source} anyLive={anyLive} now={now} />
        <RecordButton stream={stream} canOperate={canOperate} now={now} />
        {canOperate && (anyLive ? (
          <Button variant="danger" onClick={stopAll} loading={live.isPending}><Square size={14} /> {t('dashboard.stopAll')}</Button>
        ) : (
          <Button
            variant="primary" onClick={() => live.mutate(true)} loading={live.isPending}
            disabled={included.length === 0}
            title={included.length === 0 ? t('dashboard.noIncluded') : !st.online ? t('dashboard.goLiveWaiting') : undefined}
          >
            <Radio size={16} /> {t('dashboard.goLive')}
          </Button>
        ))}
      </header>
      <ErrorText error={live.error} />

      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <div className="flex min-w-0 flex-col gap-6">
          <section aria-label={t('dashboard.preview')} className={clsx('overflow-hidden rounded-2xl border bg-surface', onAir ? 'border-live/50' : 'border-line')}>
            <div className="rs-dark relative flex aspect-video items-center justify-center bg-[radial-gradient(ellipse_at_center,#101830_0%,#070A12_70%)]">
              {!st.online && (
                <div className="flex flex-col items-center gap-3 px-6 text-center text-fg-3">
                  <MonitorPlay size={40} strokeWidth={1.4} />
                  <span className="text-sm">{t('dashboard.previewEmpty')}</span>
                </div>
              )}
              <WhepPlayer url={`/api/preview/${stream.id}${onBackup ? '~backup' : ''}/whep`} active={st.online} sessionKey={`${onBackup ? 'b' : 'm'}${st.since ?? ''}`} audioCodec={st.audio?.codec ?? null} />
              <div className="pointer-events-none absolute top-4 left-4 flex items-center gap-2">
                {onAir && <span className="rounded-md bg-live px-2 py-0.5 font-mono text-[11px] font-semibold tracking-wider text-white">{t('dashboard.onAir')}</span>}
                <span className="rounded-md bg-bg/60 px-2 py-0.5 font-mono text-xs text-fg-2 backdrop-blur">{clock(sinceSeconds(st.since, now))}</span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
              {[
                [t('dashboard.protocol'), st.protocol ?? '—'],
                [t('dashboard.video'), videoLabel(st)],
                [t('dashboard.audio'), audioLabel(st, t('dashboard.stereo'), t('dashboard.mono'))],
                [t('dashboard.bitrate'), formatKbps(st.bitrateKbps)],
              ].map(([k, v]) => (
                <div key={k} className="flex min-w-0 flex-col gap-1 bg-surface px-4 py-3">
                  <span className="eyebrow">{k}</span><span className="truncate font-mono text-sm text-fg-2">{v}</span>
                </div>
              ))}
            </div>
          </section>
          {st.overLimit && <Notice tone="danger" title={t('dashboard.overLimitTitle')} text={t('dashboard.overLimitText')} />}
          {anyLive && stream.source.active === 'backup' && <Notice tone="info" title={t('failover.onBackupTitle')} text={t('failover.onBackupText', { seconds: stream.fallback.switchBackSeconds })} />}
          {anyLive && stream.source.active === 'fallback' && <Notice tone="danger" title={t('failover.onFallbackTitle')} text={t('failover.onFallbackText')} />}
          {anyLive && stream.source.fallbackExpired && stream.source.active === 'none' && <Notice tone="danger" title={t('failover.expiredTitle')} text={t('failover.expiredText', { minutes: stream.fallback.minutes })} />}

          <Card
            title={t('dashboard.destinations')}
            actions={<Link to="/destinations" className="flex items-center gap-1.5 text-sm"><Settings2 size={15} /> {t('dashboard.manage')}</Link>}
          >
            {stream.destinations.length === 0 ? (
              <div className="flex flex-col items-start gap-3 text-sm text-fg-2">
                <span>{t('dashboard.destinationsEmpty')}</span>
                {canOperate && <Link to="/destinations?new=1"><Button><Plus size={16} /> {t('destinations.add')}</Button></Link>}
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <OutputSummary destinations={stream.destinations} />
                <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                  {stream.destinations.map((d) => <DestinationTile key={d.id} d={d} canOperate={canOperate} now={now} live={audience.get(d.id)} />)}
                </div>
              </div>
            )}
          </Card>
        </div>

        <aside className="flex flex-col gap-6">
          <Audience data={liveData.data} compact />
          <Card
            eyebrow={t('live.chat')}
            actions={<Link to={`/chat?stream=${stream.id}`} className="flex items-center gap-1.5 text-sm"><Maximize2 size={14} /> {t('live.openChat')}</Link>}
            className="flex h-[480px] flex-col"
          >
            <ChatList messages={liveData.chat} destinations={liveData.data?.destinations} className="flex-1" empty={liveData.data?.broadcast ? undefined : t('live.chatOffAir')} />
          </Card>
          <NextEvent streamId={stream.id} />
          <Card eyebrow={t('dashboard.outputs')}>
            <div className="flex items-end gap-3">
              <span className="font-display text-5xl font-semibold">{stream.destinations.filter((d) => d.status.state === 'live').length}</span>
              <span className="pb-1.5 text-sm text-fg-3">/ {stream.destinations.filter((d) => d.live).length || included.length} {t('dashboard.outputsLive')}</span>
            </div>
            <p className="mt-3 text-xs text-fg-3">{t('dashboard.outgoing', { rate: formatKbps(stream.destinations.reduce((n, d) => n + (d.status.bitrateKbps ?? 0), 0) || null) })}</p>
          </Card>
          <Card title={t('dashboard.playback')}>
            {stream.playbackEnabled ? (
              <div className="flex flex-col gap-3">
                <UrlRow label="HLS" value={stream.playback.hls} />
                <UrlRow label="WebRTC (WHEP)" value={stream.playback.whep} />
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  <a href={stream.playback.webrtcPage} target="_blank" rel="noreferrer" className="flex items-center gap-1">{t('dashboard.openWebrtc')} <ExternalLink size={13} /></a>
                  <a href={stream.playback.hlsPage} target="_blank" rel="noreferrer" className="flex items-center gap-1">{t('dashboard.openHls')} <ExternalLink size={13} /></a>
                </div>
              </div>
            ) : (
              <span className="text-sm text-fg-3">{t('dashboard.playbackOff')}</span>
            )}
          </Card>
          <Card title={t('dashboard.system')}>
            {sys && (
              <KeyValue items={[
                [t('dashboard.version'), `v${sys.version}`],
                [t('dashboard.channel'), t(`channel.${sys.channel}`)],
                [t('dashboard.uptime'), formatDuration(sys.uptimeSeconds)],
                [t('dashboard.localReaders'), String(stream.status.readers)],
              ]} />
            )}
          </Card>
        </aside>
      </div>
    </>
  );
}

function RecordButton({ stream, canOperate, now }: { stream: Stream; canOperate: boolean; now: number }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const rec = stream.recording;
  const toggle = useMutation({
    mutationFn: (on: boolean) => api(`/api/streams/${stream.id}/record`, { method: 'POST', body: { record: on } }),
    onSettled: () => { qc.invalidateQueries({ queryKey: ['streams'] }); qc.invalidateQueries({ queryKey: ['recordings'] }); },
  });
  if (!stream.record) {
    return (
      <Button onClick={() => toggle.mutate(true)} loading={toggle.isPending} disabled={!canOperate} title={rec.lastError ?? t('dashboard.recordHint')}>
        <CircleDot size={16} className="text-live" /> {t('dashboard.record')}
      </Button>
    );
  }
  const recording = rec.state === 'recording';
  return (
    <Button
      variant="danger" onClick={() => { if (confirm(t('dashboard.confirmStopRecording'))) toggle.mutate(false); }} loading={toggle.isPending} disabled={!canOperate}
      title={recording ? t('dashboard.stopRecording') : rec.lastError === 'disk_full' ? t('errors.disk_full') : t('dashboard.recordWaiting')}
      className="font-mono"
    >
      <CircleDot size={16} className={clsx(recording && 'pulse-dot')} />
      {recording ? `REC ${clock(sinceSeconds(rec.since, now))} · ${formatBytes(rec.sizeBytes)}` : t('dashboard.recordArmed')}
    </Button>
  );
}

function NextEvent({ streamId }: { streamId: string }) {
  const { t } = useTranslation();
  const events = useEvents().data ?? [];
  const e = events.find((x) => x.streamId === streamId && x.status === 'live') ?? events.find((x) => x.streamId === streamId && x.status === 'scheduled');
  if (!e) return null;
  return (
    <Card eyebrow={<span className="flex items-center gap-2"><CalendarClock size={13} /> {e.status === 'live' ? t('dashboard.eventNow') : t('dashboard.eventNext')}</span>}>
      <Link to="/events" className="flex flex-col gap-1 text-fg hover:text-fg">
        <span className="font-display text-lg font-semibold">{e.title}</span>
        <span className="text-sm text-fg-2">{formatDate(e.startsAt)}</span>
        {e.status === 'scheduled' && <span className="text-xs text-fg-3">{e.autoStart ? t('dashboard.eventAuto') : t('events.manualStart')}</span>}
      </Link>
    </Card>
  );
}

function UrlRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="eyebrow">{label}</span>
      <div className="flex items-center gap-1 rounded-xl border border-line bg-bg pl-3">
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg-2">{value}</code>
        <CopyButton value={value} className="min-h-9 px-3" />
      </div>
    </div>
  );
}

function DestinationTile({ d, canOperate, now, live }: { d: Destination; canOperate: boolean; now: number; live?: LiveDestination }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (on: boolean) => api(`/api/destinations/${d.id}/live`, { method: 'POST', body: { live: on } }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['streams'] }),
  });
  const s = d.status;
  return (
    <div className={clsx('flex flex-col gap-3 rounded-xl border p-4 transition-colors',
      s.state === 'live' ? 'border-live/40 bg-live/[0.04]' : d.live && outputView(s) === 'error' ? 'border-danger/40' : 'border-line bg-bg/40')}>
      <div className="flex items-center gap-3">
        <PlatformChip platform={d.platform} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{d.name}</span>
          <span className="truncate text-xs text-fg-3">
            {d.auth === 'account' && <Link2 size={11} className="mr-1 inline text-accent" />}
            {d.mode === 'copy' ? t('destinations.passthrough') : t('destinations.transcodeShort', { rate: formatKbps(d.videoBitrate), height: d.maxHeight })}
            {!d.enabled && ` · ${t('destinations.notIncluded')}`}
          </span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <OutputBadge status={s} />
        <span className="font-mono text-xs text-fg-2">
          {s.state === 'live' ? `${formatKbps(s.bitrateKbps)} · ${clock(sinceSeconds(s.since, now))}` : ''}
        </span>
      </div>
      {live?.onAir && live.supported && (
        <span className="flex items-center gap-1.5 text-xs text-fg-2" title={live.error ?? undefined}>
          <Eye size={13} className={live.error ? 'text-warn' : 'text-accent'} />
          <span className="font-mono tabular-nums">{formatCount(live.viewers, i18n.language)}</span> {t('live.viewers')}
        </span>
      )}
      {d.watchUrl && (
        <a href={d.watchUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-xs">{t('dashboard.watch')} <ExternalLink size={12} /></a>
      )}
      <OutputProblem status={s} now={now} />
      {canOperate && (
        d.live
          ? <Button variant="ghost" className="min-h-9 border border-line" onClick={() => toggle.mutate(false)} loading={toggle.isPending}><Square size={13} /> {t('dashboard.stop')}</Button>
          : <Button className="min-h-9" onClick={() => toggle.mutate(true)} loading={toggle.isPending}><Radio size={14} /> {t('dashboard.goLive')}</Button>
      )}
    </div>
  );
}

