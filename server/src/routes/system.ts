import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { branchToChannel, config, readBuildInfo } from '../config.js';
import { HttpError, requireAuth } from '../lib/guards.js';
import { fetchRemote, readUpdateStatus, requestUpdate } from '../lib/updates.js';
import { getSettings } from '../lib/settings.js';
import { decrypt } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';

const startedAt = Date.now();
const run = promisify(execFile);

/** Versions of the media tools, looked up once per process (null when not installed or not reachable). */
let ffmpegVersion: Promise<string | null> | null = null;
async function mediaVersions() {
  ffmpegVersion ??= run(config.media.ffmpegPath, ['-version'], { timeout: 3000 })
    .then((r) => r.stdout.split('\n')[0]?.match(/version (\S+)/)?.[1] ?? null).catch(() => null);
  const mediamtx = config.media.enabled
    ? await fetch(`${config.media.apiUrl}/v3/info`, { signal: AbortSignal.timeout(1500) })
      .then((r) => (r.ok ? r.json() as Promise<{ version?: string }> : null)).then((j) => j?.version?.trim() || null).catch(() => null)
    : null;
  return { mediamtx, ffmpeg: await ffmpegVersion };
}

export async function systemRoutes(app: FastifyInstance, { sql }: { sql: Sql }) {
  app.get('/api/health', async () => {
    await sql`SELECT 1`;
    return { ok: true, version: readBuildInfo().version };
  });

  app.get('/api/system/info', { preHandler: requireAuth() }, async () => {
    const b = readBuildInfo();
    const [{ pg }] = await sql<{ pg: string }[]>`SELECT current_setting('server_version') AS pg`;
    return {
      version: b.version,
      commit: b.commit,
      branch: b.branch,
      channel: branchToChannel(b.branch),
      builtAt: b.builtAt,
      node: process.version,
      postgres: pg,
      os: `${os.type()} ${os.release()}`,
      hostname: os.hostname(),
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      repository: config.githubRepo,
      updaterEnabled: config.updaterEnabled,
      ...(await mediaVersions()),
    };
  });

  app.get('/api/system/update/check', { preHandler: requireAuth('admin') }, async () => {
    const b = readBuildInfo();
    const s = await getSettings(sql);
    const token = s.githubTokenEnc ? decrypt(s.githubTokenEnc) : '';
    const current = branchToChannel(b.branch);
    const [production, test] = await Promise.allSettled([fetchRemote('production', token), fetchRemote('test', token)]);
    const pick = (r: PromiseSettledResult<Awaited<ReturnType<typeof fetchRemote>>>) =>
      r.status === 'fulfilled' ? r.value : { error: String((r.reason as Error)?.message ?? r.reason) };
    const channels = { production: pick(production), test: pick(test) };
    const latest = channels[current];
    return {
      checkedAt: new Date().toISOString(),
      current: { version: b.version, commit: b.commit, channel: current },
      channels,
      updateAvailable: 'commit' in latest ? latest.commit !== b.commit : false,
    };
  });

  app.get('/api/system/update/status', { preHandler: requireAuth('admin') }, async () => readUpdateStatus());

  app.post('/api/system/update', { preHandler: requireAuth('admin') }, async (req) => {
    const { channel } = z.object({ channel: z.enum(['production', 'test']) }).parse(req.body);
    if (!config.updaterEnabled) throw new HttpError(409, 'updater_unavailable');
    const st = readUpdateStatus();
    if (st.state === 'running' || st.state === 'queued') throw new HttpError(409, 'update_in_progress');
    requestUpdate(channel, req.user!.email);
    await audit(sql, req, 'system.update_requested', { channel, from: readBuildInfo().commit });
    return { ok: true };
  });
}
