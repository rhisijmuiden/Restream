import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import type { Destination, IngestStatus, Platform, SourceState } from '../lib/api';
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

export function OutputBadge({ status }: { status: Destination['status'] }) {
  const { t } = useTranslation();
  const tone = { off: 'neutral', waiting: 'warn', preparing: 'accent', connecting: 'accent', live: 'live', reconnecting: 'warn' } as const;
  return (
    <Badge tone={tone[status.state]} dot>
      {status.state === 'reconnecting' && status.attempts > 0
        ? t('output.reconnectingN', { n: status.attempts })
        : status.state === 'preparing' && status.lastError ? t('output.preparingFailed') : t(`output.${status.state}`)}
    </Badge>
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
