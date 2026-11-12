import { existsSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Sql } from '../db.js';
import { config, readBuildInfo } from '../config.js';
import { migrate, migrationFiles } from '../migrate.js';
import { decrypt, encrypt, key, parseKey } from '../lib/crypto.js';
import { getSettings, setSettings, type BackupSettings, type Settings } from '../lib/settings.js';
import { audit } from '../lib/audit.js';
import { formatBytes, type Notifier } from '../lib/notify.js';
import { ArchiveError, decryptFile, encryptFile, run, sha256File } from './archive.js';
import { openRemote, RemoteError, type Remote } from './remote.js';
import { bus } from '../lib/events.js';

export type BackupType = 'full' | 'incremental';
export type Trigger = 'manual' | 'schedule' | 'cli';

export interface Manifest {
  format: 1;
  id: string;
  type: BackupType;
  /** Id of the full backup this one builds on (itself for a full backup). */
  chain: string;
  parent: string | null;
  level: number;
  createdAt: string;
  app: { version: string; commit: string; branch: string };
  hostname: string;
  migrations: string[];
  bundle: { name: string; size: number; sha256: string };
  contents: { database: boolean; env: boolean; fileDirs: string[] };
  encryption: { cipher: 'aes-256-gcm'; kdf: 'scrypt' };
}

export class BackupError extends Error {
  constructor(public code: string, message?: string) { super(message ?? code); }
}

const LOCK_ID = 727_101; // pg advisory lock shared by the app and restream-cli
const manifestName = (id: string) => `restream-${id}.json`;
const bundleName = (id: string) => `restream-${id}.rsbk`;
const isManifest = (n: string) => /^restream-\d{8}-\d{6}-(full|incr)\.json$/.test(n);

function stamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** Connection settings for the PostgreSQL command line tools, passed via the environment (never argv). */
function pgEnv(): NodeJS.ProcessEnv {
  const u = new URL(config.databaseUrl);
  return {
    PGHOST: u.hostname || '127.0.0.1', PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')), PGCONNECT_TIMEOUT: '10',
  };
}

/** Latest slot of a schedule at or before `now` (server local time). */
export function lastSlot(now: Date, time: string, every: 'hourly' | 'every6h' | 'daily' | 'weekly' | 'monthly', weekday = 0): Date {
  const [h, m] = time.split(':').map(Number);
  const d = new Date(now);
  d.setSeconds(0, 0);
  if (every === 'hourly') {
    d.setMinutes(m);
    if (d > now) d.setHours(d.getHours() - 1);
    return d;
  }
  if (every === 'every6h') {
    d.setMinutes(m);
    const hours = [0, 1, 2, 3].map((i) => (h + i * 6) % 24).sort((a, b) => a - b);
    const cur = now.getHours();
    let pick = [...hours].reverse().find((x) => x < cur || (x === cur && m <= now.getMinutes()));
    if (pick === undefined) { pick = hours[hours.length - 1]; d.setDate(d.getDate() - 1); }
    d.setHours(pick);
    return d;
  }
  d.setHours(h, m);
  if (every === 'daily') {
    if (d > now) d.setDate(d.getDate() - 1);
    return d;
  }
  if (every === 'weekly') {
    let diff = (d.getDay() - weekday + 7) % 7;
    if (diff === 0 && d > now) diff = 7;
    d.setDate(d.getDate() - diff);
    return d;
  }
  d.setDate(1);
  if (d > now) d.setMonth(d.getMonth() - 1);
  return d;
}

export interface JobRow {
  id: string; kind: 'backup' | 'restore'; type: BackupType | null; trigger: Trigger; status: 'running' | 'success' | 'failed';
  backup_id: string | null; step: string | null; size_bytes: string | null; error: string | null; log: string;
  user_id: string | null; started_at: Date; finished_at: Date | null;
}

/**
 * Full and incremental backups of the database, configuration and user files to FTP, FTPS or SCP,
 * always encrypted, plus restore from the remote location (also onto a freshly installed server).
 */
