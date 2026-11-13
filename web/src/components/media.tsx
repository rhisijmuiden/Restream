import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import type { Destination, IngestStatus, OutputStatus, Platform, SourceState } from '../lib/api';
import { platformMeta } from '../lib/streams';
import { Badge } from './ui';

export function PlatformChip({ platform, size = 36 }: { platform: Platform; size?: number }) {
  const m = platformMeta[platform];
  return (
    <div
      className={clsx('flex shrink-0 items-center justify-center font-mono font-semibold text-ink', size < 30 ? 'rounded-md' : 'rounded-lg')}
      style={{ background: m.color, width: size, height: size, fontSize: size < 30 && m.short.length > 2 ? 7.5 : 10, letterSpacing: size < 30 && m.short.length > 2 ? '-0.03em' : undefined }}
      aria-hidden
    >
      {m.short}
    </div>
  );
}

/** What the console shows for an output: a few clear states instead of the supervisor's internal ones. */
export type OutputView = 'off' | 'waiting' | 'preparing' | 'connecting' | 'live' | 'retrying' | 'error';

/** Errors that do not go away by retrying (wrong address or key): shown as an error at once. */
const settingErrors = new Set(['dns', 'refused', 'rejected', 'tls']);

export function outputView(status: OutputStatus): OutputView {
  switch (status.state) {
    case 'live': return 'live';
    case 'off': return 'off';
    case 'waiting': return 'waiting';
    case 'preparing': return status.lastError ? 'error' : 'preparing';
    case 'connecting': return 'connecting';
    case 'reconnecting':
      return status.attempts >= 3 || (status.errorCode !== null && settingErrors.has(status.errorCode)) ? 'error' : 'retrying';
  }
}

const viewTone = { off: 'neutral', waiting: 'warn', preparing: 'accent', connecting: 'accent', live: 'live', retrying: 'warn', error: 'danger' } as const;

export function OutputBadge({ status }: { status: OutputStatus }) {
  const { t } = useTranslation();
  const view = outputView(status);
  return (
    <Badge tone={viewTone[view]} dot>
      {view === 'retrying' && status.attempts > 0 ? t('output.reconnectingN', { n: status.attempts })
        : view === 'error' && status.state === 'preparing' ? t('output.preparingFailed')
          : t(`output.view.${view}`)}
    </Badge>
  );
}

/**
 * Explains why an output is not on air and when it tries again, with FFmpeg's own message folded away.
 * Renders nothing while the output is on air, off or starting normally.
 */
export function OutputProblem({ status, now }: { status: OutputStatus; now: number }) {
  const { t, i18n } = useTranslation();
  const view = outputView(status);
  if (view !== 'error' && view !== 'retrying') return null;
  // A platform refusal on a connected account may come as a known error key (e.g. x_not_eligible).
  const known = status.lastError && i18n.exists(`errors.${status.lastError}`) ? t(`errors.${status.lastError}`) : null;
  const reason = known ?? (status.state === 'preparing' ? t('output.why.preparing') : t(`output.why.${status.errorCode ?? 'unknown'}`));
  const retryIn = status.nextRetryAt ? Math.max(0, Math.ceil((new Date(status.nextRetryAt).getTime() - now) / 1000)) : null;
  return (
    <div className={clsx('flex flex-col gap-1 rounded-lg border px-3 py-2 text-xs leading-relaxed', view === 'error' ? 'border-danger/30 bg-danger/[0.06] text-fg-2' : 'border-warn/30 bg-warn/[0.05] text-fg-2')} role="status">
      <span>{reason}</span>
      <span className="text-fg-3">{retryIn !== null && retryIn > 0 ? t('output.retryIn', { seconds: retryIn }) : t('output.retryNow')}</span>
      {status.lastError && !known && (
        <details className="text-fg-3">
          <summary className="cursor-pointer select-none">{t('output.details')}</summary>
          <code className="mt-1 block break-words font-mono text-[11px]">{status.lastError}</code>
        </details>
      )}
    </div>
  );
}

