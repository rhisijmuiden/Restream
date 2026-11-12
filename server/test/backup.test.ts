import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generate } from 'otplib';
import { Client, addUser, loginWithEnrolment, setup } from './helpers.js';
import { startFtp, startSftp, tempDir } from './servers.js';
import { config } from '../src/config.js';
import { decrypt, encrypt } from '../src/lib/crypto.js';
import { lastSlot } from '../src/backup/service.js';
import { decryptFile, encryptFile } from '../src/backup/archive.js';

let ctx: Awaited<ReturnType<typeof setup>>;
let admin: Client;
let totp = '';
const data = config.dataDir;
const rec = path.join(data, 'recordings');
const sftpRoot = tempDir('sftp');
const ftpRoot = tempDir('ftp');
let sftp: Awaited<ReturnType<typeof startSftp>> | null = null;
let ftp: Awaited<ReturnType<typeof startFtp>> | null = null;
const PASS = 'a long backup passphrase';

const schedule = { scheduleEnabled: false, time: '03:30', full: 'weekly', fullWeekday: 0, incremental: 'daily', keepChains: 4 };

async function login() {
  // The restored user row carries the TOTP replay marker of the backup; clear it so the current code works.
  await ctx.sql`UPDATE users SET totp_last_step = NULL`;
  admin = new Client(ctx.app);
  await admin.post('/api/auth/login', { email: 'admin@example.com', password: 'correct horse battery' });
  const r = await admin.post('/api/auth/mfa', { code: await generate({ secret: totp }) });
  if (r.statusCode !== 200) throw new Error(r.body);
}

async function waitJob(jobId: string) {
  for (let i = 0; i < 300; i++) {
    const r = await admin.get('/api/backups/jobs');
    if (r.statusCode === 401) return { status: 'signed_out' } as const;
    const job = (r.json().jobs as { id: string; status: string }[]).find((j) => j.id === jobId);
    if (job && job.status !== 'running') return job as { id: string; status: string; error: string | null; backup_id: string; type: string; log: string };
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('job did not finish');
}

async function run(type: 'full' | 'incremental') {
  const r = await admin.post('/api/backups/run', { type });
  expect(r.statusCode, r.body).toBe(200);
  const job = await waitJob(r.json().jobId);
  expect(job.status, 'error' in job ? `${job.error}\n${job.log}` : '').toBe('success');
  return job as { backup_id: string; type: string };
}

beforeAll(async () => {
  rmSync(data, { recursive: true, force: true });
  mkdirSync(rec, { recursive: true });
  writeFileSync(config.envFile, `NODE_ENV=test\nAPP_KEY=${config.appKey}\n`);
  ctx = await setup();
  await addUser(ctx.sql, 'admin@example.com', 'correct horse battery');
  admin = new Client(ctx.app);
  ({ secret: totp } = await loginWithEnrolment(admin, 'admin@example.com', 'correct horse battery'));
});
afterAll(async () => { await sftp?.close(); await ftp?.close(); await ctx.app.close(); await ctx.sql.end(); });

describe('backup encryption', () => {
  it('round-trips and rejects a wrong passphrase', async () => {
    const dir = tempDir('enc');
    writeFileSync(path.join(dir, 'a'), 'hello backup'.repeat(1000));
    const r = await encryptFile(path.join(dir, 'a'), path.join(dir, 'b'), 'pass phrase 1');
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(path.join(dir, 'b')).subarray(0, 4).toString()).toBe('RSBK');
    await decryptFile(path.join(dir, 'b'), path.join(dir, 'c'), 'pass phrase 1');
    expect(readFileSync(path.join(dir, 'c'), 'utf8')).toBe('hello backup'.repeat(1000));
    await expect(decryptFile(path.join(dir, 'b'), path.join(dir, 'd'), 'wrong')).rejects.toMatchObject({ code: 'backup_wrong_passphrase' });
  });
});

