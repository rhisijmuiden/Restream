import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { ZodError } from 'zod';
import { config } from './config.js';
import type { Sql } from './db.js';
import { loadSession } from './lib/session.js';
import { apiKeyForbidden, loadApiKey } from './lib/apiKeys.js';
import { integrationRoutes } from './routes/integrations.js';
import { WebhookDispatcher } from './lib/webhooks.js';
import { HttpError } from './lib/guards.js';
import { authRoutes } from './routes/auth.js';
import { ssoRoutes } from './routes/sso.js';
import { userRoutes } from './routes/users.js';
import { systemRoutes } from './routes/system.js';
import { settingsRoutes } from './routes/settings.js';
import { streamRoutes } from './routes/streams.js';
import { mediaRoutes, PlaybackCache } from './routes/media.js';
import { embedRoutes } from './routes/embed.js';
import { recordingRoutes } from './routes/recordings.js';
import { accountRoutes } from './routes/accounts.js';
import { eventRoutes } from './routes/events.js';
import { liveRoutes } from './routes/live.js';
import { LiveMonitor } from './live/monitor.js';
import { Provisioner } from './platforms/provisioner.js';
import { EventScheduler } from './events/scheduler.js';
import { MediaSupervisor } from './media/supervisor.js';
import { mailRoutes } from './routes/mail.js';
import { backupRoutes } from './routes/backups.js';
import { Notifier } from './lib/notify.js';
import { BackupService } from './backup/service.js';

export async function buildApp(sql: Sql, opts: { logger?: boolean; background?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    trustProxy: '127.0.0.1',
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        // The dashboard preview falls back to HLS (hls.js uses Media Source blobs and a worker).
        mediaSrc: ["'self'", 'blob:'],
        workerSrc: ["'self'", 'blob:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'", 'https://login.microsoftonline.com'],
        upgradeInsecureRequests: config.cookieSecure ? [] : null,
      },
    },
    hsts: config.cookieSecure,
  });
  await app.register(rateLimit, { global: false });

  // API answers are live state (stream status, sessions): never let a browser or a CDN such as Cloudflare cache them.
  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/') && !reply.hasHeader('cache-control')) reply.header('cache-control', 'private, no-store');
  });

  app.decorateRequest('session', null);
  app.decorateRequest('user', null);
  app.decorateRequest('apiKey', null);

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    // Called by MediaMTX on this machine; the route itself refuses anything that is not local.
    if (req.url.startsWith('/api/internal/')) return;
    // Other projects use an API key. No cookies are involved, so the CSRF header is not needed.
    const authz = req.headers.authorization;
    if (authz?.toLowerCase().startsWith('bearer ')) {
      await loadApiKey(sql, req, authz.slice(7).trim());
      if (!req.user) throw new HttpError(401, 'invalid_api_key');
      if (apiKeyForbidden(req.method, req.url)) throw new HttpError(403, 'not_allowed_with_api_key');
      return;
    }
    // CSRF defence in depth (cookies are SameSite=Strict): state changing calls need a custom header,
    // which browsers only send from same-origin scripts.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-restream'] !== '1') {
      throw new HttpError(403, 'csrf');
    }
    await loadSession(sql, req);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: 'validation', issues: err.issues });
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, ...(err.detail ? { detail: err.detail } : {}) });
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.code ?? 'bad_request', message: e.message });
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'internal' });
  });

  await app.register(authRoutes, { sql });
  await app.register(ssoRoutes, { sql });
  await app.register(userRoutes, { sql });
  await app.register(systemRoutes, { sql });
  await app.register(settingsRoutes, { sql });

  const media = new MediaSupervisor(sql, app.log);
  const playback = new PlaybackCache(sql);
  const provisioner = new Provisioner(sql, app.log);
  const scheduler = new EventScheduler(sql, app.log);
  provisioner.onReady = () => media.nudge();
  scheduler.onChange = () => { provisioner.nudge(); media.nudge(); };
  app.decorate('provisioner', provisioner);
  app.decorate('scheduler', scheduler);
  app.decorate('media', media);
  const live = new LiveMonitor(sql, app.log, media);
  app.decorate('live', live);
  await app.register(streamRoutes, { sql, media, playback, provisioner });
  await app.register(mediaRoutes, { sql, playback });
  await app.register(embedRoutes, { sql, playback });
  await app.register(recordingRoutes, { sql, media });
  await app.register(accountRoutes, { sql });
  await app.register(eventRoutes, { sql, scheduler, provisioner });
  await app.register(liveRoutes, { sql, live });
  if (config.media.enabled) app.addHook('onReady', async () => media.start());

  // Mail notifications and scheduled backups run in the server process (not in tests unless asked).
  const notifier = new Notifier(sql, media, app.log);
  const backups = new BackupService(sql, app.log, notifier, () => media.nudge());
  app.decorate('backups', backups);
  app.decorate('notifier', notifier);
  const webhooks = new WebhookDispatcher(sql, app.log);
  app.decorate('webhooks', webhooks);
  await app.register(integrationRoutes, { sql, webhooks });
  await app.register(mailRoutes, { sql });
  await app.register(backupRoutes, { sql, backups });
  if (opts.background ?? process.env.NODE_ENV === 'production') {
    app.addHook('onReady', async () => { notifier.start(); await backups.start(); provisioner.start(); scheduler.start(); live.start(); webhooks.start(); });
  }
  app.addHook('onClose', async () => { await webhooks.stop(); notifier.stop(); backups.stop(); scheduler.stop(); provisioner.stop(); await live.stop(); await media.close(); });

  if (existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false, index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.method !== 'GET') return reply.status(404).send({ error: 'not_found' });
      return reply.type('text/html').sendFile('index.html');
    });
  }
  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    backups: BackupService;
    notifier: Notifier;
    provisioner: Provisioner;
    scheduler: EventScheduler;
    media: MediaSupervisor;
    live: LiveMonitor;
    webhooks: WebhookDispatcher;
  }
}