/** One line with how many included destinations are live, starting or failing; shown while a stream is live. */
export function OutputSummary({ destinations }: { destinations: Destination[] }) {
  const { t } = useTranslation();
  const live = destinations.filter((d) => d.live);
  if (live.length === 0) return null;
  const count = (v: OutputView[]) => live.filter((d) => v.includes(outputView(d.status))).length;
  const parts = [
    { n: count(['live']), label: t('output.summary.live'), tone: 'text-ok' },
    { n: count(['connecting', 'preparing']), label: t('output.summary.connecting'), tone: 'text-accent' },
    { n: count(['retrying']), label: t('output.summary.retrying'), tone: 'text-warn' },
    { n: count(['error']), label: t('output.summary.error'), tone: 'text-danger' },
    { n: count(['waiting']), label: t('output.summary.waiting'), tone: 'text-warn' },
  ].filter((p) => p.n > 0);
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs" aria-live="polite">
      {parts.map((p) => (
        <span key={p.label} className={clsx('flex items-center gap-1.5', p.tone)}>
          <span className="size-1.5 rounded-full bg-current" />{p.n} {p.label}
        </span>
      ))}
    </p>
  );
}

export function IngestBadge({ status, enabled = true }: { status: IngestStatus; enabled?: boolean }) {
  const { t } = useTranslation();
  if (!enabled) return <Badge tone="neutral">{t('streams.disabled')}</Badge>;
  return status.online
    ? <Badge tone="ok" dot>{t('ingest.online', { protocol: status.protocol ?? '' })}</Badge>
    : <Badge tone="neutral" dot>{t('ingest.offline')}</Badge>;
}

/** Which feed the live destinations carry; only shown when a backup feed is set up or something other than the main feed is on air. */
export function SourceBadge({ source, anyLive, now }: { source: SourceState; anyLive: boolean; now: number }) {
  const { t } = useTranslation();
  if (source.active === 'backup') return <Badge tone="warn" dot>{t('failover.sourceBackup')}</Badge>;
  if (source.active === 'fallback') {
    const left = source.fallbackEndsAt ? Math.max(0, Math.ceil((new Date(source.fallbackEndsAt).getTime() - now) / 60_000)) : null;
    return <Badge tone="danger" dot>{left !== null ? t('failover.sourceFallbackLeft', { minutes: left }) : t('failover.sourceFallback')}</Badge>;
  }
  if (!source.backupConfigured) return null;
  return source.backup.online
    ? <Badge tone="ok" dot>{t('failover.backupReady')}</Badge>
    : <Badge tone={anyLive ? 'warn' : 'neutral'} dot>{t('failover.backupOffline')}</Badge>;
}

const codecNames: Record<string, string> = {
  H264: 'H.264', H265: 'HEVC', AV1: 'AV1', VP9: 'VP9', 'MPEG-4 Audio': 'AAC', Opus: 'Opus', 'MPEG-1/2 Audio': 'MP3',
};
export const codecName = (c: string | undefined | null) => (c ? codecNames[c] ?? c : '—');

export function videoLabel(s: IngestStatus) {
  if (!s.video) return '—';
  const res = s.video.width && s.video.height ? ` · ${s.video.width}×${s.video.height}` : '';
  return `${codecName(s.video.codec)}${res}`;
}

export function audioLabel(s: IngestStatus, stereo: string, mono: string) {
  if (!s.audio) return '—';
  const rate = s.audio.sampleRate ? ` · ${s.audio.sampleRate / 1000} kHz` : '';
  const ch = s.audio.channels ? ` · ${s.audio.channels === 1 ? mono : s.audio.channels === 2 ? stereo : `${s.audio.channels} ch`}` : '';
  return `${codecName(s.audio.codec)}${rate}${ch}`;
}

export function Segmented<T extends string | number>({ value, options, onChange, label, className }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string; className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={clsx('inline-flex flex-wrap gap-1 rounded-xl border border-line bg-bg p-1', className)}>
      {options.map((o) => (
        <button
          key={String(o.value)} type="button" role="radio" aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={clsx('min-h-8 rounded-lg px-3 text-xs font-medium transition-colors', value === o.value ? 'bg-surface-2 text-fg shadow-[inset_0_0_0_1px_var(--rs-border-strong)]' : 'text-fg-3 hover:text-fg-2')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
