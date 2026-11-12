import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import type { Destination, IngestStatus, Platform } from '../lib/api';
import { platformMeta } from '../lib/streams';
import { Badge } from './ui';

export function PlatformChip({ platform, size = 36 }: { platform: Platform; size?: number }) {
  const m = platformMeta[platform];
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-lg font-mono text-[10px] font-semibold text-ink"
      style={{ background: m.color, width: size, height: size }}
      aria-hidden
    >
      {m.short}
    </div>
  );
}

export function OutputBadge({ status }: { status: Destination['status'] }) {
  const { t } = useTranslation();
  const tone = { off: 'neutral', waiting: 'warn', connecting: 'accent', live: 'live', reconnecting: 'warn' } as const;
  return (
    <Badge tone={tone[status.state]} dot>
      {status.state === 'reconnecting' && status.attempts > 0
        ? t('output.reconnectingN', { n: status.attempts })
        : t(`output.${status.state}`)}
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