describe('schedule', () => {
  it('finds the last slot of each schedule', () => {
    const now = new Date(2026, 10, 12, 10, 15); // Thursday 12 Nov 2026 10:15 local
    expect(lastSlot(now, '03:30', 'daily')).toEqual(new Date(2026, 10, 12, 3, 30));
    expect(lastSlot(now, '11:00', 'daily')).toEqual(new Date(2026, 10, 11, 11, 0));
    expect(lastSlot(now, '03:30', 'hourly')).toEqual(new Date(2026, 10, 12, 9, 30));
    expect(lastSlot(now, '03:10', 'hourly')).toEqual(new Date(2026, 10, 12, 10, 10));
    expect(lastSlot(now, '03:30', 'every6h')).toEqual(new Date(2026, 10, 12, 9, 30));
    expect(lastSlot(new Date(2026, 10, 12, 2, 0), '03:30', 'every6h')).toEqual(new Date(2026, 10, 11, 21, 30));
    expect(lastSlot(now, '03:30', 'weekly', 0)).toEqual(new Date(2026, 10, 8, 3, 30));
    expect(lastSlot(now, '03:30', 'weekly', 4)).toEqual(new Date(2026, 10, 12, 3, 30));
    expect(lastSlot(now, '12:00', 'weekly', 4)).toEqual(new Date(2026, 10, 5, 12, 0));
    expect(lastSlot(now, '03:30', 'monthly')).toEqual(new Date(2026, 10, 1, 3, 30));
  });

  it('decides when a scheduled backup is due', async () => {
    const svc = ctx.app.backups;
    expect(await svc.due()).toBeNull(); // not configured
  });
});

