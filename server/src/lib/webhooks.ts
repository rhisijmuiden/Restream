import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Sql } from '../db.js';
import { config, readBuildInfo } from '../config.js';
import { decrypt, randomToken } from './crypto.js';
import { bus, type BusEvent } from './events.js';
import { getSettings } from './settings.js';

/** Retry delays in seconds after a failed delivery; after the last one the delivery is marked failed. */
export const retryDelays = [30, 120, 600, 1800, 7200, 21600];

export const newWebhookSecret = () => `whsec_${randomToken(24)}`;

const blocked = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['169.254.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 128], ['fe80::', 10], ['ff00::', 8]] as const) blocked.addSubnet(net, bits, 'ipv6');
const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

/** True when Restream must not call this address: this machine, link-local (cloud metadata), multicast or unspecified. */
export function addressBlocked(addr: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  const a = mapped ? mapped[1] : addr;
  const family = isIP(a) === 6 ? 'ipv6' : 'ipv4';
  if (blocked.check(a, family)) return true;
  return !config.webhooks.allowLoopback && loopback.check(a, family);
}

/** Returns an error code when the webhook URL cannot be used, otherwise null. */
export function webhookUrlProblem(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return 'invalid_url'; }
  if (!['http:', 'https:'].includes(u.protocol) || !u.hostname || u.username || u.password) return 'invalid_url';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && addressBlocked(host)) return 'url_not_allowed';
  if (!config.webhooks.allowLoopback && /^localhost\.?$/i.test(host)) return 'url_not_allowed';
  return null;
}

/** DNS lookup that refuses blocked addresses, so a hostname cannot point Restream at itself (also not by DNS rebinding). */
const safeLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 4);
    const list = addresses as dns.LookupAddress[];
    if (!list.length || list.some((a) => addressBlocked(a.address))) {
      return callback(Object.assign(new Error(`address of ${hostname} is not allowed`), { code: 'EADDRNOTALLOWED' }), '', 4);
    }
    if ((options as dns.LookupAllOptions).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

export interface SendResult { ok: boolean; status: number | null; error: string | null; durationMs: number }

/** Signature header value: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">. */
export function sign(secret: string, body: string, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

/** Posts a signed JSON body. Redirects are not followed. */
export function postSigned(url: string, body: string, secret: string, headers: Record<string, string>): Promise<SendResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const done = (r: Omit<SendResult, 'durationMs'>) => resolve({ ...r, durationMs: Date.now() - started });
    const problem = webhookUrlProblem(url);
    if (problem) return done({ ok: false, status: null, error: problem });
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'POST',
      lookup: safeLookup,
      timeout: config.webhooks.timeoutMs,
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        'user-agent': `Restream-Webhooks/${readBuildInfo().version}`,
        'x-restream-signature': sign(secret, body),
        ...headers,
      },
    }, (res) => {
      let size = 0;
      res.on('data', (c: Buffer) => { size += c.length; if (size > 64 * 1024) res.destroy(); });
      res.on('close', () => {
        const status = res.statusCode ?? 0;
        done({ ok: status >= 200 && status < 300, status, error: status >= 200 && status < 300 ? null : `HTTP ${status}` });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => done({ ok: false, status: null, error: err.message.slice(0, 300) }));
    req.end(body);
  });
}

interface DeliveryRow {
  id: string; webhook_id: string; event_id: string; event: string; payload: unknown; attempts: number;
  url: string; secret_enc: string; enabled: boolean;
}

/**
 * Turns events from the bus into webhook deliveries (stored, so they survive a restart) and sends them
 * with retries: 30 s, 2 min, 10 min, 30 min, 2 h and 6 h after a failure.
 */
