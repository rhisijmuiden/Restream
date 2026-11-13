import { config } from '../config.js';

export interface MtxTrack {
  codec: string;
  codecProps?: { width?: number; height?: number; sampleRate?: number; channelCount?: number; profile?: string | number };
}

export interface MtxPath {
  name: string;
  ready?: boolean;
  online?: boolean;
  onlineTime?: string | null;
  readyTime?: string | null;
  source: { type: string; id: string } | null;
  tracks2?: MtxTrack[];
  tracks?: string[];
  readers?: { type: string; id: string }[];
  inboundBytes?: number;
  bytesReceived?: number;
  inboundFramesInError?: number;
}

/** Link statistics of an SRT publisher (MediaMTX /v3/srt/conns/get). */
export interface SrtStats {
  msRTT?: number;
  /** Percentage of retransmitted data versus received data. */
  packetsReceivedLossRate?: number;
  mbpsLinkCapacity?: number;
  mbpsReceiveRate?: number;
  /** Packets that arrived too late (or never) and were skipped: picture errors at the viewers. */
  packetsReceivedDrop?: number;
}

/** Reads the link statistics of an SRT connection; null when it is gone or MediaMTX does not answer. */
export async function srtStats(id: string): Promise<SrtStats | null> {
  try {
    const res = await fetch(`${config.media.apiUrl}/v3/srt/conns/get/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return (await res.json()) as SrtStats;
  } catch {
    return null;
  }
}

/** Lists the active MediaMTX paths. Throws when MediaMTX is not reachable. */
export async function listPaths(): Promise<MtxPath[]> {
  const items: MtxPath[] = [];
  for (let page = 0; page < 20; page++) {
    const res = await fetch(`${config.media.apiUrl}/v3/paths/list?itemsPerPage=200&page=${page}`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`MediaMTX API ${res.status}`);
    const body = (await res.json()) as { pageCount: number; items: MtxPath[] };
    items.push(...body.items);
    if (page + 1 >= body.pageCount) break;
  }
  return items;
}

/**
 * API route of a publisher connection by its source type (MediaMTX v1.21: /v3/rtmp/conns/…, /v3/srt/conns/…).
 * Returns e.g. "rtmp/conns/kick", or null for a type without such a route.
 */
export function sourceApi(type: string, action: 'kick' | 'get'): string | null {
  const t = type.toLowerCase();
  const base = t.startsWith('rtmps') ? 'rtmps/conns' : t.startsWith('rtmp') ? 'rtmp/conns' : t.startsWith('srt') ? 'srt/conns'
    : t.startsWith('webrtc') ? 'webrtc/sessions' : t.startsWith('rtsps') ? 'rtsps/sessions' : t.startsWith('rtsp') ? 'rtsp/sessions' : null;
  return base ? `${base}/${action}` : null;
}

/** Disconnects the publisher of a path (used when a key is rotated or a stream is disabled). */
export async function kickPublisher(p: MtxPath): Promise<void> {
  if (!p.source) return;
  const kind = sourceApi(p.source.type, 'kick');
  if (!kind) return;
  await fetch(`${config.media.apiUrl}/v3/${kind}/${p.source.id}`, { method: 'POST', signal: AbortSignal.timeout(3000) }).catch(() => {});
}

/** Ingest path for a stream key. The key is the path, as with Twitch/YouTube style ingest. */
export const ingestPath = (key: string) => `live/${key}`;

/** Path of the light console preview of a feed (published by Restream's own FFmpeg, see previewArgs). */
export const previewPath = (key: string) => `preview/${key}`;
