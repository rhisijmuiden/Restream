import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';

/**
 * Encrypted bundle format (".rsbk"):
 *   "RSBK" | version (1 byte) | scrypt salt (16) | GCM IV (12) | AES-256-GCM ciphertext | GCM tag (16)
 * The key is derived from the backup passphrase with scrypt (N=2^15, r=8, p=1).
 */
const MAGIC = Buffer.from('RSBK');
const VERSION = 1;
const HEADER = MAGIC.length + 1 + 16 + 12;
const TAG = 16;

export class ArchiveError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

function deriveKey(passphrase: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, k) => (err ? reject(err) : resolve(k)));
  });
}

/** Encrypts `src` into `dst`; returns size and SHA-256 of the written file. */
export async function encryptFile(src: string, dst: string, passphrase: string) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', await deriveKey(passphrase, salt), iv);
  const hash = createHash('sha256');
  let size = 0;
  const emit = (b: Buffer) => { hash.update(b); size += b.length; return b; };
  await pipeline(
    createReadStream(src),
    cipher,
    async function* (source: AsyncIterable<Buffer>) {
      yield emit(Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, iv]));
      for await (const chunk of source) yield emit(chunk);
      yield emit(cipher.getAuthTag());
    },
    createWriteStream(dst, { mode: 0o600 }),
  );
  return { size, sha256: hash.digest('hex') };
}

export async function decryptFile(src: string, dst: string, passphrase: string) {
  const { size } = await stat(src);
  if (size < HEADER + TAG) throw new ArchiveError('backup_corrupt', 'file too small');
  const fh = await open(src, 'r');
  const head = Buffer.alloc(HEADER);
  const tag = Buffer.alloc(TAG);
  try {
    await fh.read(head, 0, HEADER, 0);
    await fh.read(tag, 0, TAG, size - TAG);
  } finally { await fh.close(); }
  if (!head.subarray(0, 4).equals(MAGIC) || head[4] !== VERSION) throw new ArchiveError('backup_corrupt', 'not a Restream backup');
  const salt = head.subarray(5, 21);
  const iv = head.subarray(21, 33);
  const decipher = createDecipheriv('aes-256-gcm', await deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  try {
    // An empty range (no ciphertext) is not expressible with start/end, so it is skipped.
    const body = size - HEADER - TAG > 0 ? createReadStream(src, { start: HEADER, end: size - TAG - 1 }) : (async function* () { /* empty */ })();
    await pipeline(body, decipher, createWriteStream(dst, { mode: 0o600 }));
  } catch (err) {
    if (/unable to authenticate|Unsupported state/i.test((err as Error).message)) {
      throw new ArchiveError('backup_wrong_passphrase', 'the passphrase is wrong or the file is damaged');
    }
    throw err;
  }
}

export async function sha256File(path: string) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** Runs a command and resolves with stdout; rejects with the last stderr lines. */
export function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string; stdoutFile?: string } = {}) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['ignore', opts.stdoutFile ? 'pipe' : 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const sink = opts.stdoutFile ? createWriteStream(opts.stdoutFile, { mode: 0o600 }) : null;
    if (sink) child.stdout.pipe(sink); else child.stdout.on('data', (d: Buffer) => { if (out.length < 4_000_000) out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-4000); });
    child.on('error', (e) => reject(new ArchiveError('backup_tool_missing', `${cmd}: ${e.message}`)));
    child.on('close', (code) => {
      const done = () => (code === 0 ? resolve(out) : reject(new ArchiveError('backup_command_failed', `${cmd} exited with ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`)));
      if (sink) sink.end(done); else done();
    });
  });
}