export class BackupService {
  private timer: NodeJS.Timeout | null = null;
  private running: string | null = null;
  private dir = path.join(config.dataDir, 'backups');

  constructor(private sql: Sql, private log: FastifyBaseLogger, private notifier: Notifier | null = null, private onRestored: () => void = () => {}) {}

  get busy() { return this.running !== null; }

  async start() {
    await this.markInterrupted();
    if (this.timer) return;
    this.timer = setInterval(() => { void this.scheduleTick(); }, 60_000);
    this.timer.unref();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Jobs left "running" by a crash or restart are marked failed, unless another process holds the lock. */
  private async markInterrupted() {
    await this.withLock(async () => {
      await this.sql`UPDATE backup_jobs SET status = 'failed', error = 'interrupted', finished_at = now() WHERE status = 'running'`;
    }).catch(() => {});
  }

  /** Runs `fn` while holding the cluster wide backup lock; throws backup_busy when it is taken. */
  private async withLock<R>(fn: () => Promise<R>): Promise<R> {
    const conn = await this.sql.reserve();
    try {
      const [{ ok }] = await conn<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(${LOCK_ID}) AS ok`;
      if (!ok) throw new BackupError('backup_busy');
      try { return await fn(); } finally { await conn`SELECT pg_advisory_unlock(${LOCK_ID})`.catch(() => {}); }
    } finally {
      conn.release();
    }
  }

  // --- Configuration helpers -------------------------------------------------------------------

  static configured(b: BackupSettings) {
    return !!b.target.host && !!b.passphraseEnc && (b.target.protocol !== 'scp' || !!b.target.username);
  }

  /** Opens the remote and pins the SSH host key on first use. */
  async connect(s?: Settings): Promise<Remote> {
    const settings = s ?? await getSettings(this.sql);
    const t = settings.backup.target;
    const remote = await openRemote(t);
    if (t.protocol === 'scp' && !t.hostKeySha256 && remote.hostKey) {
      const fresh = await getSettings(this.sql);
      await setSettings(this.sql, { backup: { ...fresh.backup, target: { ...fresh.backup.target, hostKeySha256: remote.hostKey } } });
    }
    return remote;
  }

  /** Connects, writes, lists and removes a probe file. */
  async test(s: Settings) {
    const remote = await this.connect(s);
    const probe = path.join(os.tmpdir(), `restream-probe-${process.pid}-${Date.now()}`);
    try {
      await writeFile(probe, `Restream backup probe ${new Date().toISOString()}\n`);
      const name = `.restream-probe-${Date.now()}`;
      await remote.put(probe, name);
      const listed = (await remote.list()).some((f) => f.name === name);
      await remote.remove(name);
      if (!listed) throw new RemoteError('backup_remote_failed', 'the test file did not show up in the directory listing');
      return { hostKey: remote.hostKey ?? null };
    } finally {
      await rm(probe, { force: true });
      await remote.close();
    }
  }

  /** Backups on the remote, newest first, grouped information included. */
  async list(): Promise<Manifest[]> {
    const remote = await this.connect();
    try { return await this.readManifests(remote); } finally { await remote.close(); }
  }

  private async readManifests(remote: Remote): Promise<Manifest[]> {
    const files = await remote.list();
    const names = new Set(files.map((f) => f.name));
    const tmp = path.join(this.dir, 'tmp');
    await mkdir(tmp, { recursive: true, mode: 0o700 });
    const out: Manifest[] = [];
    for (const f of files.filter((x) => isManifest(x.name))) {
      const local = path.join(tmp, `${f.name}.${process.pid}`);
      try {
        await remote.get(f.name, local);
        const m = JSON.parse(await readFile(local, 'utf8')) as Manifest;
        // The manifest comes from the remote: only accept names Restream itself would write.
        const valid = m.format === 1 && `restream-${m.id}.json` === f.name && m.bundle?.name === bundleName(m.id)
          && (m.parent === null || /^\d{8}-\d{6}-(full|incr)$/.test(m.parent)) && /^\d{8}-\d{6}-full$/.test(m.chain);
        if (valid && names.has(m.bundle.name)) out.push(m);
      } catch (err) {
        this.log.warn({ err, file: f.name }, 'skipping unreadable backup manifest');
      } finally {
        await rm(local, { force: true });
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async jobs(limit = 30) {
    return this.sql<JobRow[]>`
      SELECT j.*, u.email AS user_email FROM backup_jobs j LEFT JOIN users u ON u.id = j.user_id
      ORDER BY started_at DESC LIMIT ${limit}`;
  }

  // --- Job bookkeeping ---------------------------------------------------------------------

  private async newJob(kind: 'backup' | 'restore', trigger: Trigger, userId: string | null, type: BackupType | null) {
    const [row] = await this.sql<{ id: string }[]>`
      INSERT INTO backup_jobs (kind, trigger, user_id, type) VALUES (${kind}, ${trigger}, ${userId}, ${type}) RETURNING id`;
    return row.id;
  }

  private async step(job: string, step: string, line?: string) {
    const msg = `[${new Date().toISOString().slice(11, 19)}] ${line ?? step}\n`;
    await this.sql`UPDATE backup_jobs SET step = ${step}, log = right(log || ${msg}, 20000) WHERE id = ${job}`.catch(() => {});
  }

  // --- Backup ------------------------------------------------------------------------------

  /** Starts a backup in the background; resolves with the job id once it is registered. */
  async startBackup(requested: BackupType | 'auto', trigger: Trigger, userId: string | null = null) {
    if (this.running) throw new BackupError('backup_busy');
    const s = await getSettings(this.sql);
    if (!BackupService.configured(s.backup)) throw new BackupError('backup_not_configured');
    let resolveId!: (id: string) => void;
    let rejectId!: (e: unknown) => void;
    const idP = new Promise<string>((res, rej) => { resolveId = res; rejectId = rej; });
    const done = this.withLock(async () => {
      const job = await this.newJob('backup', trigger, userId, requested === 'auto' ? null : requested);
      this.running = job;
      resolveId(job);
      try { await this.backup(job, requested, s); } finally { this.running = null; }
    }).catch((err) => { rejectId(err); });
    const id = await idP;
    return { jobId: id, done };
  }

  private async backup(job: string, requested: BackupType | 'auto', s: Settings) {
    const started = Date.now();
    const work = path.join(this.dir, 'work', job);
    const stateDir = path.join(this.dir, 'state');
    let id = '';
    let type: BackupType = 'full';
    let remote: Remote | null = null;
    try {
      await mkdir(work, { recursive: true, mode: 0o700 });
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      const passphrase = decrypt(s.backup.passphraseEnc);

      await this.step(job, 'connect', `Connecting to ${s.backup.target.protocol}://${s.backup.target.host}`);
      remote = await this.connect(s);
      const existing = await this.readManifests(remote);

      // Incremental needs the local tar snapshot of the chain and the chain's backups on the remote.
      const last = await readFile(path.join(stateDir, 'last.json'), 'utf8').then((t) => JSON.parse(t) as { chain: string; id: string; level: number }).catch(() => null);
      const chainOk = !!last && existing.some((m) => m.id === last.chain) && existing.some((m) => m.id === last.id)
        && existsSync(path.join(stateDir, `${last.chain}.snar`));
      type = requested === 'full' ? 'full' : chainOk ? 'incremental' : 'full';
      if (requested === 'incremental' && !chainOk) await this.step(job, 'plan', 'No complete backup chain found; making a full backup instead.');
      id = `${stamp()}-${type === 'full' ? 'full' : 'incr'}`;
      const chain = type === 'full' ? id : last!.chain;
      const level = type === 'full' ? 0 : last!.level + 1;
      await this.sql`UPDATE backup_jobs SET backup_id = ${id}, type = ${type} WHERE id = ${job}`;

      await this.step(job, 'database', 'Dumping the database');
      await run(config.pgDumpPath, [
        '--format=custom', '--no-owner', '--no-privileges', '--file', path.join(work, 'database.dump'),
        '--exclude-table-data=sessions', '--exclude-table-data=backup_jobs', '--exclude-table-data=mail_log',
      ], { env: pgEnv() });

      let env = false;
      try { await copyFile(config.envFile, path.join(work, 'restream.env')); env = true; } catch { /* not readable here */ }

      const fileDirs = config.backupFileDirs.filter((d) => /^[\w.-]+$/.test(d) && existsSync(path.join(config.dataDir, d)));
      const snarTmp = path.join(stateDir, `${chain}.snar.${job}`);
      if (fileDirs.length) {
        await this.step(job, 'files', `Archiving ${fileDirs.join(', ')} (${type})`);
        if (type === 'incremental') await copyFile(path.join(stateDir, `${chain}.snar`), snarTmp);
        await run(config.tarPath, ['--create', '--file', path.join(work, 'files.tar'), `--listed-incremental=${snarTmp}`, '-C', config.dataDir, ...fileDirs]);
      }

      const b = readBuildInfo();
      const manifest: Manifest = {
        format: 1, id, type, chain, parent: type === 'full' ? null : last!.id, level,
        createdAt: new Date().toISOString(),
        app: { version: b.version, commit: b.commit, branch: b.branch },
        hostname: os.hostname(),
        migrations: (await this.sql<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`).map((r) => r.name),
        bundle: { name: bundleName(id), size: 0, sha256: '' },
        contents: { database: true, env, fileDirs },
        encryption: { cipher: 'aes-256-gcm', kdf: 'scrypt' },
      };
      await writeFile(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));

      await this.step(job, 'encrypt', 'Compressing and encrypting');
      const plain = path.join(this.dir, 'work', `${job}.tgz`);
      await run(config.tarPath, ['--create', '--gzip', '--file', plain, '-C', work, '.']);
      const enc = path.join(this.dir, 'work', `${job}.rsbk`);
      const { size, sha256 } = await encryptFile(plain, enc, passphrase);
      await rm(plain, { force: true });
      manifest.bundle = { name: bundleName(id), size, sha256 };
      const manifestFile = path.join(this.dir, 'work', `${job}.json`);
      await writeFile(manifestFile, JSON.stringify(manifest, null, 2));

      await this.step(job, 'upload', `Uploading ${formatBytes(size)}`);
      await remote.put(enc, bundleName(id));
      await remote.put(manifestFile, manifestName(id)); // written last: a backup exists once its manifest does

      if (fileDirs.length) await rename(snarTmp, path.join(stateDir, `${chain}.snar`));
      else if (type === 'full') await writeFile(path.join(stateDir, `${chain}.snar`), '');
      await writeFile(path.join(stateDir, 'last.json'), JSON.stringify({ chain, id, level }));

      await this.step(job, 'retention', 'Applying retention');
      await this.retention(remote, [...existing, manifest], s.backup.keepChains, job);

      await this.sql`UPDATE backup_jobs SET status = 'success', step = 'done', size_bytes = ${size}, finished_at = now() WHERE id = ${job}`;
      await this.step(job, 'done', `Backup ${id} completed in ${Math.round((Date.now() - started) / 1000)} s`);
      await audit(this.sql, null, 'backup.completed', { id, type, size });
      bus.publish('backup.finished', { backup: { id, type, status: 'success', sizeBytes: size, durationSeconds: Math.round((Date.now() - started) / 1000) } });
      void this.notifier?.send('backupSucceeded', (t) => ({
        title: t.backupOk(id)[0], intro: t.backupOk(id)[1], tone: 'ok',
        rows: [[t.backup, id], [t.type, t[type]], [t.size, formatBytes(size)], [t.duration, `${Math.round((Date.now() - started) / 1000)} s`], [t.target, `${s.backup.target.protocol}://${s.backup.target.host}`]],
      }));
    } catch (err) {
      const e = err as { code?: string; message?: string };
      const msg = `${e.code && e.code !== e.message ? `${e.code}: ` : ''}${e.message ?? String(err)}`.slice(0, 1000);
      this.log.error({ err, job }, 'backup failed');
      await this.step(job, 'failed', `FAILED: ${msg}`);
      await this.sql`UPDATE backup_jobs SET status = 'failed', error = ${msg}, finished_at = now() WHERE id = ${job}`;
      bus.publish('backup.finished', { backup: { id: id || null, type, status: 'failed', error: msg.slice(0, 300) } });
      void this.notifier?.send('backupFailed', (t) => ({
        title: t.backupFail(id || '…')[0], intro: t.backupFail(id || '…')[1], tone: 'danger',
        rows: [[t.type, t[type]], [t.target, `${s.backup.target.protocol}://${s.backup.target.host}`], [t.error, msg.slice(0, 200)]],
      }));
    } finally {
      await remote?.close().catch(() => {});
      await rm(work, { recursive: true, force: true });
      for (const f of await readdir(path.join(this.dir, 'work')).catch(() => [] as string[])) {
        if (f.startsWith(job)) await rm(path.join(this.dir, 'work', f), { force: true });
      }
      for (const f of await readdir(path.join(this.dir, 'state')).catch(() => [] as string[])) {
        if (f.endsWith(`.${job}`)) await rm(path.join(this.dir, 'state', f), { force: true });
      }
    }
  }

