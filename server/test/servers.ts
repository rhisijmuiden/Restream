/** In-process SFTP, FTP(S) and SMTP servers for the mail and backup tests. */
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';
import { SMTPServer } from 'smtp-server';

const { Server, utils } = ssh2;
const { OPEN_MODE, STATUS_CODE } = utils.sftp;

export function selfSigned(dir: string) {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  if (!existsSync(cert)) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  }
  return { key, cert };
}

export function tempDir(name: string) {
  const d = path.join(tmpdir(), `restream-${name}-${process.pid}-${Date.now()}`);
  mkdirSync(d, { recursive: true });
  return d;
}

/** Minimal SFTP server rooted at `root`, accepting one user with a password or a public key. */
export async function startSftp(root: string, auth: { user: string; password?: string; publicKey?: string }) {
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  const allowedKey = auth.publicKey ? utils.parseKey(auth.publicKey) : null;
  const resolve = (p: string) => {
    const rel = p.replace(/^\/+/, '');
    const full = path.resolve(root, rel);
    if (!full.startsWith(path.resolve(root))) throw new Error('outside root');
    return full;
  };
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.username !== auth.user) return ctx.reject();
      if (ctx.method === 'password' && auth.password && ctx.password === auth.password) return ctx.accept();
      if (ctx.method === 'publickey' && allowedKey && !(allowedKey instanceof Error)) {
        const k = Array.isArray(allowedKey) ? allowedKey[0] : allowedKey;
        if (ctx.key.algo === k.type && ctx.key.data.equals(k.getPublicSSH())) {
          if (!ctx.signature) return ctx.accept();
          if (k.verify(ctx.blob!, ctx.signature, ctx.hashAlgo)) return ctx.accept();
        }
      }
      return ctx.reject(['password', 'publickey']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acc) => {
          const sftp = acc();
          const handles = new Map<number, { fd?: number; dir?: string[]; done?: boolean }>();
          let next = 1;
          const handle = (h: { fd?: number; dir?: string[] }) => { const id = next++; handles.set(id, h); const b = Buffer.alloc(4); b.writeUInt32BE(id); return b; };
          const get = (b: Buffer) => handles.get(b.readUInt32BE(0));
          const attrs = (st: ReturnType<typeof statSync>) => ({ mode: st.mode, uid: 0, gid: 0, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) });
          const safe = (reqid: number, fn: () => void) => { try { fn(); } catch { sftp.status(reqid, STATUS_CODE.FAILURE); } };
          sftp.on('REALPATH', (reqid, p) => sftp.name(reqid, [{ filename: p === '.' ? '/' : p, longname: p, attrs: {} as never }]));
          sftp.on('STAT', (reqid, p) => { try { sftp.attrs(reqid, attrs(statSync(resolve(p)))); } catch { sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE); } });
          sftp.on('LSTAT', (reqid, p) => { try { sftp.attrs(reqid, attrs(statSync(resolve(p)))); } catch { sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE); } });
          sftp.on('FSTAT', (reqid, h) => safe(reqid, () => sftp.attrs(reqid, attrs(fstatSync(get(h)!.fd!)))));
          sftp.on('MKDIR', (reqid, p) => safe(reqid, () => { mkdirSync(resolve(p)); sftp.status(reqid, STATUS_CODE.OK); }));
          sftp.on('REMOVE', (reqid, p) => { try { unlinkSync(resolve(p)); sftp.status(reqid, STATUS_CODE.OK); } catch { sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE); } });
          sftp.on('RENAME', (reqid, a, b) => safe(reqid, () => { renameSync(resolve(a), resolve(b)); sftp.status(reqid, STATUS_CODE.OK); }));
          sftp.on('OPEN', (reqid, p, flags) => safe(reqid, () => {
            // eslint-disable-next-line no-bitwise
            const mode = flags & OPEN_MODE.WRITE ? 'w' : 'r';
            sftp.handle(reqid, handle({ fd: openSync(resolve(p), mode) }));
          }));
          sftp.on('WRITE', (reqid, h, offset, data) => safe(reqid, () => { writeSync(get(h)!.fd!, data, 0, data.length, offset); sftp.status(reqid, STATUS_CODE.OK); }));
          sftp.on('READ', (reqid, h, offset, len) => safe(reqid, () => {
            const buf = Buffer.alloc(len);
            const n = readSync(get(h)!.fd!, buf, 0, len, offset);
            if (n === 0) sftp.status(reqid, STATUS_CODE.EOF); else sftp.data(reqid, buf.subarray(0, n));
          }));
          sftp.on('OPENDIR', (reqid, p) => safe(reqid, () => sftp.handle(reqid, handle({ dir: [resolve(p)] }))));
          sftp.on('READDIR', (reqid, h) => safe(reqid, () => {
            const e = get(h)!;
            if (e.done) return sftp.status(reqid, STATUS_CODE.EOF);
            e.done = true;
            const dir = e.dir![0];
            sftp.name(reqid, readdirSync(dir).map((f) => ({ filename: f, longname: f, attrs: attrs(statSync(path.join(dir, f))) as never })));
          }));
          sftp.on('CLOSE', (reqid, h) => {
            const e = get(h);
            if (e?.fd !== undefined) closeSync(e.fd);
            handles.delete(h.readUInt32BE(0));
            sftp.status(reqid, STATUS_CODE.OK);
          });
        });
      });
    });
    client.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** FTP server (optionally FTPS, explicit or implicit) rooted at `root`. */
