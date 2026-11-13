import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Activity, CheckCircle2, Cpu, HardDrive, MemoryStick, Upload } from 'lucide-react';
import { clsx } from 'clsx';
import type { FeedHealth, OutputHealth, Stream } from '../lib/api';
import { formatBytes } from '../lib/format';
import { formatKbps, useStreams } from '../lib/streams';
import { Card, PageHeader } from '../components/ui';
import { OutputBadge, PlatformChip, Segmented, codecName } from '../components/media';
import { IssueRow, Metric, Sparkline, useHealth } from '../components/health';

const ACCENT = 'var(--rs-accent)';
const SECOND = 'var(--rs-info)';

/** Broadcast › Health: is the incoming feed clean, can every destination keep up, does the server have room? */
export function Health() {
  const { t } = useTranslation();
  const q = useHealth(true);
  const streamsQ = useStreams();
  const [params, setParams] = useSearchParams();
  const streams = streamsQ.data?.streams ?? [];
  const h = q.data;
  const selected = streams.find((s) => s.id === params.get('stream')) ?? null;
  const shown = selected ? [selected] : streams;

  if (!h) return null;
  const srv = h.server;
  const memPct = srv.memory ? Math.round((srv.memory.usedBytes / srv.memory.totalBytes) * 100) : null;
  const upPct = srv.uploadCapacityKbps && srv.uploadKbps !== null ? Math.round((srv.uploadKbps / srv.uploadCapacityKbps) * 100) : null;
  const diskGb = srv.disk ? srv.disk.freeBytes / 1024 ** 3 : null;
  const times = srv.history.map((p) => p.t);

  return (
    <>
      <PageHeader eyebrow={t('nav.broadcast')} title={t('health.title')} subtitle={t('health.subtitle')} />
      <div className="flex flex-col gap-6">
        {!h.enabled && <p className="rounded-xl border border-accent/30 bg-accent/[0.06] px-4 py-3 text-sm text-fg-2">{t('health.disabled')}</p>}

        <section aria-label={t('health.issuesTitle')}>
          {h.issues.length ? (
            <ul className="flex flex-col gap-2">{h.issues.map((i) => <IssueRow key={i.key} issue={i} />)}</ul>
          ) : (
            <div className="flex items-center gap-3 rounded-2xl border border-ok/30 bg-ok/[0.05] px-4 py-3.5">
              <CheckCircle2 size={18} className="shrink-0 text-ok" />
              <span className="text-sm">{t('health.allGood')}</span>
            </div>
          )}
        </section>

        <Card title={t('health.server')} eyebrow={t('health.lastMinutes', { minutes: 15 })}>
          <div className="grid grid-cols-2 gap-x-6 gap-y-5 lg:grid-cols-4">
            <div className="flex items-start gap-3">
              <Cpu size={18} className="mt-1 text-fg-3" />
              <Metric label={t('health.cpu')} value={srv.cpuPercent === null ? '—' : `${Math.round(srv.cpuPercent)} %`}
                tone={srv.cpuPercent === null ? 'neutral' : srv.cpuPercent >= 90 ? 'danger' : srv.cpuPercent >= 75 ? 'warn' : 'ok'}
                sub={t('health.cores', { count: srv.cores, load: srv.load1 })} />
            </div>
            <div className="flex items-start gap-3">
              <MemoryStick size={18} className="mt-1 text-fg-3" />
              <Metric label={t('health.memory')} value={memPct === null ? '—' : `${memPct} %`} tone={memPct === null ? 'neutral' : memPct >= 92 ? 'danger' : memPct >= 80 ? 'warn' : 'ok'}
                sub={srv.memory ? `${formatBytes(srv.memory.usedBytes)} / ${formatBytes(srv.memory.totalBytes)}` : undefined} />
            </div>
            <div className="flex items-start gap-3">
              <Upload size={18} className="mt-1 text-fg-3" />
              <Metric label={t('health.upload')} value={formatKbps(srv.uploadKbps)} tone={upPct === null ? 'neutral' : upPct >= 85 ? 'warn' : 'ok'}
                sub={srv.uploadCapacityKbps ? t('health.ofCapacity', { percent: upPct ?? 0, capacity: formatKbps(srv.uploadCapacityKbps) }) : t('health.capacityUnknown')} />
            </div>
            <div className="flex items-start gap-3">
              <HardDrive size={18} className="mt-1 text-fg-3" />
              <Metric label={t('health.disk')} value={diskGb === null ? '—' : t('health.free', { size: formatBytes(srv.disk!.freeBytes) })}
                tone={diskGb === null ? 'neutral' : diskGb < 1 ? 'danger' : diskGb < 5 ? 'warn' : 'ok'}
                sub={srv.disk ? t('health.ofTotal', { size: formatBytes(srv.disk.totalBytes) }) : undefined} />
            </div>
          </div>
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <ChartBox title={t('health.cpu')} legend={[[ACCENT, t('health.cpu')]]}>
              <Sparkline times={times} series={[{ values: srv.history.map((p) => p.cpu), color: ACCENT, label: 'cpu' }]} max={[100]} label={t('health.cpu')} />
            </ChartBox>
            <ChartBox title={t('health.network')} legend={[[ACCENT, t('health.upload')], [SECOND, t('health.download')]]}>
              <Sparkline times={times} series={[
                { values: srv.history.map((p) => p.upload), color: ACCENT, label: 'up' },
                { values: srv.history.map((p) => p.download), color: SECOND, label: 'down' },
              ]} max={[srv.uploadCapacityKbps ?? undefined]} label={t('health.network')} />
            </ChartBox>
          </div>
        </Card>

        {streams.length > 1 && (
          <Segmented
            label={t('dashboard.selectStream')} className="self-start"
            value={selected?.id ?? 'all'}
            options={[{ value: 'all', label: t('health.allStreams') }, ...streams.map((s) => ({ value: s.id, label: s.name }))]}
            onChange={(v) => setParams(v === 'all' ? {} : { stream: v })}
          />
        )}

        {shown.map((s) => <StreamHealth key={s.id} stream={s} feeds={h.feeds.filter((f) => f.streamId === s.id)} outputs={h.outputs.filter((o) => o.streamId === s.id)} />)}
      </div>
    </>
  );
}