  /** Keeps the newest `keep` chains on the remote and removes the rest (and their local snapshots). */
  private async retention(remote: Remote, all: Manifest[], keep: number, job: string) {
    const chains = [...new Set(all.filter((m) => m.type === 'full').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((m) => m.id))];
    const drop = new Set(chains.slice(Math.max(1, keep)));
    for (const m of all) {
      if (!drop.has(m.chain)) continue;
      await remote.remove(manifestName(m.id)).catch(() => {});
      await remote.remove(m.bundle.name).catch(() => {});
      await this.step(job, 'retention', `Removed old backup ${m.id}`);
    }
    for (const c of drop) await rm(path.join(this.dir, 'state', `${c}.snar`), { force: true });
  }

  /** Deletes one backup chain on the remote (a full backup and every incremental built on it). */
  async deleteChain(chain: string) {
    if (this.running) throw new BackupError('backup_busy');
    const remote = await this.connect();
    try {
      const all = await this.readManifests(remote);
      const items = all.filter((m) => m.chain === chain);
      if (!items.length) throw new BackupError('not_found');
      for (const m of items) {
        await remote.remove(manifestName(m.id)).catch(() => {});
        await remote.remove(m.bundle.name).catch(() => {});
      }
      await rm(path.join(this.dir, 'state', `${chain}.snar`), { force: true });
      return items.map((m) => m.id);
    } finally { await remote.close(); }
  }

