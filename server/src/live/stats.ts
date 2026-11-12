import type { Sql } from '../db.js';

export interface OutputSummary { outputId: string; peak: number; avg: number; chat: number }
export interface BroadcastSummary { peak: number; avg: number; chat: number; current: number; outputs: OutputSummary[] }

/** Peak and average viewers (in total and per output) and chat counts, computed from the samples. */
export async function summarise(sql: Sql, broadcastId: string): Promise<BroadcastSummary> {
  const [tot] = await sql<{ peak: number | null; avg: number | null }[]>`
    SELECT max(total)::int AS peak, round(avg(total))::int AS avg
    FROM (SELECT sum(viewers) AS total FROM viewer_samples WHERE broadcast_id = ${broadcastId} GROUP BY at) t`;
  const [last] = await sql<{ total: number }[]>`
    SELECT sum(viewers)::int AS total FROM viewer_samples
    WHERE broadcast_id = ${broadcastId} AND at = (SELECT max(at) FROM viewer_samples WHERE broadcast_id = ${broadcastId})`;
  const outs = await sql<{ id: string; peak: number | null; avg: number | null; chat: number }[]>`
    SELECT o.id,
           (SELECT max(viewers) FROM viewer_samples s WHERE s.output_id = o.id)::int AS peak,
           (SELECT round(avg(viewers)) FROM viewer_samples s WHERE s.output_id = o.id)::int AS avg,
           (SELECT count(*) FROM chat_messages c WHERE c.output_id = o.id)::int AS chat
    FROM broadcast_outputs o WHERE o.broadcast_id = ${broadcastId}`;
  return {
    peak: tot?.peak ?? 0,
    avg: tot?.avg ?? 0,
    current: last?.total ?? 0,
    chat: outs.reduce((n, o) => n + o.chat, 0),
    outputs: outs.map((o) => ({ outputId: o.id, peak: o.peak ?? 0, avg: o.avg ?? 0, chat: o.chat })),
  };
}

/** Stores the final figures on the broadcast and its outputs, and ends it. */
export async function closeBroadcast(sql: Sql, broadcastId: string) {
  const s = await summarise(sql, broadcastId);
  for (const o of s.outputs) {
    await sql`UPDATE broadcast_outputs SET peak_viewers = ${o.peak}, avg_viewers = ${o.avg}, chat_messages = ${o.chat} WHERE id = ${o.outputId}`;
  }
  await sql`
    UPDATE broadcasts SET ended_at = last_live_at, peak_viewers = ${s.peak}, avg_viewers = ${s.avg}, chat_messages = ${s.chat}
    WHERE id = ${broadcastId} AND ended_at IS NULL`;
}
