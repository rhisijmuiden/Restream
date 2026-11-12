import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BroadcastDetail } from '../lib/api';
import { formatCount } from '../lib/live';
import { platformMeta } from '../lib/streams';

const H = 220;
const PAD = { top: 12, right: 12, bottom: 26, left: 44 };

function niceMax(v: number) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/** Total viewers over the broadcast as one area; hovering shows the split per destination. */
export function ViewerChart({ b }: { b: BroadcastDetail }) {
  const { t, i18n } = useTranslation();
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const s = b.series;
  if (s.length < 2) {
    return <div className="flex h-[220px] items-center justify-center rounded-xl border border-dashed border-line text-sm text-fg-3">{t('analytics.noSamples')}</div>;
  }
  const t0 = new Date(s[0].at).getTime();
  const t1 = new Date(s[s.length - 1].at).getTime();
  const yMax = niceMax(Math.max(...s.map((p) => p.total)));
  const iw = Math.max(10, w - PAD.left - PAD.right);
  const ih = H - PAD.top - PAD.bottom;
  const x = (at: string) => PAD.left + ((new Date(at).getTime() - t0) / Math.max(1, t1 - t0)) * iw;
  const y = (v: number) => PAD.top + ih - (v / yMax) * ih;
  const line = s.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p.total).toFixed(1)}`).join('');
  const area = `${line}L${x(s[s.length - 1].at).toFixed(1)},${PAD.top + ih}L${PAD.left},${PAD.top + ih}Z`;
  // Short broadcasts get seconds on the axis, otherwise every tick reads the same minute.
  const short = t1 - t0 < 10 * 60_000;
  const fmtTime = (ms: number) => new Intl.DateTimeFormat(i18n.language === 'nl' ? 'nl-NL' : 'en-GB', { hour: '2-digit', minute: '2-digit', ...(short ? { second: '2-digit' } : {}) }).format(ms);
  const xTicks = Math.max(2, Math.min(6, Math.floor(iw / 110)));
  const h = hover !== null ? s[hover] : null;

  const onMove = (clientX: number) => {
    const r = wrap.current!.getBoundingClientRect();
    const px = clientX - r.left;
    let best = 0;
    for (let i = 1; i < s.length; i++) if (Math.abs(x(s[i].at) - px) < Math.abs(x(s[best].at) - px)) best = i;
    setHover(best);
  };

  return (
    <div ref={wrap} className="relative" onMouseLeave={() => setHover(null)}>
      <svg
        width={w} height={H} role="img" aria-label={t('analytics.chartLabel', { peak: b.peakViewers, avg: b.avgViewers })}
        onMouseMove={(e) => onMove(e.clientX)} onTouchStart={(e) => onMove(e.touches[0].clientX)} onTouchMove={(e) => onMove(e.touches[0].clientX)}
        className="block touch-pan-y"
      >
        <defs>
          <linearGradient id="viewers-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--rs-accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--rs-accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD.left} x2={PAD.left + iw} y1={y(yMax * f)} y2={y(yMax * f)} stroke="var(--rs-border)" strokeDasharray={f ? '2 4' : undefined} />
            <text x={PAD.left - 8} y={y(yMax * f) + 4} textAnchor="end" className="fill-fg-3 font-mono text-[10px]">{formatCount(yMax * f, i18n.language)}</text>
          </g>
        ))}
        {Array.from({ length: xTicks }, (_, i) => t0 + ((t1 - t0) * i) / (xTicks - 1)).map((ms, i) => (
          <text key={i} x={PAD.left + (iw * i) / (xTicks - 1)} y={H - 6} textAnchor={i === 0 ? 'start' : i === xTicks - 1 ? 'end' : 'middle'} className="fill-fg-3 font-mono text-[10px]">{fmtTime(ms)}</text>
        ))}
        <path d={area} fill="url(#viewers-fill)" />
        <path d={line} fill="none" stroke="var(--rs-accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {h && (
          <g>
            <line x1={x(h.at)} x2={x(h.at)} y1={PAD.top} y2={PAD.top + ih} stroke="var(--rs-border-strong)" />
            <circle cx={x(h.at)} cy={y(h.total)} r={5} fill="var(--rs-accent)" stroke="var(--rs-surface)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {h && (
        <div
          className="pointer-events-none absolute top-2 z-10 min-w-44 rounded-xl border border-line-strong bg-surface-2/95 px-3 py-2.5 text-xs shadow-xl backdrop-blur"
          style={x(h.at) > w / 2 ? { right: w - x(h.at) + 12 } : { left: x(h.at) + 12 }}
        >
          <div className="mb-1.5 font-mono text-fg-3">{fmtTime(new Date(h.at).getTime())}</div>
          <div className="mb-1.5 flex justify-between gap-4 font-medium"><span>{t('analytics.total')}</span><span className="font-mono tabular-nums">{formatCount(h.total, i18n.language)}</span></div>
          {b.outputs.filter((o) => o.stats).map((o) => (
            <div key={o.id} className="flex items-center justify-between gap-4 text-fg-2">
              <span className="flex min-w-0 items-center gap-1.5"><span className="size-2 shrink-0 rounded-full" style={{ background: platformMeta[o.platform].color }} /><span className="truncate">{o.name}</span></span>
              <span className="font-mono tabular-nums">{h.outputs[o.id] !== undefined ? formatCount(h.outputs[o.id], i18n.language) : '—'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