export class WebhookDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private closed = false;
  private lastCleanup = 0;
  private pending = new Set<Promise<unknown>>();
  private listener = (ev: BusEvent) => { this.track(this.enqueue(ev).then(() => this.kick())); };

  constructor(private sql: Sql, private log: FastifyBaseLogger) {}

  start(intervalMs = 2000) {
    if (this.timer) return;
    bus.on('event', this.listener);
    const loop = async () => {
      await this.kick();
      if (!this.closed) { this.timer = setTimeout(loop, intervalMs); this.timer.unref(); }
    };
    this.timer = setTimeout(loop, 0);
  }

  async stop() {
    this.closed = true;
    bus.off('event', this.listener);
    if (this.timer) clearTimeout(this.timer);
    await Promise.all([...this.pending]);
    await this.running;
  }

  private track(p: Promise<unknown>) {
    const w = p.catch((err) => this.log.warn({ err }, 'webhook bookkeeping failed')).finally(() => this.pending.delete(w));
    this.pending.add(w);
  }

  /** Waits until queued events are stored and due deliveries are sent (tests). */
  async flush() {
    await Promise.all([...this.pending]);
    await this.kick();
  }

  /** Stores one delivery per webhook that wants this event. Returns the delivery ids. */
  async enqueue(ev: BusEvent, onlyWebhook?: string): Promise<string[]> {
    const hooks = onlyWebhook
      ? await this.sql<{ id: string }[]>`SELECT id FROM webhooks WHERE id = ${onlyWebhook}`
      : await this.sql<{ id: string }[]>`
          SELECT id FROM webhooks WHERE enabled AND (cardinality(events) = 0 OR ${ev.type} = ANY(events))`;
    if (!hooks.length) return [];
    const s = await getSettings(this.sql);
    const payload = { id: ev.id, type: ev.type, createdAt: ev.createdAt, instance: { name: s.instanceName, url: s.publicUrl || null }, data: ev.data };
    const ids: string[] = [];
    for (const h of hooks) {
      const [row] = await this.sql<{ id: string }[]>`
        INSERT INTO webhook_deliveries (webhook_id, event_id, event, payload)
        VALUES (${h.id}, ${ev.id}, ${ev.type}, ${this.sql.json(payload as never)}) RETURNING id`;
      ids.push(row.id);
    }
    return ids;
  }

  /** Sends the deliveries that are due now. */
  kick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.runDue().catch((err) => { this.log.error({ err }, 'webhook pass failed'); }).finally(() => { this.running = null; });
    return this.running;
  }

  private async runDue() {
    if (Date.now() - this.lastCleanup > 3600_000) {
      this.lastCleanup = Date.now();
      await this.sql`DELETE FROM webhook_deliveries WHERE created_at < now() - interval '14 days'`;
    }
    for (let round = 0; round < 10; round++) {
      const due = await this.sql<DeliveryRow[]>`
        SELECT d.id, d.webhook_id, d.event_id, d.event, d.payload, d.attempts, w.url, w.secret_enc, w.enabled
        FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
        WHERE d.status = 'pending' AND d.next_attempt_at <= now()
        ORDER BY d.next_attempt_at LIMIT 20`;
      if (!due.length) return;
      // Different webhooks in parallel, but at most four requests at a time.
      for (let i = 0; i < due.length; i += 4) await Promise.all(due.slice(i, i + 4).map((d) => this.deliver(d)));
    }
  }

  async deliver(d: DeliveryRow): Promise<SendResult> {
    const body = JSON.stringify(d.payload);
    const r = d.enabled || d.event === 'ping'
      ? await postSigned(d.url, body, decrypt(d.secret_enc), { 'x-restream-event': d.event, 'x-restream-delivery': d.id, 'x-restream-event-id': d.event_id })
      : { ok: false, status: null, error: 'webhook_disabled', durationMs: 0 };
    const attempts = d.attempts + 1;
    const retry = !r.ok && d.enabled && attempts <= retryDelays.length && d.event !== 'ping';
    await this.sql`
      UPDATE webhook_deliveries SET attempts = ${attempts}, response_code = ${r.status}, error = ${r.error}, duration_ms = ${r.durationMs},
             status = ${r.ok ? 'delivered' : retry ? 'pending' : 'failed'},
             next_attempt_at = now() + make_interval(secs => ${retry ? retryDelays[attempts - 1] : 0}),
             delivered_at = ${r.ok ? new Date() : null}
      WHERE id = ${d.id}`;
    if (!r.ok) this.log.info({ webhook: d.webhook_id, delivery: d.id, event: d.event, attempts, error: r.error }, 'webhook delivery failed');
    return r;
  }

  /** Sends a "ping" to one webhook right away and returns the result. */
  async test(webhookId: string): Promise<SendResult & { deliveryId: string }> {
    const [id] = await this.enqueue({ id: randomUUID(), type: 'ping', createdAt: new Date().toISOString(), data: { message: 'Webhook test from Restream' } }, webhookId);
    const [d] = await this.sql<DeliveryRow[]>`
      SELECT d.id, d.webhook_id, d.event_id, d.event, d.payload, d.attempts, w.url, w.secret_enc, w.enabled
      FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.id = ${id}`;
    return { ...(await this.deliver(d)), deliveryId: id };
  }

  /** Queues a delivery again (with the same event id, so the receiver can recognise it). */
  async redeliver(deliveryId: string): Promise<string | null> {
    const [row] = await this.sql<{ id: string }[]>`
      INSERT INTO webhook_deliveries (webhook_id, event_id, event, payload)
      SELECT webhook_id, event_id, event, payload FROM webhook_deliveries WHERE id = ${deliveryId}
      RETURNING id`;
    if (row) void this.kick();
    return row?.id ?? null;
  }
}