describe('scp backups', () => {
  let full = '';
  let incr = '';
  let streamId = '';

  it('generates a key and pins the host key at the first test', async () => {
    const { publicKey } = (await admin.post('/api/backups/ssh-key')).json();
    expect(publicKey).toMatch(/^ssh-ed25519 \S+ restream-backup@/);
    sftp = await startSftp(sftpRoot, { user: 'backup', publicKey });
    const put = await admin.req('PUT', '/api/backups/settings', {
      ...schedule, passphrase: PASS,
      target: { protocol: 'scp', host: '127.0.0.1', port: sftp.port, username: 'backup', verifyCertificate: true, path: 'nightly/restream' },
    });
    expect(put.statusCode, put.body).toBe(200);
    const t = await admin.post('/api/backups/test');
    expect(t.statusCode, t.body).toBe(200);
    expect(t.json().hostKey).toMatch(/^SHA256:/);
    const s = (await admin.get('/api/backups/settings')).json().settings;
    expect(s.target.hostKeySha256).toBe(t.json().hostKey);
    expect(s.passphraseSet).toBe(true);
    expect(JSON.stringify(s)).not.toContain(PASS);
    expect(existsSync(path.join(sftpRoot, 'nightly', 'restream'))).toBe(true);
  });

  it('makes a full backup', async () => {
    writeFileSync(path.join(rec, 'a.txt'), 'first');
    const [s] = await ctx.sql<{ id: string }[]>`
      INSERT INTO streams (name, ingest_key_hash, ingest_key_enc, playback_id) VALUES ('Main', 'hash1', ${encrypt('rsKEY1')}, 'pb1') RETURNING id`;
    streamId = s.id;
    const job = await run('full');
    expect(job.type).toBe('full');
    full = job.backup_id;
    const files = readdirSync(path.join(sftpRoot, 'nightly', 'restream'));
    expect(files).toContain(`restream-${full}.json`);
    expect(files).toContain(`restream-${full}.rsbk`);
    expect(files.some((f) => f.endsWith('.part'))).toBe(false);
    const m = JSON.parse(readFileSync(path.join(sftpRoot, 'nightly', 'restream', `restream-${full}.json`), 'utf8'));
    expect(m).toMatchObject({ type: 'full', chain: full, level: 0, contents: { database: true, env: true, fileDirs: ['recordings'] } });
    // The bundle is encrypted: nothing readable inside.
    expect(readFileSync(path.join(sftpRoot, 'nightly', 'restream', `restream-${full}.rsbk`)).includes('rsKEY1')).toBe(false);
  });

  it('makes an incremental backup on top of it', async () => {
    await new Promise((r) => setTimeout(r, 1100)); // ids have one second resolution
    rmSync(path.join(rec, 'a.txt'));
    writeFileSync(path.join(rec, 'b.txt'), 'second');
    await ctx.sql`UPDATE streams SET name = 'Main (renamed)' WHERE id = ${streamId}`;
    const job = await run('incremental');
    expect(job.type).toBe('incremental');
    incr = job.backup_id;
    const list = (await admin.get('/api/backups')).json();
    expect(list.map((b: { id: string }) => b.id)).toEqual([incr, full]);
    expect(list[0]).toMatchObject({ type: 'incremental', chain: full, parent: full, level: 1 });
  });

  it('restores the incremental backup (full + incremental) and signs everyone out', async () => {
    await ctx.sql`DELETE FROM streams`;
    writeFileSync(path.join(rec, 'c.txt'), 'made after the backup');
    expect((await admin.post('/api/backups/restore', { id: incr, confirm: 'yes' })).statusCode).toBe(400);
    const r = await admin.post('/api/backups/restore', { id: incr, confirm: 'RESTORE' });
    expect(r.statusCode, r.body).toBe(200);
    expect((await waitJob(r.json().jobId)).status).toBe('signed_out');
    for (let i = 0; i < 100 && ctx.app.backups.busy; i++) await new Promise((res) => setTimeout(res, 100));
    await login();
    const job = (await admin.get('/api/backups/jobs')).json().jobs.find((j: { id: string }) => j.id === r.json().jobId);
    expect(job.status, job.log).toBe('success');
    const [s] = await ctx.sql<{ name: string; ingest_key_enc: string }[]>`SELECT name, ingest_key_enc FROM streams`;
    expect(s.name).toBe('Main (renamed)');
    expect(decrypt(s.ingest_key_enc)).toBe('rsKEY1');
    expect(readdirSync(rec).sort()).toEqual(['b.txt']);
    // The backup location is kept, and the next backup starts a new chain.
    expect((await admin.get('/api/backups/settings')).json().settings.target.host).toBe('127.0.0.1');
    const next = await run('incremental');
    expect(next.type).toBe('full');
  });

  it('refuses a changed SSH host key', async () => {
    await sftp!.close();
    sftp = await startSftp(sftpRoot, { user: 'backup', publicKey: (await admin.get('/api/backups/settings')).json().settings.target.publicKey });
    const s = (await admin.get('/api/backups/settings')).json().settings;
    // Same host and port are needed for the pin to stay: rewrite the port directly.
    const [row] = await ctx.sql<{ value: { target: { port: number } } }[]>`SELECT value FROM settings WHERE key = 'backup'`;
    row.value.target.port = sftp.port;
    await ctx.sql`UPDATE settings SET value = ${ctx.sql.json(row.value as never)} WHERE key = 'backup'`;
    expect(s.target.hostKeySha256).toMatch(/^SHA256:/);
    const t = await admin.post('/api/backups/test');
    expect(t.json().error).toBe('backup_host_key_changed');
    expect((await admin.post('/api/backups/forget-host-key')).statusCode).toBe(200);
    expect((await admin.post('/api/backups/test')).statusCode).toBe(200);
  });
});