export async function startFtp(root: string, opts: { user: string; password: string; tls?: 'explicit' | 'implicit'; certDir?: string }) {
  const { FtpSrv } = await import('ftp-srv') as unknown as { FtpSrv: new (o: Record<string, unknown>) => { on: (e: string, fn: (...a: never[]) => void) => void; listen: () => Promise<void>; close: () => Promise<void> } };
  const net = await import('node:net');
  const port = await new Promise<number>((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });
  const tls = opts.tls ? selfSigned(opts.certDir ?? root) : null;
  const { readFileSync } = await import('node:fs');
  const server = new FtpSrv({
    url: `${opts.tls === 'implicit' ? 'ftps' : 'ftp'}://127.0.0.1:${port}`,
    pasv_url: '127.0.0.1', pasv_min: 30000, pasv_max: 40000,
    anonymous: false, greeting: 'test',
    tls: tls ? { key: readFileSync(tls.key), cert: readFileSync(tls.cert) } : false,
    log: { info() {}, debug() {}, trace() {}, warn() {}, error() {}, child() { return this; } },
  });
  server.on('login', (({ username, password }: { username: string; password: string }, resolve: (o: { root: string }) => void, reject: (e: Error) => void) => {
    if (username === opts.user && password === opts.password) resolve({ root }); else reject(new Error('530 bad login'));
  }) as never);
  server.on('client-error', (() => {}) as never);
  await server.listen();
  return { port, close: () => server.close() };
}

export interface Received { from: string; to: string[]; raw: string; secure: boolean; user?: string }

/** SMTP server with STARTTLS (or implicit TLS) and AUTH PLAIN/LOGIN for one user. */
export async function startSmtp(opts: { user: string; password: string; secure?: boolean; certDir: string }) {
  const { readFileSync } = await import('node:fs');
  const tls = selfSigned(opts.certDir);
  const received: Received[] = [];
  const server = new SMTPServer({
    secure: !!opts.secure,
    key: readFileSync(tls.key), cert: readFileSync(tls.cert),
    authMethods: ['PLAIN', 'LOGIN'],
    logger: false,
    onAuth(auth, _session, cb) {
      if (auth.username === opts.user && auth.password === opts.password) return cb(null, { user: auth.username });
      return cb(Object.assign(new Error('Invalid username or password'), { responseCode: 535 }));
    },
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (d: Buffer) => { raw += d.toString(); });
      stream.on('end', () => {
        received.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '', to: session.envelope.rcptTo.map((r) => r.address), raw, secure: session.secure, user: session.user as string | undefined });
        cb();
      });
    },
  });
  server.on('error', () => {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.server.address() as { port: number }).port;
  return { port, received, close: () => new Promise<void>((r) => server.close(() => r())) };
}
