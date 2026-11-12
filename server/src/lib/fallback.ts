import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The standard fallback image shipped with Restream (server/assets/fallback.png). */
export function standardFallbackImage(): string | null {
  const candidates = [path.join(here, '..', 'assets', 'fallback.png'), path.join(here, '..', '..', 'assets', 'fallback.png')];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Uploaded fallback images live in DATA_DIR/assets, which the backups include. */
export const fallbackDir = () => path.join(config.dataDir, 'assets', 'fallback');

/** The image to put on air, or null when there is none. A missing upload falls back to the standard image. */
export function fallbackImagePath(mode: 'standard' | 'image', file: string | null): string | null {
  if (mode === 'image' && file && /^[\w.-]+$/.test(file)) {
    const p = path.join(fallbackDir(), file);
    if (existsSync(p)) return p;
  }
  return standardFallbackImage();
}

/** Recognises PNG and JPEG by their first bytes; returns the file extension or null. */
export function imageType(buf: Buffer): 'png' | 'jpg' | null {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  return null;
}
