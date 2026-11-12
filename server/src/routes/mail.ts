import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { HttpError, requireAuth } from '../lib/guards.js';
import { getSettings, notifyEvents, setSettings, type NotifyEvent } from '../lib/settings.js';
import { encrypt } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { MailError, generateDkimKey, mailConfigured, render, sendMail, verifyMail } from '../lib/mail.js';
import { texts } from '../lib/notify.js';

const host = z.string().trim().max(253).regex(/^[A-Za-z0-9.-]*$|^\[[0-9a-fA-F:.]+\]$/);
const email = z.email().max(254);

function mailFail(err: unknown): never {
  if (err instanceof MailError) throw new HttpError(422, err.code, err.message, err.message);
  throw err;
}

export async function mailRoutes(app: FastifyInstance, { sql }: { sql: Sql }) {
  const admin = { preHandler: requireAuth('admin') };

  app.get('/api/mail', admin, async () => {
    const s = await getSettings(sql);
    const { passwordEnc, dkim, ...mail } = s.mail;
    return {
      mail: {
        ...mail,
        passwordSet: !!passwordEnc,
        dkim: {
          enabled: dkim.enabled, domain: dkim.domain, selector: dkim.selector, keySet: !!dkim.privateKeyEnc,
          dnsName: dkim.domain ? `${dkim.selector}._domainkey.${dkim.domain}` : '',
          dnsValue: dkim.publicKey,
        },
      },
      configured: mailConfigured(s.mail),
      notifications: s.notifications,
      events: notifyEvents,
    };
  });

  app.put('/api/mail', admin, async (req) => {
    const b = z.object({
      enabled: z.boolean(),
      host,
      port: z.number().int().min(1).max(65535),
      security: z.enum(['tls', 'starttls', 'none']),
      verifyCertificate: z.boolean(),
      username: z.string().trim().max(254),
      /** Omitted keeps the stored password, an empty string clears it. */
      password: z.string().max(500).optional(),
      fromName: z.string().trim().max(80),
      fromAddress: z.union([email, z.literal('')]),
      replyTo: z.union([email, z.literal('')]),
      dkim: z.object({
        enabled: z.boolean(),
        domain: z.string().trim().toLowerCase().max(253).regex(/^[a-z0-9.-]*$/),
        selector: z.string().trim().min(1).max(63).regex(/^[A-Za-z0-9-]+$/),
      }),
    }).parse(req.body);
    if (b.enabled && (!b.host || !b.fromAddress)) throw new HttpError(400, 'mail_incomplete');
    const cur = (await getSettings(sql)).mail;
    if (b.dkim.enabled && (!b.dkim.domain || !cur.dkim.privateKeyEnc)) throw new HttpError(400, 'dkim_incomplete');
    const { password, dkim, ...rest } = b;
    await setSettings(sql, {
      mail: {
        ...cur, ...rest,
        passwordEnc: password === undefined ? cur.passwordEnc : password ? encrypt(password) : '',
        dkim: { ...cur.dkim, ...dkim },
      },
    });
    await audit(sql, req, 'mail.updated', { host: b.host, security: b.security, enabled: b.enabled });
    return { ok: true };
  });

  /** Generates a new DKIM key pair; the old key stops working once the DNS record is replaced. */
  app.post('/api/mail/dkim', admin, async (req) => {
    const cur = (await getSettings(sql)).mail;
    const k = generateDkimKey();
    await setSettings(sql, { mail: { ...cur, dkim: { ...cur.dkim, privateKeyEnc: encrypt(k.privateKey), publicKey: k.dnsValue } } });
    await audit(sql, req, 'mail.dkim_generated');
    return { dnsValue: k.dnsValue };
  });

  /** Connects and logs in with the saved settings, without sending. */
  app.post('/api/mail/verify', { ...admin, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async () => {
    const s = await getSettings(sql);
    if (!s.mail.host) throw new HttpError(400, 'mail_not_configured');
    await verifyMail(s.mail).catch(mailFail);
    return { ok: true };
  });

  app.post('/api/mail/test', { ...admin, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { to } = z.object({ to: email }).parse(req.body);
    const s = await getSettings(sql);
    const t = texts(req.user!.language ?? s.defaultLanguage);
    const m = s.mail;
    const body = render({
      instanceName: s.instanceName, title: t.testSubject(s.instanceName), intro: t.testIntro, tone: 'ok',
      rows: [[t.server, `${m.host}:${m.port}`], [t.security, m.security.toUpperCase()], [t.dkim, m.dkim.enabled ? `${m.dkim.selector}._domainkey.${m.dkim.domain}` : '—']],
      link: s.publicUrl ? { href: s.publicUrl, label: t.open } : undefined,
      footer: t.footer(s.instanceName),
    });
    await sendMail(sql, { kind: 'test', to: [to], subject: t.testSubject(s.instanceName), ...body }, s).catch(mailFail);
    await audit(sql, req, 'mail.test_sent', { to });
    return { ok: true };
  });

  app.get('/api/mail/log', admin, async () => sql`
    SELECT id, kind, recipients, subject, status, error, created_at FROM mail_log ORDER BY created_at DESC LIMIT 50`);

  app.put('/api/notifications', admin, async (req) => {
    const b = z.object({
      recipients: z.array(email).max(20),
      includeAdmins: z.boolean(),
      events: z.object(Object.fromEntries(notifyEvents.map((e) => [e, z.boolean()])) as Record<NotifyEvent, z.ZodBoolean>),
    }).parse(req.body);
    await setSettings(sql, { notifications: { ...b, recipients: [...new Set(b.recipients.map((r) => r.toLowerCase()))] } });
    await audit(sql, req, 'notifications.updated', { recipients: b.recipients.length });
    return { ok: true };
  });
}
