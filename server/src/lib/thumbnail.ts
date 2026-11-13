import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

/** Broadcast thumbnails live in DATA_DIR/assets, which the backups include. */
export const thumbnailDir = () => path.join(config.dataDir, 'assets', 'thumbnails');

/** YouTube refuses thumbnails above 2 MB. */
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

/** The stored thumbnail of a stream with its type, or null when there is none (or the file is gone). */
export async function readThumbnail(file: string | null): Promise<{ data: Buffer; type: 'png' | 'jpg' } | null> {
  if (!file || !/^[\w.-]+$/.test(file)) return null;
  const p = path.join(thumbnailDir(), file);
  if (!existsSync(p)) return null;
  return { data: await readFile(p), type: file.endsWith('.png') ? 'png' : 'jpg' };
}
