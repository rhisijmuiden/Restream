import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { config, channelBranch, type Channel, readBuildInfo } from '../config.js';

export interface RemoteRelease {
  channel: Channel;
  branch: string;
  version: string | null;
  commit: string;
  date: string | null;
  message: string;
}

async function gh(url: string, token: string) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'restream-updater',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}

/** Looks up the latest commit and package version on the branch of a release channel. */
export async function fetchRemote(channel: Channel, token = ''): Promise<RemoteRelease> {
  const branch = channelBranch[channel];
  const base = `https://api.github.com/repos/${config.githubRepo}`;
  const b = (await gh(`${base}/branches/${branch}`, token)) as {
    commit: { sha: string; commit: { message: string; committer: { date: string } } };
  };
  let version: string | null = null;
  try {
    const f = (await gh(`${base}/contents/package.json?ref=${b.commit.sha}`, token)) as { content: string };
    version = JSON.parse(Buffer.from(f.content, 'base64').toString('utf8')).version ?? null;
  } catch { /* version stays unknown */ }
  return {
    channel, branch, version, commit: b.commit.sha,
    date: b.commit.commit.committer?.date ?? null,
    message: b.commit.commit.message.split('\n')[0],
  };
}

export interface UpdateStatus {
  state: 'idle' | 'queued' | 'running' | 'success' | 'failed' | 'rolled_back';
  step?: string;
  channel?: Channel;
  from?: string;
  to?: string;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
}

const requestFile = () => path.join(config.updateRequestDir, 'request.json');

export function readUpdateStatus(): UpdateStatus & { log: string } {
  const statusFile = path.join(config.updateStatusDir, 'status.json');
  const logFile = path.join(config.updateStatusDir, 'update.log');
  let status: UpdateStatus = { state: 'idle' };
  try { if (existsSync(statusFile)) status = JSON.parse(readFileSync(statusFile, 'utf8')); } catch { /* ignore */ }
  if (existsSync(requestFile()) && status.state !== 'running') status = { ...status, state: 'queued' };
  let log = '';
  try { if (existsSync(logFile)) log = readFileSync(logFile, 'utf8').split('\n').slice(-200).join('\n'); } catch { /* ignore */ }
  return { ...status, log };
}

/**
 * Hands an update request to the root-owned updater (a systemd path unit watches the file).
 * The app itself never runs privileged commands.
 */
export function requestUpdate(channel: Channel, requestedBy: string) {
  mkdirSync(config.updateRequestDir, { recursive: true });
  const tmp = path.join(config.updateRequestDir, '.request.tmp');
  writeFileSync(tmp, JSON.stringify({ channel, requestedBy, requestedAt: new Date().toISOString(), from: readBuildInfo().commit }));
  renameSync(tmp, requestFile());
}