  // --- Restore -----------------------------------------------------------------------------

  async startRestore(id: string, trigger: Trigger, userId: string | null) {
    if (this.running) throw new BackupError('backup_busy');
    const s = await getSettings(this.sql);
    if (!BackupService.configured(s.backup)) throw new BackupError('backup_not_configured');
    let resolveId!: (id: string) => void;
    let rejectId!: (e: unknown) => void;
    const idP = new Promise<string>((res, rej) => { resolveId = res; rejectId = rej; });
    const done = this.withLock(async () => {
      const job = await this.newJob('restore', trigger, userId, null);
      await this.sql`UPDATE backup_jobs SET backup_id = ${id} WHERE id = ${job}`;
      this.running = job;
      resolveId(job);
      try { await this.restore(job, id, s, userId, trigger); } finally { this.running = null; }
    }).catch((err) => { rejectId(err); });
    const jobId = await idP;
    return { jobId, done };
  }

  private async restore(job: string, id: string, s: Settings, userId: string | null, trigger: Trigger) {
    const work = path.join(this.dir, 'work', `restore-${job}`);
    let remote: Remote | null = null;
    // The job row lives in a table the restore recreates; keep a copy to put back.
    let jobLog = '';
    const keepLog = async (step: string, line: string) => { jobLog += `[${new Date().toISOString().slice(11, 19)}] ${line}\n`; await this.step(job, step, line); };
    try {
      await mkdir(work, { recursive: true, mode: 0o700 });
      const passphrase = decrypt(s.backup.passphraseEnc);
      await keepLog('connect', `Connecting to ${s.backup.target.protocol}://${s.backup.target.host}`);
      remote = await this.connect(s);
      const all = await this.readManifests(remote);
      const target = all.find((m) => m.id === id);
      if (!target) throw new BackupError('not_found', `backup ${id} not found on the remote`);

      // Chain: full backup first, then each incremental up to the chosen one.
      const chain: Manifest[] = [target];
      while (chain[0].parent) {
        const parent = all.find((m) => m.id === chain[0].parent);
        if (!parent) throw new BackupError('backup_chain_incomplete', `backup ${chain[0].parent} is missing on the remote`);
        chain.unshift(parent);
      }
      const known = new Set(migrationFiles());
      const unknown = target.migrations.filter((m) => !known.has(m));
      if (unknown.length) throw new BackupError('backup_newer_version', `made with a newer Restream (${target.app.version}); update this server first`);
      await this.sql`UPDATE backup_jobs SET type = ${target.type} WHERE id = ${job}`;

      const dirs: string[] = [];
      for (const m of chain) {
        await keepLog('download', `Downloading ${m.id} (${formatBytes(m.bundle.size)})`);
        const enc = path.join(work, m.bundle.name);
        await remote.get(m.bundle.name, enc);
        if ((await sha256File(enc)) !== m.bundle.sha256) throw new BackupError('backup_corrupt', `checksum mismatch for ${m.id}`);
        const plain = path.join(work, `${m.id}.tgz`);
        await decryptFile(enc, plain, passphrase);
        await rm(enc, { force: true });
        const dir = path.join(work, m.id);
        await mkdir(dir, { recursive: true });
        await run(config.tarPath, ['--extract', '--gzip', '--no-same-owner', '--file', plain, '-C', dir]);
        await rm(plain, { force: true });
        dirs.push(dir);
      }
      await remote.close();
      remote = null;
      const last = dirs[dirs.length - 1];

      await keepLog('safety', 'Saving a copy of the current database');
      const pre = path.join(this.dir, 'pre-restore');
      await mkdir(pre, { recursive: true, mode: 0o700 });
      await run(config.pgDumpPath, ['--format=custom', '--no-owner', '--no-privileges', '--file', path.join(pre, `${stamp()}.dump`)], { env: pgEnv() });
      const old = readdirSync(pre).filter((f) => f.endsWith('.dump')).sort();
      for (const f of old.slice(0, Math.max(0, old.length - 3))) await rm(path.join(pre, f), { force: true });

      // The backup location stays as configured here, otherwise the restore would point at an old target.
      const keepBackupSettings = s.backup;

      await keepLog('database', `Restoring the database from ${target.id}`);
      await this.restoreDatabase(path.join(last, 'database.dump'), work);

      // Secrets in the backup are encrypted with the APP_KEY of the server that made it.
      let oldKey: Buffer | null = null;
      try {
        const env = await readFile(path.join(last, 'restream.env'), 'utf8');
        const raw = env.match(/^APP_KEY=(.+)$/m)?.[1]?.trim();
        if (raw) oldKey = parseKey(raw);
      } catch { /* no env in the backup */ }
      if (oldKey && !oldKey.equals(key())) {
        await keepLog('rekey', 'Re-encrypting secrets for this server');
        await this.rekey(oldKey);
      }

      await setSettings(this.sql, { backup: keepBackupSettings });
      await this.sql`DELETE FROM sessions`;
      // The user who started the restore may not exist in the restored data.
      const stillThere = userId ? (await this.sql`SELECT 1 FROM users WHERE id = ${userId}`).length > 0 : false;
      await this.sql`
        INSERT INTO backup_jobs (id, kind, type, trigger, status, backup_id, step, log, user_id)
        VALUES (${job}, 'restore', ${target.type}, ${trigger}, 'running', ${id}, 'migrate', ${jobLog}, ${stillThere ? userId : null})
        ON CONFLICT (id) DO NOTHING`;
      await this.step(job, 'migrate', 'Updating the database schema');
      await migrate(this.sql);

      const withFiles = chain.map((m, i) => ({ m, dir: dirs[i] })).filter((x) => x.m.contents.fileDirs.length);
      if (withFiles.length) {
        await this.step(job, 'files', `Restoring files (${withFiles.length} archive${withFiles.length > 1 ? 's' : ''})`);
        for (const { m, dir } of withFiles) {
          await run(config.tarPath, ['--extract', '--listed-incremental=/dev/null', '--no-same-owner', '--file', path.join(dir, 'files.tar'), '-C', config.dataDir]);
          await this.step(job, 'files', `Applied ${m.id}`);
        }
      }
      // The local snapshot no longer matches the restored files: the next backup is a full one.
      await rm(path.join(this.dir, 'state'), { recursive: true, force: true });

      await this.sql`UPDATE backup_jobs SET status = 'success', step = 'done', finished_at = now() WHERE id = ${job}`;
      await this.step(job, 'done', `Restored ${id}. Everyone has to sign in again.`);
      await audit(this.sql, null, 'backup.restored', { id, from: target.hostname, version: target.app.version });
      this.onRestored();
    } catch (err) {
      const e = err as { code?: string; message?: string };
      const msg = `${e.code && e.code !== e.message ? `${e.code}: ` : ''}${e.message ?? String(err)}`.slice(0, 1000);
      this.log.error({ err, job }, 'restore failed');
      // The row may be missing when the database part failed halfway; put it back.
      await this.sql`
        INSERT INTO backup_jobs (id, kind, trigger, status, backup_id, log) VALUES (${job}, 'restore', ${trigger}, 'running', ${id}, ${jobLog})
        ON CONFLICT (id) DO NOTHING`.catch(() => {});
      await this.step(job, 'failed', `FAILED: ${msg}`);
      await this.sql`UPDATE backup_jobs SET status = 'failed', error = ${msg}, finished_at = now() WHERE id = ${job}`.catch(() => {});
    } finally {
      await remote?.close().catch(() => {});
      await rm(work, { recursive: true, force: true });
    }
  }

