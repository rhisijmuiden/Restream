import type { FastifyBaseLogger } from 'fastify';
import { rmSync } from 'node:fs';
import path from 'node:path';
import type { Sql } from '../db.js';
import { config } from '../config.js';
import { getSettings } from './settings.js';

/** Recordings live in DATA_DIR/recordings, which the backups include (incrementally). */
export const recordingsDir = () => path.join(config.dataDir, 'recordings');

/** Deletes a recording's file; a file that is already gone is fine. */
export function removeRecordingFile(file: string) {
  if (!/^[A-Za-z0-9._-]+$/.test(file)) return;
  rmSync(path.join(recordingsDir(), file), { force: true });
}

/** Removes finished and failed recordings older than the retention period (when one is set). */
export async function cleanupRecordings(sql: Sql, log: FastifyBaseLogger) {
  const s = await getSettings(sql);
  const days = s.recordings.retentionDays;
  if (!days || days < 1) return 0;
  const old = await sql<{ id: string; file: string }[]>`
    SELECT id, file FROM recordings WHERE status <> 'recording' AND started_at < now() - make_interval(days => ${days})`;
  for (const r of old) {
    removeRecordingFile(r.file);
    await sql`DELETE FROM recordings WHERE id = ${r.id}`;
  }
  if (old.length) log.info({ removed: old.length, days }, 'old recordings removed');
  return old.length;
}
