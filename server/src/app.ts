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
import { HttpError } from './lib/guards.js';
import { authRoutes } from './routes/auth.js';
import { ssoRoutes } from './routes/sso.js';
import { userRoutes } from './routes/users.js';
import { systemRoutes } from './routes/system.js';
import { settingsRoutes } from './routes/settings.js';
import { streamRoutes } from './routes/streams.js';
import { mediaRoutes } from './routes/media.js';
import { MediaSupervisor } from './media/supervisor.js';

export async function buildApp(sql: Sql, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
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

  app.decorateRequest('session', null);
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    // Called by MediaMTX on this machine; the route itself refuses anything that is not local.
    if (req.url.startsWith('/api/internal/')) return;
    // CSRF defence in depth (cookies are SameSite=Strict): state changing calls need a custom header,
    // which browsers only send from same-origin scripts.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-restream'] !== '1') {
      throw new HttpError(403, 'csrf');
    }
    await loadSession(sql, req);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: 'validation', issues: err.issues });
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code });
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
  await app.register(streamRoutes, { sql, media });
  await app.register(mediaRoutes, { sql });
  if (config.media.enabled) app.addHook('onReady', async () => media.start());
  app.addHook('onClose', async () => media.close());

  if (existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false, index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.method !== 'GET') return reply.status(404).send({ error: 'not_found' });
      return reply.type('text/html').sendFile('index.html');
    });
  }
  return app;
}