  /** Replaces all application tables with the dump, in one transaction (psql --single-transaction). */
  private async restoreDatabase(dump: string, work: string) {
    const env = pgEnv();
    const list = await run(config.pgRestorePath, ['--list', dump], { env });
    // Extensions are created by the installer as superuser; the application role cannot drop or comment on them.
    const filtered = list.split('\n').filter((l) => !/\bEXTENSION\b/.test(l)).join('\n');
    await writeFile(path.join(work, 'restore.list'), filtered);
    const script = path.join(work, 'restore.sql');
    await run(config.pgRestorePath, ['--no-owner', '--no-privileges', '--use-list', path.join(work, 'restore.list'), '--file', script, dump], { env });

    const tables = await this.sql<{ t: string }[]>`
      SELECT quote_ident(tablename) AS t FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user`;
    const wrapper = path.join(work, 'wrapper.sql');
    await writeFile(wrapper, [
      'SET lock_timeout = \'30s\';',
      tables.length ? `DROP TABLE IF EXISTS ${tables.map((r) => `public.${r.t}`).join(', ')} CASCADE;` : '',
      `\\i ${script}`,
      '',
    ].join('\n'));
    await run(config.psqlPath, ['--no-psqlrc', '--quiet', '--single-transaction', '-v', 'ON_ERROR_STOP=1', '--file', wrapper], { env });
  }

