import { useEffect, useRef, useState } from 'react';
import { api, type ChatMessage, type LiveResponse } from './api';

const MAX_MESSAGES = 500;

/**
 * Live viewers and the combined chat of a stream, polled every 2.5 seconds.
 * Chat messages accumulate in the hook; only new ones are fetched after the first call.
 */
export function useLive(streamId: string | undefined) {
  const [data, setData] = useState<Omit<LiveResponse, 'chat' | 'cursor'> | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<unknown>(null);
  const cursor = useRef<number | undefined>(undefined);
  const broadcastId = useRef<string | null>(null);

  useEffect(() => {
    if (!streamId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    cursor.current = undefined; broadcastId.current = null;
    setData(null); setChat([]);
    const poll = async () => {
      try {
        const q = cursor.current !== undefined ? `?after=${cursor.current}` : '';
        const r = await api<LiveResponse>(`/api/streams/${streamId}/live${q}`);
        if (stopped) return;
        const bid = r.broadcast?.id ?? null;
        if (bid !== broadcastId.current) {
          // A new broadcast starts with its own chat.
          broadcastId.current = bid;
          if (cursor.current !== undefined) { cursor.current = undefined; setChat([]); timer = setTimeout(poll, 0); return; }
          setChat(r.chat);
        } else if (r.chat.length) {
          setChat((c) => [...c, ...r.chat].slice(-MAX_MESSAGES));
        }
        cursor.current = r.cursor;
        const { chat: _c, cursor: _k, ...rest } = r;
        setData(rest); setError(null);
      } catch (err) {
        if (!stopped) setError(err);
      }
      if (!stopped) timer = setTimeout(poll, 2500);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [streamId]);

  return { data, chat, error };
}

/** 1.234 / 12,3K style viewer counts. */
export function formatCount(n: number | null | undefined, lang: string) {
  if (n === null || n === undefined) return '—';
  return new Intl.NumberFormat(lang === 'nl' ? 'nl-NL' : 'en-GB', { notation: n >= 100_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);
}
