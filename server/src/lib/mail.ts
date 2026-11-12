import nodemailer from 'nodemailer';
import { generateKeyPairSync } from 'node:crypto';
import { isIP } from 'node:net';
import type { Sql } from '../db.js';
import { decrypt } from './crypto.js';
import { getSettings, type MailSettings, type Settings } from './settings.js';

export class MailError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

/** Nodemailer transport options for the configured server. */
export function transportOptions(m: MailSettings) {
  return {
    host: m.host,
    port: m.port,
    secure: m.security === 'tls',
    requireTLS: m.security === 'starttls',
    ignoreTLS: m.security === 'none',
    auth: m.username ? { user: m.username, pass: m.passwordEnc ? decrypt(m.passwordEnc) : '' } : undefined,
    tls: { rejectUnauthorized: m.verifyCertificate, minVersion: 'TLSv1.2' as const, ...(isIP(m.host) ? {} : { servername: m.host }) },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    dkim: m.dkim.enabled && m.dkim.privateKeyEnc && m.dkim.domain
      ? { domainName: m.dkim.domain, keySelector: m.dkim.selector, privateKey: decrypt(m.dkim.privateKeyEnc) }
      : undefined,
  };
}

/** Maps low level SMTP/network errors to a short code the console translates. */
function classify(err: unknown): MailError {
  const e = err as { code?: string; responseCode?: number; message?: string };
  const msg = (e.message ?? String(err)).slice(0, 300);
  if (e.code === 'EAUTH' || e.responseCode === 535) return new MailError('mail_auth_failed', msg);
  if (e.code === 'ESOCKET' && /certificate|self[- ]signed|CERT_/i.test(msg)) return new MailError('mail_tls_failed', msg);
  if (e.code === 'ETLS' || /STARTTLS|wrong version number|ssl3_get_record/i.test(msg)) return new MailError('mail_tls_failed', msg);
  if (e.code === 'ECONNECTION' || e.code === 'ETIMEDOUT' || e.code === 'EDNS' || e.code === 'ESOCKET' || e.code === 'ECONNREFUSED') {
    return new MailError('mail_connect_failed', msg);
  }
  if (e.responseCode && e.responseCode >= 500) return new MailError('mail_rejected', msg);
  return new MailError('mail_failed', msg);
}

export function mailConfigured(m: MailSettings) {
  return m.enabled && !!m.host && !!m.fromAddress;
}

export interface Message { to: string[]; subject: string; text: string; html: string; kind: string }

/** Sends one message with the stored settings and records it in the mail log. Throws MailError. */
export async function sendMail(sql: Sql, msg: Message, settings?: Settings) {
  const s = settings ?? await getSettings(sql);
  const m = s.mail;
  if (!mailConfigured(m)) throw new MailError('mail_not_configured', 'mail is not configured');
  const transport = nodemailer.createTransport(transportOptions(m));
  try {
    await transport.sendMail({
      from: { name: m.fromName || s.instanceName, address: m.fromAddress },
      to: msg.to,
      replyTo: m.replyTo || undefined,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
    });
    await sql`INSERT INTO mail_log (kind, recipients, subject, status) VALUES (${msg.kind}, ${msg.to}, ${msg.subject}, 'sent')`;
  } catch (err) {
    const e = err instanceof MailError ? err : classify(err);
    await sql`INSERT INTO mail_log (kind, recipients, subject, status, error) VALUES (${msg.kind}, ${msg.to}, ${msg.subject}, 'failed', ${e.message})`;
    throw e;
  } finally {
    transport.close();
  }
}

/** Opens a connection and authenticates without sending anything. */
export async function verifyMail(m: MailSettings) {
  const transport = nodemailer.createTransport(transportOptions(m));
  try { await transport.verify(); } catch (err) { throw classify(err); } finally { transport.close(); }
}

/** New 2048-bit RSA key for DKIM, with the DNS TXT value to publish. */
export function generateDkimKey() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const der = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { privateKey: pem, dnsValue: `v=DKIM1; k=rsa; p=${der}` };
}

/** Recipients for notifications: the extra addresses plus active administrators when chosen. */
export async function notificationRecipients(sql: Sql, s: Settings): Promise<string[]> {
  const set = new Set(s.notifications.recipients.map((r) => r.toLowerCase()));
  if (s.notifications.includeAdmins) {
    const admins = await sql<{ email: string }[]>`SELECT email FROM users WHERE role = 'admin' AND NOT disabled`;
    for (const a of admins) set.add(a.email.toLowerCase());
  }
  return [...set];
}

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Renders a notification in the house style: dark card, cyan accent, plain text alternative.
 * Rows are label/value pairs shown under the intro.
 */
export function render(opts: {
  instanceName: string; title: string; intro: string; rows?: [string, string][]; tone?: 'ok' | 'warn' | 'danger' | 'info';
  link?: { href: string; label: string }; footer: string;
}) {
  const color = { ok: '#3DDC97', warn: '#FFB547', danger: '#FF5C6C', info: '#2EE6D6' }[opts.tone ?? 'info'];
  const rows = opts.rows ?? [];
  const text = [
    opts.title, '', opts.intro, '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(opts.link ? ['', `${opts.link.label}: ${opts.link.href}`] : []),
    '', '--', opts.footer,
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#070A12;padding:32px 12px;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;color:#E8ECF6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#0D1220;border:1px solid #1E2740;border-radius:16px">
<tr><td style="padding:24px 28px 0 28px">
<div style="font-family:'JetBrains Mono',Consolas,monospace;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#2EE6D6">${esc(opts.instanceName)}</div>
<div style="height:4px;width:48px;background:${color};border-radius:2px;margin:14px 0 18px 0"></div>
<h1 style="margin:0 0 12px 0;font-size:20px;line-height:1.3;color:#E8ECF6">${esc(opts.title)}</h1>
<p style="margin:0 0 18px 0;font-size:15px;line-height:1.55;color:#B4BDD3">${esc(opts.intro)}</p>
</td></tr>
${rows.length ? `<tr><td style="padding:0 28px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #1E2740">
${rows.map(([k, v]) => `<tr><td style="padding:9px 0;border-bottom:1px solid #1E2740;font-size:13px;color:#8A94AD">${esc(k)}</td><td align="right" style="padding:9px 0;border-bottom:1px solid #1E2740;font-family:'JetBrains Mono',Consolas,monospace;font-size:13px;color:#E8ECF6">${esc(v)}</td></tr>`).join('')}
</table></td></tr>` : ''}
${opts.link ? `<tr><td style="padding:22px 28px 0 28px"><a href="${esc(opts.link.href)}" style="display:inline-block;background:#2EE6D6;color:#070A12;text-decoration:none;font-weight:600;font-size:14px;padding:11px 18px;border-radius:10px">${esc(opts.link.label)}</a></td></tr>` : ''}
<tr><td style="padding:24px 28px 26px 28px;font-size:12px;line-height:1.5;color:#8A94AD">${esc(opts.footer)}</td></tr>
</table></td></tr></table></body></html>`;
  return { text, html };
}
