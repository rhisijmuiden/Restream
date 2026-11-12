import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, addUser, loginWithEnrolment, setup } from './helpers.js';
import { startSmtp, tempDir } from './servers.js';
import { Notifier } from '../src/lib/notify.js';
import type { MediaSupervisor } from '../src/media/supervisor.js';

let ctx: Awaited<ReturnType<typeof setup>>;
let admin: Client;
let smtp: Awaited<ReturnType<typeof startSmtp>>;
let smtps: Awaited<ReturnType<typeof startSmtp>>;
const certDir = tempDir('smtp');

const base = {
  enabled: true, host: '127.0.0.1', port: 0, security: 'starttls', verifyCertificate: false,
  username: 'mailer', password: 'mail-secret', fromName: 'Studio', fromAddress: 'restream@example.com', replyTo: '',
  dkim: { enabled: false, domain: '', selector: 'restream' },
};

beforeAll(async () => {
  ctx = await setup();
  await addUser(ctx.sql, 'admin@example.com', 'correct horse battery');
  admin = new Client(ctx.app);
  await loginWithEnrolment(admin, 'admin@example.com', 'correct horse battery');
  smtp = await startSmtp({ user: 'mailer', password: 'mail-secret', certDir });
  smtps = await startSmtp({ user: 'mailer', password: 'mail-secret', certDir, secure: true });
});
afterAll(async () => { await smtp.close(); await smtps.close(); await ctx.app.close(); await ctx.sql.end(); });

describe('mail server', () => {
  it('stores settings without returning the password', async () => {
    const r = await admin.req('PUT', '/api/mail', { ...base, port: smtp.port });
    expect(r.statusCode).toBe(200);
    const g = (await admin.get('/api/mail')).json();
    expect(g.mail.passwordSet).toBe(true);
    expect(g.configured).toBe(true);
    expect(JSON.stringify(g)).not.toContain('mail-secret');
    expect((await admin.req('PUT', '/api/mail', { ...base, port: smtp.port, fromAddress: '' })).json().error).toBe('mail_incomplete');
  });

  it('sends a test message over STARTTLS with authentication', async () => {
    const r = await admin.post('/api/mail/test', { to: 'ops@example.com' });
    expect(r.statusCode, r.body).toBe(200);
    const m = smtp.received.at(-1)!;
    expect(m.to).toEqual(['ops@example.com']);
    expect(m.secure).toBe(true);
    expect(m.user).toBe('mailer');
    expect(m.raw).toContain('Subject: Test message from Restream');
    expect(m.raw).toContain('Auto-Submitted: auto-generated');
    const log = (await admin.get('/api/mail/log')).json();
    expect(log[0]).toMatchObject({ kind: 'test', status: 'sent' });
  });

  it('signs with DKIM once a key is generated', async () => {
    const k = (await admin.post('/api/mail/dkim')).json();
    expect(k.dnsValue).toMatch(/^v=DKIM1; k=rsa; p=[A-Za-z0-9+/=]+$/);
    expect((await admin.req('PUT', '/api/mail', { ...base, port: smtp.port, password: undefined, dkim: { enabled: true, domain: 'example.com', selector: 'rs1' } })).statusCode).toBe(200);
    const g = (await admin.get('/api/mail')).json();
    expect(g.mail.dkim).toMatchObject({ keySet: true, dnsName: 'rs1._domainkey.example.com' });
    expect((await admin.post('/api/mail/test', { to: 'ops@example.com' })).statusCode).toBe(200);
    expect(smtp.received.at(-1)!.raw).toMatch(/DKIM-Signature: v=1; a=rsa-sha256; c=relaxed\/relaxed; d=example.com;\s*q=dns\/txt; s=rs1;/);
  });

  it('works with implicit TLS and reports a wrong password clearly', async () => {
    expect((await admin.req('PUT', '/api/mail', { ...base, port: smtps.port, security: 'tls' })).statusCode).toBe(200);
    expect((await admin.post('/api/mail/verify')).statusCode).toBe(200);
    expect((await admin.post('/api/mail/test', { to: 'ops@example.com' })).statusCode).toBe(200);
    expect(smtps.received.length).toBe(1);

    await admin.req('PUT', '/api/mail', { ...base, port: smtps.port, security: 'tls', password: 'wrong' });
    const bad = await admin.post('/api/mail/verify');
    expect(bad.json().error).toBe('mail_auth_failed');
    // Certificate checking on: the self-signed test certificate is refused.
    await admin.req('PUT', '/api/mail', { ...base, port: smtps.port, security: 'tls', verifyCertificate: true });
    expect((await admin.post('/api/mail/verify')).json().error).toBe('mail_tls_failed');
    await admin.req('PUT', '/api/mail', { ...base, port: smtp.port, dkim: { enabled: false, domain: '', selector: 'restream' } });
  });
});

describe('notifications', () => {
  it('saves recipients and events', async () => {
    const g = (await admin.get('/api/mail')).json();
    const events = { ...g.notifications.events, backupSucceeded: true };
    const r = await admin.req('PUT', '/api/notifications', { recipients: ['Noc@example.com', 'noc@example.com'], includeAdmins: true, events });
    expect(r.statusCode).toBe(200);
    expect((await admin.get('/api/mail')).json().notifications.recipients).toEqual(['noc@example.com']);
  });

  it('mails once when a live stream loses its ingest and once when it returns', async () => {
    const [s] = await ctx.sql<{ id: string }[]>`
      INSERT INTO streams (name, ingest_key_hash, ingest_key_enc, playback_id) VALUES ('Main', 'h', 'x', 'p1') RETURNING id`;
    await ctx.sql`INSERT INTO destinations (stream_id, name, platform, server_url, live) VALUES (${s.id}, 'YouTube', 'youtube', 'rtmp://a', true)`;
    let online = false;
    const media = {
      mediamtxOnline: true,
      ingestState: () => ({ online }),
      outputState: () => ({ state: 'waiting', attempts: 0, lastError: null }),
    } as unknown as MediaSupervisor;
    process.env.MEDIA_ENABLED = 'true';
    const { config } = await import('../src/config.js');
    config.media.enabled = true;
    const n = new Notifier(ctx.sql, media, ctx.app.log);
    const before = smtp.received.length;
    await n.tick(); // first offline observation
    const realNow = Date.now;
    Date.now = () => realNow() + 25_000;
    await n.tick();
    await n.tick();
    Date.now = realNow;
    expect(smtp.received.length).toBe(before + 1);
    const down = smtp.received.at(-1)!;
    expect(down.raw).toContain('lost its ingest');
    expect(down.to.sort()).toEqual(['admin@example.com', 'noc@example.com']);
    online = true;
    await n.tick();
    expect(smtp.received.length).toBe(before + 2);
    expect(smtp.received.at(-1)!.raw).toContain('is back');
    config.media.enabled = false;
  });

  it('uses the default language for notifications', async () => {
    await admin.req('PUT', '/api/settings', { defaultLanguage: 'nl' });
    const n = new Notifier(ctx.sql, null, ctx.app.log);
    expect(await n.send('backupSucceeded', (t) => ({ title: t.backupOk('20261112-030000-full')[0], intro: 'x' }))).toBe(true);
    expect(smtp.received.at(-1)!.raw).toContain('voltooid');
    expect(await n.send('updateAvailable', () => ({ title: 'x', intro: 'y' }))).toBe(false); // off by default
    await admin.req('PUT', '/api/settings', { defaultLanguage: 'en' });
  });
});
