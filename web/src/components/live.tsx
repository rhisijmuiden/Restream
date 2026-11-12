import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { ArrowDown, Eye, MessageSquare, TrendingUp } from 'lucide-react';
import type { ChatMessage, LiveDestination, LiveResponse, Platform } from '../lib/api';
import { formatCount } from '../lib/live';
import { platformMeta } from '../lib/streams';
import { PlatformChip } from './media';

const chatPlatforms: Platform[] = ['youtube', 'facebook', 'twitch'];

function time(iso: string, lang: string) {
  return new Intl.DateTimeFormat(lang === 'nl' ? 'nl-NL' : 'en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

/** Total viewers right now, the peak of this broadcast, and one row per destination. */
export function Audience({ data, compact }: { data: Omit<LiveResponse, 'chat' | 'cursor'> | null; compact?: boolean }) {
  const { t, i18n } = useTranslation();
  const b = data?.broadcast ?? null;
  const rows = (data?.destinations ?? []).filter((d) => d.onAir);
  const max = Math.max(1, ...rows.map((d) => d.viewers ?? 0));
  return (
    <section aria-label={t('live.audience')} className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <span className="eyebrow flex items-center gap-2"><Eye size={13} /> {t('live.audience')}</span>
        {b && <span className="eyebrow flex items-center gap-1.5 text-fg-3"><TrendingUp size={13} /> {t('live.peak', { n: formatCount(b.peakViewers, i18n.language) })}</span>}
      </div>
      {!b ? (
        <p className="text-sm text-fg-3">{t('live.offAir')}</p>
      ) : (
        <>
          <div className="flex items-end gap-3">
            <span className="font-display text-5xl font-semibold tabular-nums" aria-live="polite">{formatCount(data?.totalViewers, i18n.language)}</span>
            <span className="pb-1.5 text-sm text-fg-3">{t('live.watchingNow')}</span>
          </div>
          {rows.length > 0 && (
            <ul className={clsx('flex flex-col', compact ? 'gap-2.5' : 'gap-3')}>
              {rows.map((d) => <AudienceRow key={d.destinationId} d={d} max={max} />)}
            </ul>
          )}
          {data?.totalViewers === null && <p className="text-xs leading-relaxed text-fg-3">{t('live.noStatsHint')}</p>}
        </>
      )}
    </section>
  );
}

function AudienceRow({ d, max }: { d: LiveDestination; max: number }) {
  const { t, i18n } = useTranslation();
  const pct = d.viewers ? Math.max(2, Math.round((d.viewers / max) * 100)) : 0;
  return (
    <li className="flex flex-col gap-1.5" title={d.error ?? undefined}>
      <div className="flex items-center gap-2.5 text-sm">
        <PlatformChip platform={d.platform} size={22} />
        <span className="min-w-0 flex-1 truncate text-fg-2">{d.name}</span>
        <span className={clsx('font-mono text-[13px] tabular-nums', d.error ? 'text-warn' : 'text-fg')}>
          {d.supported ? (d.viewers === null ? '…' : formatCount(d.viewers, i18n.language)) : <span className="text-fg-3">{t('live.na')}</span>}
        </span>
      </div>
      {d.supported && (
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
          <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${pct}%`, background: platformMeta[d.platform].color }} />
        </div>
      )}
    </li>
  );
}

/** Messages of all platforms in one list; keeps to the bottom unless the reader scrolled up. */
export function ChatList({ messages, destinations, className, empty }: { messages: ChatMessage[]; destinations?: LiveDestination[]; className?: string; empty?: string }) {
  const { t, i18n } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [hidden, setHidden] = useState<Set<Platform>>(new Set());
  const shown = messages.filter((m) => !hidden.has(m.platform));
  const present = chatPlatforms.filter((p) => messages.some((m) => m.platform === p) || destinations?.some((d) => d.platform === p && d.onAir && d.supported));
  const unread = useRef(0);
  const [newCount, setNewCount] = useState(0);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (pinned) { el.scrollTop = el.scrollHeight; unread.current = 0; setNewCount(0); }
  }, [shown.length, pinned]);
  const last = useRef(messages.length);
  useEffect(() => {
    if (!pinned && messages.length > last.current) { unread.current += messages.length - last.current; setNewCount(unread.current); }
    last.current = messages.length;
  }, [messages.length, pinned]);

  const problems = (destinations ?? []).filter((d) => d.onAir && d.supported && d.chat === 'error');

  return (
    <div className={clsx('flex min-h-0 flex-col gap-3', className)}>
      {present.length > 1 && (
        <div role="group" aria-label={t('live.filter')} className="flex flex-wrap gap-1.5">
          {present.map((p) => {
            const on = !hidden.has(p);
            return (
              <button
                key={p} aria-pressed={on}
                onClick={() => setHidden((h) => { const n = new Set(h); if (on) n.add(p); else n.delete(p); return n; })}
                className={clsx('flex min-h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors', on ? 'border-line-strong text-fg' : 'border-line text-fg-3 line-through')}
              >
                <span className="size-2 rounded-full" style={{ background: platformMeta[p].color, opacity: on ? 1 : 0.35 }} />
                {platformMeta[p].label} <span className="font-mono text-fg-3">{messages.filter((m) => m.platform === p).length}</span>
              </button>
            );
          })}
        </div>
      )}
      {problems.map((d) => (
        <p key={d.destinationId} className="rounded-lg border border-warn/30 bg-warn/[0.06] px-3 py-2 text-xs text-warn" title={d.chatError ?? undefined}>
          {t('live.chatError', { name: d.name })}{d.chatError ? `: ${d.chatError}` : ''}
        </p>
      ))}
      <div className="relative min-h-0 flex-1">
        <div
          ref={box} role="log" aria-live="polite" aria-label={t('live.chat')}
          onScroll={(e) => { const el = e.currentTarget; setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 40); }}
          className="h-full overflow-y-auto overscroll-contain rounded-xl border border-line bg-bg/60"
        >
          {shown.length === 0 ? (
            <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-fg-3">
              <MessageSquare size={26} strokeWidth={1.5} />
              {empty ?? t('live.chatEmpty')}
            </div>
          ) : (
            <ul className="flex flex-col py-1.5">
              {shown.map((m) => (
                <li key={m.seq} className={clsx('flex gap-2.5 px-3 py-1.5 text-sm hover:bg-surface-2/50', m.highlight && 'bg-accent/[0.06]')}>
                  <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: platformMeta[m.platform].color }} title={`${platformMeta[m.platform].label} · ${m.destination}`} />
                  <div className="min-w-0 flex-1 leading-relaxed">
                    <span className="mr-1.5 font-medium text-fg">{m.author}</span>
                    {m.highlight && <span className="mr-1.5 rounded-md border border-accent/40 px-1.5 py-px font-mono text-[11px] text-accent">{m.highlight}</span>}
                    <span className="break-words text-fg-2">{m.text}</span>
                  </div>
                  <time dateTime={m.at} className="shrink-0 pt-0.5 font-mono text-[11px] text-fg-3">{time(m.at, i18n.language)}</time>
                </li>
              ))}
            </ul>
          )}
        </div>
        {!pinned && (
          <button
            onClick={() => setPinned(true)}
            className="absolute bottom-3 left-1/2 flex min-h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-accent/40 bg-surface px-3 text-xs text-accent shadow-lg"
          >
            <ArrowDown size={13} /> {newCount > 0 ? t('live.newMessages', { count: newCount }) : t('live.toLatest')}
          </button>
        )}
      </div>
    </div>
  );
}
