import { useQuery } from '@tanstack/react-query';
import { api, type PlatformPreset, type Platform, type StreamsResponse } from './api';

/** Output states that change within seconds: the console refreshes faster while one is shown. */
const settling = new Set(['preparing', 'connecting', 'reconnecting']);

/** Streams with live ingest and output status: every second while a destination is starting, else every two seconds. */
export function useStreams() {
  return useQuery({
    queryKey: ['streams'], queryFn: () => api<StreamsResponse>('/api/streams'),
    refetchInterval: (q) => (q.state.data?.streams.some((s) => s.destinations.some((d) => d.live && settling.has(d.status.state))) ? 1000 : 2000),
  });
}

export function usePresets() {
  return useQuery({ queryKey: ['platforms'], queryFn: () => api<Record<Platform, PlatformPreset>>('/api/platforms'), staleTime: Infinity });
}

export const platformMeta: Record<Platform, { short: string; color: string; label: string }> = {
  youtube: { short: 'YT', color: 'var(--rs-youtube)', label: 'YouTube' },
  facebook: { short: 'FB', color: 'var(--rs-facebook)', label: 'Facebook' },
  twitch: { short: 'TW', color: 'var(--rs-twitch)', label: 'Twitch' },
  instagram: { short: 'IG', color: 'var(--rs-instagram)', label: 'Instagram' },
  kick: { short: 'KICK', color: 'var(--rs-kick)', label: 'Kick' },
  x: { short: 'X', color: 'var(--rs-x)', label: 'X' },
  linkedin: { short: 'IN', color: 'var(--rs-linkedin)', label: 'LinkedIn' },
  tiktok: { short: 'TT', color: 'var(--rs-tiktok)', label: 'TikTok' },
  vimeo: { short: 'VI', color: 'var(--rs-vimeo)', label: 'Vimeo' },
  dailymotion: { short: 'DM', color: 'var(--rs-dailymotion)', label: 'Dailymotion' },
  rumble: { short: 'RU', color: 'var(--rs-rumble)', label: 'Rumble' },
  trovo: { short: 'TR', color: 'var(--rs-trovo)', label: 'Trovo' },
  owncast: { short: 'OC', color: 'var(--rs-owncast)', label: 'Owncast' },
  peertube: { short: 'PT', color: 'var(--rs-peertube)', label: 'PeerTube' },
  rtmp: { short: 'RTMP', color: 'var(--rs-accent)', label: 'RTMP' },
  srt: { short: 'SRT', color: 'var(--rs-info)', label: 'SRT' },
};

export function formatKbps(kbps: number | null | undefined) {
  if (kbps === null || kbps === undefined) return '—';
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`;
}

export function sinceSeconds(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return 0;
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
}

/** 01:02:03 style running time. */
export function clock(sec: number) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}
