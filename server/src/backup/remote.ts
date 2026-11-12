import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { Client as FtpClient } from 'basic-ftp';
import ssh2 from 'ssh2';
import type { SFTPWrapper } from 'ssh2';
import { decrypt } from '../lib/crypto.js';
import type { BackupTarget } from '../lib/settings.js';

const { Client: SshClient, utils: sshUtils } = ssh2;

export class RemoteError extends Error {
  constructor(public code: string, message: string, public detail?: Record<string, unknown>) { super(message); }
}

export interface RemoteFile { name: string; size: number }

/** One open connection to the backup location. Names are plain file names inside the target directory. */
export interface Remote {
  put(localPath: string, name: string): Promise<void>;
  get(name: string, localPath: string): Promise<void>;
  list(): Promise<RemoteFile[]>;
  remove(name: string): Promise<void>;
  close(): Promise<void>;
  /** SHA-256 fingerprint of the SSH host key (scp only). */
  hostKey?: string;
}

const defaultPorts = { ftp: 21, ftps: 21, 'ftps-implicit': 990, scp: 22 } as const;
export const defaultPort = (p: BackupTarget['protocol']) => defaultPorts[p];

/** Remote directory segments; rejects anything that climbs out of the login directory. */
export function remoteDir(path: string): string[] {
  const parts = path.split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) throw new RemoteError('backup_invalid_path', 'the remote path may not contain ..');
  return parts;
}
const absolute = (path: string) => path.trim().startsWith('/');

function wrap(err: unknown, fallback = 'backup_remote_failed'): RemoteError {
  if (err instanceof RemoteError) return err;
  const e = err as { code?: string | number; message?: string; level?: string };
  const msg = (e.message ?? String(err)).slice(0, 300);
  if (e.code === 530 || e.level === 'client-authentication' || /authentication|login incorrect|530/i.test(msg)) return new RemoteError('backup_auth_failed', msg);
  if (/certificate|self[- ]signed|CERT_|wrong version number/i.test(msg)) return new RemoteError('backup_tls_failed', msg);
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ECONNRESET'].includes(String(e.code)) || /timeout|timed out/i.test(msg)) {
    return new RemoteError('backup_connect_failed', msg);
  }
  return new RemoteError(fallback, msg);
}

// --- FTP / FTPS -------------------------------------------------------------------------------

async function openFtp(t: BackupTarget): Promise<Remote> {
  const client = new FtpClient(30_000);
  const secure = t.protocol === 'ftp' ? false : t.protocol === 'ftps-implicit' ? 'implicit' as const : true;
  try {
    await client.access({
      host: t.host, port: t.port || defaultPort(t.protocol), user: t.username || 'anonymous',
      password: t.passwordEnc ? decrypt(t.passwordEnc) : '',
      secure,
      secureOptions: secure ? { rejectUnauthorized: t.verifyCertificate, minVersion: 'TLSv1.2', ...(isIP(t.host) ? {} : { servername: t.host }) } : undefined,
    });
    if (absolute(t.path)) await client.cd('/');
    const dir = remoteDir(t.path);
    if (dir.length) await client.ensureDir(dir.join('/'));
  } catch (err) {
    client.close();
    throw wrap(err);
  }
  const run = async <R>(fn: () => Promise<R>) => { try { return await fn(); } catch (err) { throw wrap(err); } };
  return {
    put: (local, name) => run(async () => {
      await client.uploadFrom(local, `${name}.part`);
      await client.remove(name, true).catch(() => {});
      await client.rename(`${name}.part`, name);
    }),
    get: (name, local) => run(async () => { await client.downloadTo(local, name); }),
    list: () => run(async () => (await client.list()).filter((f) => f.isFile).map((f) => ({ name: f.name, size: f.size }))),
    remove: (name) => run(async () => { await client.remove(name); }),
    close: async () => { client.close(); },
  };
}

// --- SCP (SSH, file transfer over the SFTP subsystem) -----------------------------------------

/** OpenSSH style fingerprint: SHA256:<base64 without padding>. */
export const fingerprint = (key: Buffer) => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

/** New ed25519 key pair in OpenSSH format for the backup login. */
export function generateSshKey(comment = 'restream-backup') {
  const k = sshUtils.generateKeyPairSync('ed25519', { comment });
  return { privateKey: k.private, publicKey: k.public.trim() };
}

async function openScp(t: BackupTarget): Promise<Remote> {
  const conn = new SshClient();
  let seen = '';
  const privateKey = t.privateKeyEnc ? decrypt(t.privateKeyEnc) : undefined;
  const password = t.passwordEnc ? decrypt(t.passwordEnc) : undefined;
  if (!privateKey && !password) throw new RemoteError('backup_no_credentials', 'set a password or a key');

  const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
    conn.on('ready', () => conn.sftp((err, s) => (err ? reject(err) : resolve(s))));
    conn.on('error', (err) => {
      if (seen && t.hostKeySha256 && seen !== t.hostKeySha256) {
        reject(new RemoteError('backup_host_key_changed', 'the SSH host key changed', { expected: t.hostKeySha256, actual: seen }));
      } else reject(err);
    });
    conn.connect({
      host: t.host, port: t.port || 22, username: t.username, privateKey, password,
      readyTimeout: 20_000, keepaliveInterval: 15_000,
      // Trust on first use: an empty pin accepts the key (the caller stores it), a set pin must match.
      hostVerifier: (key: Buffer) => { seen = fingerprint(key); return !t.hostKeySha256 || seen === t.hostKeySha256; },
    });
  }).catch((err) => { conn.end(); throw wrap(err); });

  const p = <R>(fn: (cb: (err: Error | null | undefined, r?: R) => void) => void) =>
    new Promise<R>((resolve, reject) => fn((err, r) => (err ? reject(wrap(err)) : resolve(r as R))));

  // Resolve and create the target directory.
  let base = absolute(t.path) ? '' : '.';
  try {
    for (const part of remoteDir(t.path)) {
      base = base === '' ? `/${part}` : `${base}/${part}`;
      const exists = await p<unknown>((cb) => sftp.stat(base, cb)).then(() => true, () => false);
      if (!exists) await p<void>((cb) => sftp.mkdir(base, (e) => cb(e)));
    }
  } catch (err) {
    conn.end();
    throw wrap(err);
  }
  if (base === '') base = '/';
  const full = (name: string) => (base.endsWith('/') ? `${base}${name}` : `${base}/${name}`);

  return {
    hostKey: seen,
    put: async (local, name) => {
      await p<void>((cb) => sftp.fastPut(local, full(`${name}.part`), (e) => cb(e)));
      await p<void>((cb) => sftp.unlink(full(name), () => cb(null)));
      await p<void>((cb) => sftp.rename(full(`${name}.part`), full(name), (e) => cb(e)));
    },
    get: (name, local) => p<void>((cb) => sftp.fastGet(full(name), local, (e) => cb(e))),
    list: async () => {
      const entries = await p<{ filename: string; attrs: { size: number; mode: number } }[]>((cb) => sftp.readdir(base, cb));
      // eslint-disable-next-line no-bitwise
      return entries.filter((e) => (e.attrs.mode & 0o170000) === 0o100000).map((e) => ({ name: e.filename, size: e.attrs.size }));
    },
    remove: (name) => p<void>((cb) => sftp.unlink(full(name), (e) => cb(e))),
    close: async () => { conn.end(); },
  };
}

export async function openRemote(t: BackupTarget): Promise<Remote> {
  if (!t.host) throw new RemoteError('backup_not_configured', 'no backup location configured');
  return t.protocol === 'scp' ? openScp(t) : openFtp(t);
}