  /** Decrypts every *_enc column and every *Enc setting with the old key and encrypts it with this server's key. */
  private async rekey(oldKey: Buffer) {
    const re = (v: string) => encrypt(decrypt(v, oldKey));
    await this.sql.begin(async (tx) => {
      const cols = await tx<{ table_name: string; column_name: string }[]>`
        SELECT c.table_name, c.column_name FROM information_schema.columns c
        JOIN information_schema.columns k ON k.table_schema = c.table_schema AND k.table_name = c.table_name AND k.column_name = 'id'
        WHERE c.table_schema = 'public' AND c.column_name LIKE '%\\_enc' AND c.data_type = 'text'`;
      for (const { table_name: t, column_name: c } of cols) {
        const rows = await tx.unsafe<{ id: string; v: string }[]>(`SELECT id::text AS id, "${c}" AS v FROM public."${t}" WHERE "${c}" IS NOT NULL AND "${c}" <> ''`);
        for (const r of rows) await tx.unsafe(`UPDATE public."${t}" SET "${c}" = $1 WHERE id::text = $2`, [re(r.v), r.id]);
      }
      const settings = await tx<{ key: string; value: unknown }[]>`SELECT key, value FROM settings`;
      const walk = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(walk);
        if (!v || typeof v !== 'object') return v;
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k.endsWith('Enc') && typeof x === 'string' && x ? re(x) : walk(x)]));
      };
      for (const r of settings) {
        await tx`UPDATE settings SET value = ${tx.json(walk(r.value) as never)} WHERE key = ${r.key}`;
      }
    });
  }

  // --- Schedule ----------------------------------------------------------------------------

  /** Decides whether a scheduled backup is due now, and which type. */
  async due(now = new Date()): Promise<BackupType | null> {
    const s = await getSettings(this.sql);
    const b = s.backup;
    if (!b.scheduleEnabled || !BackupService.configured(b)) return null;
    const [r] = await this.sql<{ last_sched: Date | null; last_full: Date | null; last_any: Date | null }[]>`
      SELECT max(started_at) FILTER (WHERE trigger = 'schedule') AS last_sched,
             max(started_at) FILTER (WHERE status = 'success' AND type = 'full') AS last_full,
             max(started_at) FILTER (WHERE status = 'success') AS last_any
      FROM backup_jobs WHERE kind = 'backup'`;
    const fullSlot = lastSlot(now, b.time, b.full, b.fullWeekday);
    const before = (d: Date | null, slot: Date) => !d || d < slot;
    if (before(r.last_full, fullSlot) && before(r.last_sched, fullSlot)) return 'full';
    if (b.incremental !== 'off') {
      const incSlot = lastSlot(now, b.time, b.incremental);
      if (before(r.last_any, incSlot) && before(r.last_sched, incSlot)) return 'incremental';
    }
    return null;
  }

  private async scheduleTick() {
    if (this.running) return;
    try {
      const type = await this.due();
      if (type) await this.startBackup(type, 'schedule');
    } catch (err) {
      if ((err as BackupError).code !== 'backup_busy') this.log.warn({ err }, 'scheduled backup could not start');
    }
  }

  /** Remaining usable directories for the UI. */
  async localInfo() {
    const pre = path.join(this.dir, 'pre-restore');
    const files = existsSync(pre) ? readdirSync(pre).filter((f) => f.endsWith('.dump')).sort().reverse() : [];
    const safety = await Promise.all(files.map(async (f) => ({ name: f, size: (await stat(path.join(pre, f))).size })));
    return { safetyDumps: safety, fileDirs: config.backupFileDirs };
  }
}