describe('ftps backups and restore onto a new server', () => {
  it('backs up over explicit FTPS and applies retention', async () => {
    ftp = await startFtp(ftpRoot, { user: 'ftpuser', password: 'ftp-secret', tls: 'explicit' });
    const target = { protocol: 'ftps', host: '127.0.0.1', port: ftp.port, username: 'ftpuser', password: 'ftp-secret', verifyCertificate: false, path: 'restream' };
    expect((await admin.req('PUT', '/api/backups/settings', { ...schedule, keepChains: 1, target })).statusCode).toBe(200);
    // Certificate checking on refuses the self-signed test certificate.
    await admin.req('PUT', '/api/backups/settings', { ...schedule, keepChains: 1, target: { ...target, verifyCertificate: true } });
    expect((await admin.post('/api/backups/test')).json().error).toBe('backup_tls_failed');
    await admin.req('PUT', '/api/backups/settings', { ...schedule, keepChains: 1, target });
    expect((await admin.post('/api/backups/test')).statusCode).toBe(200);
    const a = await run('full');
    await new Promise((r) => setTimeout(r, 1100));
    const b = await run('full');
    const names = readdirSync(path.join(ftpRoot, 'restream'));
    expect(names).toContain(`restream-${b.backup_id}.rsbk`);
    expect(names).not.toContain(`restream-${a.backup_id}.rsbk`);
  });

  it('re-encrypts secrets when the backup comes from a server with another APP_KEY', async () => {
    const list = (await admin.get('/api/backups')).json();
    const id = list[0].id;
    // Simulate a fresh install: a different APP_KEY, and the backup location entered again.
    const original = config.appKey;
    config.appKey = '1'.repeat(64);
    writeFileSync(config.envFile, `APP_KEY=${config.appKey}\n`);
    await ctx.sql`DELETE FROM settings WHERE key = 'backup'`;
    await ctx.sql`DELETE FROM streams`;
    const target = { protocol: 'ftps', host: '127.0.0.1', port: ftp!.port, username: 'ftpuser', password: 'ftp-secret', verifyCertificate: false, path: 'restream' };
    await admin.req('PUT', '/api/backups/settings', { ...schedule, passphrase: 'not the right passphrase', target });
    let r = await admin.post('/api/backups/restore', { id, confirm: 'RESTORE' });
    let job = await waitJob(r.json().jobId);
    expect(job.status).toBe('failed');
    expect((job as { error: string }).error).toContain('backup_wrong_passphrase');

    await admin.req('PUT', '/api/backups/settings', { ...schedule, passphrase: PASS, target });
    r = await admin.post('/api/backups/restore', { id, confirm: 'RESTORE' });
    expect((await waitJob(r.json().jobId)).status).toBe('signed_out');
    for (let i = 0; i < 100 && ctx.app.backups.busy; i++) await new Promise((res) => setTimeout(res, 100));
    await login(); // TOTP secret was re-encrypted, so 2FA still works
    job = (await admin.get('/api/backups/jobs')).json().jobs.find((j: { id: string }) => j.id === r.json().jobId);
    expect(job.status).toBe('success');
    expect(job.log).toContain('Re-encrypting secrets');
    const [s] = await ctx.sql<{ ingest_key_enc: string }[]>`SELECT ingest_key_enc FROM streams`;
    expect(decrypt(s.ingest_key_enc)).toBe('rsKEY1');
    const settings = (await admin.get('/api/backups/settings')).json().settings;
    expect(settings.target.protocol).toBe('ftps');
    expect(original).not.toBe(config.appKey); // this file keeps running with the new key
  });

  it('lists and deletes a chain', async () => {
    const list = (await admin.get('/api/backups')).json();
    const r = await admin.req('DELETE', `/api/backups/chains/${list[0].chain}`);
    expect(r.statusCode, r.body).toBe(200);
    expect((await admin.get('/api/backups')).json()).toEqual([]);
  });

  it('works over plain FTP and implicit FTPS too', async () => {
    const plain = await startFtp(tempDir('ftp-plain'), { user: 'u', password: 'p' });
    await admin.req('PUT', '/api/backups/settings', { ...schedule, target: { protocol: 'ftp', host: '127.0.0.1', port: plain.port, username: 'u', password: 'p', verifyCertificate: true, path: '' } });
    const t = await admin.post('/api/backups/test');
    expect(t.statusCode, t.body).toBe(200);
    await admin.req('PUT', '/api/backups/settings', { ...schedule, target: { protocol: 'ftp', host: '127.0.0.1', port: plain.port, username: 'u', password: 'wrong', verifyCertificate: true, path: '' } });
    expect((await admin.post('/api/backups/test')).json().error).toBe('backup_auth_failed');
    await plain.close();

    const implicit = await startFtp(tempDir('ftp-implicit'), { user: 'u', password: 'p', tls: 'implicit' });
    await admin.req('PUT', '/api/backups/settings', { ...schedule, target: { protocol: 'ftps-implicit', host: '127.0.0.1', port: implicit.port, username: 'u', password: 'p', verifyCertificate: false, path: 'x' } });
    const ti = await admin.post('/api/backups/test');
    expect(ti.statusCode, ti.body).toBe(200);
    await implicit.close();
  });
});
