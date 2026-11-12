import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository root (one level above server/). */
export const appDir = process.env.APP_DIR ?? path.resolve(here, '..', '..');

function bool(v: string | undefined, def: boolean) {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://restream:restream@127.0.0.1:5432/restream',
  /** 32-byte key (hex or base64) used to encrypt 2FA secrets at rest. */
  appKey: process.env.APP_KEY ?? '',
  cookieSecure: bool(process.env.COOKIE_SECURE, process.env.NODE_ENV === 'production'),
  sessionHours: Number(process.env.SESSION_HOURS ?? 12),
  dataDir: process.env.DATA_DIR ?? path.join(appDir, 'data'),
  /** Directory the updater watches for requests (writable by the app). */
  updateRequestDir: process.env.UPDATE_REQUEST_DIR ?? '/var/lib/restream/update-request',
  /** Directory the updater writes status and log to (read-only for the app). */
  updateStatusDir: process.env.UPDATE_STATUS_DIR ?? '/var/lib/restream-updater',
  updaterEnabled: bool(process.env.UPDATER_ENABLED, false),
  githubRepo: process.env.GITHUB_REPO ?? 'rhisijmuiden/restream',
  webDist: process.env.WEB_DIST ?? path.join(appDir, 'web', 'dist'),
  logLevel: process.env.LOG_LEVEL ?? 'info',
};

export type Channel = 'production' | 'test';
export const channelBranch: Record<Channel, string> = { production: 'main', test: 'test' };
export function branchToChannel(branch: string | undefined): Channel {
  return branch === 'main' ? 'production' : 'test';
}

export interface BuildInfo {
  version: string;
  commit: string;
  branch: string;
  builtAt: string | null;
}

/** Reads build-info.json (written by the installer/updater) with git and package.json fallbacks. */
export function readBuildInfo(): BuildInfo {
  const pkg = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8')) as { version: string };
  const file = path.join(appDir, 'build-info.json');
  let info: Partial<BuildInfo> = {};
  if (existsSync(file)) {
    try { info = JSON.parse(readFileSync(file, 'utf8')); } catch { /* ignore */ }
  }
  if (!info.commit || !info.branch) {
    try {
      const head = readFileSync(path.join(appDir, '.git', 'HEAD'), 'utf8').trim();
      if (head.startsWith('ref: ')) {
        const ref = head.slice(5);
        info.branch ??= ref.replace('refs/heads/', '');
        const refFile = path.join(appDir, '.git', ref);
        if (existsSync(refFile)) info.commit ??= readFileSync(refFile, 'utf8').trim();
      } else {
        info.commit ??= head;
      }
    } catch { /* not a git checkout */ }
  }
  return {
    version: pkg.version,
    commit: info.commit ?? 'unknown',
    branch: info.branch ?? 'test',
    builtAt: info.builtAt ?? null,
  };
}
