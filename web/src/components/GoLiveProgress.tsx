import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { CheckCircle2, Radio, X } from 'lucide-react';
import type { Stream } from '../lib/api';
import { useStreams } from '../lib/streams';
import { OutputBadge, PlatformChip, outputView } from './media';

/** After this long the startup panel is no longer shown (a reload during a long broadcast shows no timer). */
const STARTUP_WINDOW_MS = 3 * 60_000;
/** How long the panel stays once every destination is sending data or has failed. */
const LINGER_MS = 20_000;
/** Destinations put live within this time of each other count as one Go live. */
const TOGETHER_MS = 15_000;

/** Seconds with one decimal, e.g. 6.2 s (5,8 s in Dutch). */
function seconds(ms: number, lang: string) {
  return `${(Math.max(0, ms) / 1000).toLocaleString(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
}

/** 00:06.2 */
function stopwatch(ms: number) {
  const t = Math.round(Math.max(0, ms) / 100) * 100;
  const m = Math.floor(t / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${Math.floor((t % 1000) / 100)}`;
}

/**
 * Shown right after Go live: a running stopwatch and, per destination, whether it is still starting or
 * already sending data (and how long that took). Times come from the server (Go live moment and the
 * moment FFmpeg first sent data), corrected for the difference between the server's and this browser's clock.
 */
export function GoLiveProgress({ stream }: { stream: Stream }) {
  const { t, i18n } = useTranslation();
  const q = useStreams();
  const offset = q.data?.serverTime ? new Date(q.data.serverTime).getTime() - q.dataUpdatedAt : 0;
  const [now, setNow] = useState(Date.now());
  const [closedFor, setClosedFor] = useState<number | null>(null);

  // The latest Go live, with the destinations started together with it (Go live for all, or one by one within a few seconds).
  const started = stream.destinations.filter((d) => d.live && d.liveSince).map((d) => ({ d, begun: new Date(d.liveSince!).getTime() }));
  const latest = started.length ? Math.max(...started.map((x) => x.begun)) : null;
  const batch = latest === null ? [] : started.filter((x) => x.begun >= latest - TOGETHER_MS);
  const start = batch.length ? Math.min(...batch.map((x) => x.begun)) : null;
  const serverNow = now + offset;

  const rows = batch.map(({ d, begun }) => {
    const view = outputView(d.status);
    const sendingAt = view === 'live' && d.status.since ? new Date(d.status.since).getTime() : null;
    return { d, view, begun, sendingAt, done: view === 'live' || view === 'error' };
  });

  const allDone = rows.length > 0 && rows.every((r) => r.done);
  // The stopwatch stops when the last destination is sending or has failed: freeze the moment it was first seen.
  const [settledAt, setSettledAt] = useState<{ start: number; at: number } | null>(null);
  useEffect(() => {
    if (allDone && start !== null && settledAt?.start !== start) setSettledAt({ start, at: Date.now() + offset });
    if (!allDone && settledAt) setSettledAt(null);
  }, [allDone, start, settledAt, offset]);
  const failedSettle = settledAt?.start === start ? settledAt.at : serverNow;
  const lastDone = allDone ? Math.max(...rows.map((r) => r.sendingAt ?? failedSettle)) : null;
  const visible = start !== null && serverNow - start < STARTUP_WINDOW_MS && (!allDone || serverNow - (lastDone ?? serverNow) < LINGER_MS) && closedFor !== start;

  // Tick ten times a second while the stopwatch runs, once a second while the panel lingers.
  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => setNow(Date.now()), allDone ? 1000 : 100);
    return () => clearInterval(id);
  }, [visible, allDone]);
  // Keep checking once a second whether a new Go live started, so the panel can appear.
  useEffect(() => {
    if (visible) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [visible]);

  if (!visible || start === null) return null;

  const sending = rows.filter((r) => r.view === 'live').length;
  const failed = rows.filter((r) => r.view === 'error').length;
  const elapsed = (allDone ? lastDone! : serverNow) - start;
  const pct = Math.round((rows.filter((r) => r.done).length / rows.length) * 100);
  const ok = allDone && failed === 0;

  return (
    <section
      aria-label={t('goLiveProgress.title')}
      className={clsx('flex flex-col gap-4 rounded-2xl border bg-surface p-5', ok ? 'border-ok/40' : failed ? 'border-danger/40' : 'border-accent/40')}
    >
      <div className="flex flex-wrap items-center gap-4">
        <div className={clsx('flex size-11 shrink-0 items-center justify-center rounded-xl border', ok ? 'border-ok/30 bg-ok/10 text-ok' : 'border-accent/30 bg-accent/10 text-accent')}>
          {ok ? <CheckCircle2 size={22} /> : <Radio size={22} className={allDone ? undefined : 'pulse-dot'} />}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="eyebrow">{t('goLiveProgress.title')}</span>
          <span className="text-sm text-fg-2" aria-live="polite">
            {ok ? t('goLiveProgress.allSending', { time: seconds(elapsed, i18n.language) })
              : allDone ? t('goLiveProgress.doneWithErrors', { sending, failed })
                : t('goLiveProgress.starting', { sending, total: rows.length })}
          </span>
        </div>
        <span className={clsx('font-mono text-3xl font-semibold tabular-nums', ok ? 'text-ok' : 'text-fg')} aria-label={t('goLiveProgress.elapsed')}>
          {stopwatch(elapsed)}
        </span>
        <button
          type="button" onClick={() => setClosedFor(start)} aria-label={t('common.close')}
          className="flex size-9 items-center justify-center rounded-lg text-fg-3 hover:bg-surface-2 hover:text-fg"
        >
          <X size={16} />
        </button>
      </div>

      <div className="h-1.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className={clsx('h-full rounded-full transition-[width] duration-500', ok ? 'bg-ok' : failed ? 'bg-danger' : 'bg-accent')} style={{ width: `${Math.max(pct, 4)}%` }} />
      </div>

      <ul className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-3">
        {rows.map(({ d, view, begun, sendingAt }) => (
          <li key={d.id} className="flex items-center gap-3 rounded-xl border border-line bg-bg/40 px-3 py-2">
            <PlatformChip platform={d.platform} size={28} />
            <span className="min-w-0 flex-1 truncate text-sm">{d.name}</span>
            {view === 'live' && sendingAt !== null ? (
              <span className="flex items-center gap-1.5 font-mono text-xs text-ok">
                <CheckCircle2 size={13} /> {t('goLiveProgress.sendingAfter', { time: seconds(sendingAt - begun, i18n.language) })}
              </span>
            ) : view === 'error' ? (
              <OutputBadge status={d.status} />
            ) : (
              <span className="flex items-center gap-2">
                <OutputBadge status={d.status} />
                <span className="font-mono text-xs tabular-nums text-fg-3">{seconds(serverNow - begun, i18n.language)}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
