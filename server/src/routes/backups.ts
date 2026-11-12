import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { HttpError, requireAuth } from '../lib/guards.js';
import { getSettings, setSettings, type BackupSettings } from '../lib/settings.js';
import { encrypt } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { BackupError, BackupService } from '../backup/service.js';
import { RemoteError, defaultPort, generateSshKey } from '../backup/remote.js';
import { ArchiveError } from '../backup/archive.js';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

function fail(err: unknown): never {
  if (err instanceof BackupError || err instanceof RemoteError || err instanceof ArchiveError) {
    const status = err.code === 'backup_busy' ? 409 : err.code === 'not_found' ? 404 : 422;
    throw new HttpError(status, err.code, err.message, err.message === err.code ? undefined : err.message);
  }
  throw err;
}

function view(b: BackupSettings) {
  const { passphraseEnc, target, ...rest } = b;
  const { passwordEnc, privateKeyEnc, ...t } = target;
  return {
    ...rest,
    passphraseSet: !!passphraseEnc,
    target: { ...t, passwordSet: !!passwordEnc, privateKeySet: !!privateKeyEnc },
    configured: BackupService.configured(b),
  };
}

const chainId = z.string().regex(/^\d{8}-\d{6}-(full|incr)$/);

export async function backupRoutes(app: FastifyInstance, { sql, backups }: { sql: Sql; backups: BackupService }) {
  const admin = { preHandler: requireAuth('admin') };

  app.get('/api/backups/settings', admin, async () => {
    const s = await getSettings(sql);
    return {
      settings: view(s.backup),
      busy: backups.busy,
      serverTime: new Date().toString(),
      ...(await backups.localInfo()),
    };
  });

  app.put('/api/backups/settings', admin, async (req) => {
    const b = z.object({
      scheduleEnabled: z.boolean(),
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      full: z.enum(['daily', 'weekly', 'monthly']),
      fullWeekday: z.number().int().min(0).max(6),
      incremental: z.enum(['off', 'daily', 'every6h', 'hourly']),
      keepChains: z.number().int().min(1).max(52),
      /** Omitted keeps the passphrase. */
      passphrase: z.string().min(12).max(200).optional(),
      target: z.object({
        protocol: z.enum(['ftp', 'ftps', 'ftps-implicit', 'scp']),
        host: z.string().trim().max(253).regex(/^[A-Za-z0-9.-]*$|^\[[0-9a-fA-F:.]+\]$/),
        port: z.number().int().min(0).max(65535),
        username: z.string().trim().max(200),
        password: z.string().max(500).optional(),
        /** A pasted OpenSSH private key; omitted keeps the stored one, empty clears it. */
        privateKey: z.string().max(10_000).optional(),
        verifyCertificate: z.boolean(),
        path: z.string().trim().max(500).regex(/^[^\0\n\r]*$/).refine((p) => !p.split('/').includes('..')),
      }),
    }).parse(req.body);
    const cur = (await getSettings(sql)).backup;
    const t = b.target;
    if (b.scheduleEnabled && (!t.host || (!b.passphrase && !cur.passphraseEnc))) throw new HttpError(400, 'backup_incomplete');
    let publicKey = cur.target.publicKey;
    if (t.privateKey) {
      try {
        const { default: ssh2 } = await import('ssh2');
        const parsed = ssh2.utils.parseKey(t.privateKey);
        if (parsed instanceof Error) throw parsed;
        const k = Array.isArray(parsed) ? parsed[0] : parsed;
        if (k.isPrivateKey?.() === false) throw new Error('not a private key');
        publicKey = `${k.type} ${k.getPublicSSH().toString('base64')} restream-backup`;
      } catch { throw new HttpError(400, 'invalid_private_key'); }
    }
    const endpointChanged = t.protocol !== cur.target.protocol || t.host !== cur.target.host || (t.port || defaultPort(t.protocol)) !== (cur.target.port || defaultPort(cur.target.protocol));
    const next: BackupSettings = {
      scheduleEnabled: b.scheduleEnabled, time: b.time, full: b.full, fullWeekday: b.fullWeekday, incremental: b.incremental, keepChains: b.keepChains,
      passphraseEnc: b.passphrase ? encrypt(b.passphrase) : cur.passphraseEnc,
      target: {
        protocol: t.protocol, host: t.host, port: t.port || defaultPort(t.protocol), username: t.username,
        passwordEnc: t.password === undefined ? cur.target.passwordEnc : t.password ? encrypt(t.password) : '',
        privateKeyEnc: t.privateKey === undefined ? cur.target.privateKeyEnc : t.privateKey ? encrypt(t.privateKey) : '',
        publicKey: t.privateKey === '' ? '' : publicKey,
        // A different server means a different host key: pin it again at the next connection.
        hostKeySha256: endpointChanged ? '' : cur.target.hostKeySha256,
        verifyCertificate: t.verifyCertificate, path: t.path,
      },
    };
    await setSettings(sql, { backup: next });
    // A new passphrase or location starts a new chain, so a restore never needs two passphrases.
    if (b.passphrase || endpointChanged || t.path !== cur.target.path) {
      await rm(path.join(config.dataDir, 'backups', 'state', 'last.json'), { force: true });
    }
    await audit(sql, req, 'backup.settings_updated', { protocol: t.protocol, host: t.host, schedule: b.scheduleEnabled, passphraseChanged: !!b.passphrase });
    return { ok: true, settings: view(next) };
  });

  app.post('/api/backups/ssh-key', admin, async (req) => {
    const cur = (await getSettings(sql)).backup;
    const k = generateSshKey(`restream-backup@${new URL((await getSettings(sql)).publicUrl || 'http://restream').hostname}`);
    await setSettings(sql, { backup: { ...cur, target: { ...cur.target, privateKeyEnc: encrypt(k.privateKey), publicKey: k.publicKey } } });
    await audit(sql, req, 'backup.ssh_key_generated');
    return { publicKey: k.publicKey };
  });

  app.post('/api/backups/forget-host-key', admin, async (req) => {
    const cur = (await getSettings(sql)).backup;
    await setSettings(sql, { backup: { ...cur, target: { ...cur.target, hostKeySha256: '' } } });
    await audit(sql, req, 'backup.host_key_reset');
    return { ok: true };
  });

  app.post('/api/backups/test', { ...admin, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async () => {
    const s = await getSettings(sql);
    const r = await backups.test(s).catch(fail);
    return { ok: true, hostKey: r.hostKey };
  });

  app.get('/api/backups', admin, async () => {
    const list = await backups.list().catch(fail);
    return list.map((m) => ({
      id: m.id, type: m.type, chain: m.chain, parent: m.parent, level: m.level, createdAt: m.createdAt,
      size: m.bundle.size, version: m.app.version, hostname: m.hostname, fileDirs: m.contents.fileDirs, env: m.contents.env,
    }));
  });

  app.get('/api/backups/jobs', admin, async () => ({ busy: backups.busy, jobs: await backups.jobs() }));

  app.post('/api/backups/run', admin, async (req) => {
    const { type } = z.object({ type: z.enum(['full', 'incremental']) }).parse(req.body);
    const { jobId } = await backups.startBackup(type, 'manual', req.user!.id).catch(fail);
    await audit(sql, req, 'backup.started', { type, job: jobId });
    return { jobId };
  });

  app.post('/api/backups/restore', admin, async (req) => {
    const { id } = z.object({ id: chainId, confirm: z.literal('RESTORE') }).parse(req.body);
    await audit(sql, req, 'backup.restore_started', { id });
    const { jobId } = await backups.startRestore(id, 'manual', req.user!.id).catch(fail);
    return { jobId };
  });

  app.delete('/api/backups/chains/:chain', admin, async (req) => {
    const { chain } = z.object({ chain: chainId }).parse(req.params);
    const removed = await backups.deleteChain(chain).catch(fail);
    await audit(sql, req, 'backup.deleted', { chain, removed });
    return { removed };
  });
}
