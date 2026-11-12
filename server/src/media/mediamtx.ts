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

/** Disconnects the publisher of a path (used when a key is rotated or a stream is disabled). */
export async function kickPublisher(p: MtxPath): Promise<void> {
  if (!p.source) return;
  const kind = p.source.type.startsWith('rtmp') ? 'rtmpconns' : p.source.type.startsWith('srt') ? 'srtconns'
    : p.source.type.startsWith('webRTC') ? 'webrtcsessions' : p.source.type.startsWith('rtsp') ? 'rtspsessions' : null;
  if (!kind) return;
  await fetch(`${config.media.apiUrl}/v3/${kind}/kick/${p.source.id}`, { method: 'POST', signal: AbortSignal.timeout(3000) }).catch(() => {});
}

/** Ingest path for a stream key. The key is the path, as with Twitch/YouTube style ingest. */
export const ingestPath = (key: string) => `live/${key}`;
