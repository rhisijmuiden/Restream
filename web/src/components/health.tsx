import { useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, OctagonAlert } from 'lucide-react';
import { clsx } from 'clsx';
import { api, type HealthIssue, type HealthSnapshot } from '../lib/api';

/** Live health of the server, feeds and destinations; refreshed every 2 seconds while the page is open. */
export function useHealth(history = true) {
  return useQuery({
    queryKey: ['health', history],
    queryFn: () => api<HealthSnapshot>(`/api/monitor?history=${history ? 1 : 0}`),
    refetchInterval: 2000,
  });
}

/** Where an issue is: "Server", "Sunday service · main feed" or "Sunday service › YouTube". */
export function issueWhere(t: TFunction, i: HealthIssue) {
  if (i.destinationName) return `${i.streamName} › ${i.destinationName}`;
  if (i.streamName) return `${i.streamName} · ${t(`health.input_${i.input ?? 'main'}`)}`;
  return t('health.server');
}

/** The label and the explanation of an issue, in the user's language. */
export function issueText(t: TFunction, code: string, params: Record<string, string | number>) {
  return { label: t(`health.issue.${code}.label`, params), text: t(`health.issue.${code}.text`, params) };
}

export function IssueRow({ issue, compact }: { issue: HealthIssue; compact?: boolean }) {
  const { t } = useTranslation();
  const { label, text } = issueText(t, issue.code, issue.params);
  const danger = issue.severity === 'danger';
  const Icon = danger ? OctagonAlert : AlertTriangle;
  return (
    <li className={clsx('flex items-start gap-3 rounded-xl border px-3.5 py-3', danger ? 'border-danger/40 bg-danger/[0.06]' : 'border-warn/40 bg-warn/[0.06]')}>
      <Icon size={17} className={clsx('mt-0.5 shrink-0', danger ? 'text-danger' : 'text-warn')} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-medium">{label}</span>
          <span className="truncate text-xs text-fg-3">{issueWhere(t, issue)}</span>
        </span>
        {!compact && <span className="text-xs leading-relaxed text-fg-2">{text}</span>}
      </div>
    </li>
  );
}

/** Open issues for one stream (and the server), shown above the dashboard. */
export function HealthStrip({ streamId }: { streamId: string }) {
  const { t } = useTranslation();
  const q = useHealth(false);
  const issues = (q.data?.issues ?? []).filter((i) => !i.streamId || i.streamId === streamId);
  if (!issues.length) return null;
  const danger = issues.some((i) => i.severity === 'danger');
  return (
    <section aria-label={t('health.title')} className={clsx('flex flex-col gap-3 rounded-2xl border p-4', danger ? 'border-danger/40 bg-danger/[0.05]' : 'border-warn/40 bg-warn/[0.05]')}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium">{t('health.stripTitle', { count: issues.length })}</span>
        <Link to={`/health?stream=${streamId}`} className="ml-auto flex items-center gap-1 text-sm">{t('health.open')} <ArrowRight size={14} /></Link>
      </div>
      <ul className="flex flex-col gap-2">
        {issues.slice(0, 3).map((i) => <IssueRow key={i.key} issue={i} />)}
      </ul>
      {issues.length > 3 && <span className="text-xs text-fg-3">{t('health.more', { count: issues.length - 3 })}</span>}
    </section>
  );
}

export interface Series { values: (number | null)[]; color: string; label: string }

/**
 * A small line chart over the last minutes: one or two series sharing the time axis, each with its own scale
 * (bitrate and frame rate do not share units). The latest values are written above it.
 */
export function Sparkline({ times, series, height = 72, max, label }: { times: number[]; series: Series[]; height?: number; max?: (number | undefined)[]; label: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(300);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const n = times.length;
  const t0 = times[0] ?? 0;
  const t1 = times[n - 1] ?? 1;
  const pad = 3;
  const x = (t: number) => pad + ((t - t0) / Math.max(1, t1 - t0)) * (w - pad * 2);
  return (
    <div ref={wrap} className="w-full">
      <svg width={w} height={height} role="img" aria-label={label} className="block">
        <line x1={0} x2={w} y1={height - 1} y2={height - 1} stroke="var(--rs-border)" />
        {n > 1 && series.map((s, si) => {
          const vals = s.values.filter((v): v is number => v !== null);
          const top = Math.max(max?.[si] ?? 0, ...vals, 1) * 1.15;
          const y = (v: number) => height - pad - (v / top) * (height - pad * 2);
          // Gaps (no value) break the line instead of drawing to zero.
          let d = '';
          let pen = false;
          s.values.forEach((v, i) => {
            if (v === null) { pen = false; return; }
            d += `${pen ? 'L' : 'M'}${x(times[i]!).toFixed(1)},${y(v).toFixed(1)}`;
            pen = true;
          });
          return (
            <g key={si}>
              {si === 0 && d && (
                <path d={`${d}L${x(t1).toFixed(1)},${height - 1}L${x(times[s.values.findIndex((v) => v !== null)] ?? t0).toFixed(1)},${height - 1}Z`} fill={s.color} opacity={0.1} />
              )}
              <path d={d} fill="none" stroke={s.color} strokeWidth={1.6} strokeLinejoin="round" strokeDasharray={si ? '4 3' : undefined} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** A figure with its label and a colour by state, as used on the health page. */
export function Metric({ label, value, tone = 'neutral', sub }: { label: string; value: string; tone?: 'neutral' | 'ok' | 'warn' | 'danger'; sub?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="eyebrow truncate">{label}</span>
      <span className={clsx('font-mono text-lg tabular-nums', tone === 'ok' && 'text-ok', tone === 'warn' && 'text-warn', tone === 'danger' && 'text-danger')}>{value}</span>
      {sub && <span className="truncate text-xs text-fg-3">{sub}</span>}
    </div>
  );
}