function ChartBox({ title, legend, children }: { title: string; legend: [string, string][]; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-bg/40 p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="eyebrow">{title}</span>
        <span className="ml-auto flex items-center gap-3">
          {legend.map(([c, l], i) => (
            <span key={l} className="flex items-center gap-1.5 text-xs text-fg-3">
              <span className="inline-block h-0.5 w-4" style={{ background: c, opacity: i ? 0.8 : 1 }} />{l}
            </span>
          ))}
        </span>
      </div>
      {children}
    </div>
  );
}

function StreamHealth({ stream, feeds, outputs }: { stream: Stream; feeds: FeedHealth[]; outputs: OutputHealth[] }) {
  const { t } = useTranslation();
  const ordered = (['main', 'backup'] as const).map((i) => feeds.find((f) => f.input === i)).filter((f): f is FeedHealth => !!f);
  return (
    <Card title={stream.name} eyebrow={<span className="flex items-center gap-2"><Activity size={13} /> {t('health.stream')}</span>}>
      <div className="flex flex-col gap-5">
        {ordered.length === 0 ? (
          <p className="text-sm text-fg-3">{t('health.feedOffline')}</p>
        ) : (
          <div className={clsx('grid gap-4', ordered.length > 1 && 'xl:grid-cols-2')}>
            {ordered.map((f) => <FeedPanel key={f.input} f={f} />)}
          </div>
        )}
        {outputs.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="eyebrow">{t('health.destinations')}</span>
            <div className="flex flex-col divide-y divide-line rounded-xl border border-line">
              {outputs.map((o) => <OutputRow key={o.destinationId} o={o} />)}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function FeedPanel({ f }: { f: FeedHealth }) {
  const { t } = useTranslation();
  const kf = f.keyframeSeconds;
  const fpsLow = f.nominalFps !== null && f.fps !== null && f.fps < f.nominalFps * 0.9;
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-line bg-bg/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t(`health.input_${f.input}`)}</span>
        <span className="font-mono text-xs text-fg-3">
          {[f.protocol, f.video ? codecName(f.video.codec) : null, f.video?.height ? `${f.video.width}x${f.video.height}` : null].filter(Boolean).join(' · ')}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Metric label={t('health.bitrate')} value={formatKbps(f.bitrateKbps)} />
        <Metric label={t('health.fps')} value={f.fps === null ? '—' : String(f.fps)} tone={f.fps === null ? 'neutral' : fpsLow ? 'warn' : 'ok'}
          sub={f.nominalFps ? t('health.expected', { fps: f.nominalFps }) : undefined} />
        <Metric label={t('health.keyframes')} value={kf === null ? '—' : `${kf} s`} tone={kf === null ? 'neutral' : kf > 4.2 ? 'warn' : kf > 2.5 ? 'neutral' : 'ok'}
          sub={t('health.keyframesHint')} />
        <Metric label={t('health.errors')} value={String(f.errors)} tone={f.errors >= 5 ? 'warn' : 'ok'} sub={t('health.lastMinute')} />
      </div>
      {f.srt && (
        <div className="grid grid-cols-2 gap-4 border-t border-line pt-3 sm:grid-cols-4">
          <Metric label={t('health.srtRtt')} value={f.srt.rttMs === null ? '—' : `${Math.round(f.srt.rttMs)} ms`} />
          <Metric label={t('health.srtRetrans')} value={f.srt.retransPercent === null ? '—' : `${f.srt.retransPercent} %`} tone={(f.srt.retransPercent ?? 0) > 10 ? 'warn' : 'neutral'} />
          <Metric label={t('health.srtLink')} value={f.srt.linkMbps === null ? '—' : `${Math.round(f.srt.linkMbps)} Mbit/s`} />
          <Metric label={t('health.srtDrops')} value={String(f.srt.drops)} />
        </div>
      )}
      <ChartBoxLite legend={[[ACCENT, t('health.bitrate')], [SECOND, t('health.fps')]]}>
        <Sparkline
          times={f.history.map((p) => p.t)}
          series={[{ values: f.history.map((p) => p.kbps), color: ACCENT, label: 'kbps' }, { values: f.history.map((p) => p.fps), color: SECOND, label: 'fps' }]}
          max={[undefined, (f.nominalFps ?? 30) * 1.1]}
          label={t('health.feedChart')}
        />
      </ChartBoxLite>
    </div>
  );
}

function ChartBoxLite({ legend, children }: { legend: [string, string][]; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-3">
        {legend.map(([c, l], i) => (
          <span key={l} className="flex items-center gap-1.5 text-xs text-fg-3">
            <span className="inline-block h-0.5 w-4" style={{ background: c, opacity: i ? 0.8 : 1 }} />{l}
          </span>
        ))}
      </span>
      {children}
    </div>
  );
}

function OutputRow({ o }: { o: OutputHealth }) {
  const { t } = useTranslation();
  const slow = o.speed !== null && o.speed < 0.95;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3">
      <div className="flex min-w-0 basis-56 items-center gap-3">
        <PlatformChip platform={o.platform} size={30} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{o.name}</span>
          <span className="text-xs text-fg-3">{o.mode === 'copy' ? t('destinations.passthrough') : t('health.transcode')}</span>
        </div>
      </div>
      <OutputBadge status={{ state: o.state, since: null, bitrateKbps: o.bitrateKbps, fps: null, speed: o.speed, attempts: 0, lastError: null, errorCode: null, nextRetryAt: null }} />
      <div className="grid flex-1 basis-72 grid-cols-3 gap-4">
        <Metric label={t('health.bitrate')} value={formatKbps(o.bitrateKbps)} sub={o.targetKbps ? t('health.target', { rate: formatKbps(o.targetKbps) }) : undefined} />
        <Metric label={t('health.speed')} value={o.speed === null ? '—' : `${o.speed.toFixed(2)}x`} tone={o.speed === null ? 'neutral' : slow ? 'warn' : 'ok'} />
        <Metric label={t('health.processCpu')} value={o.cpuPercent === null ? '—' : `${Math.round(o.cpuPercent)} %`} />
      </div>
      <div className="w-full basis-40 sm:w-40">
        <Sparkline times={o.history.map((p) => p.t)} series={[{ values: o.history.map((p) => p.kbps), color: ACCENT, label: 'kbps' }]} height={36} label={t('health.bitrate')} />
      </div>
    </div>
  );
}
