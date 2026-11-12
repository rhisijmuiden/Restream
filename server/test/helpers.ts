import { generate } from 'otplib';
import type { FastifyInstance } from 'fastify';
import { createDb, type Sql } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/lib/password.js';

export async function setup() {
  const sql = createDb();
  await sql`DROP SCHEMA public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await migrate(sql);
  const app = await buildApp(sql, { logger: false });
  return { sql, app };
}

export async function addUser(sql: Sql, email: string, password: string, role = 'admin') {
  await sql`INSERT INTO users (email, role, password_hash) VALUES (${email}, ${role}, ${await hashPassword(password)})`;
}

/** Minimal cookie-jar client around app.inject. */
export class Client {
  cookie = '';
  constructor(private app: FastifyInstance) {}
  async req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.inject({
      method: method as 'GET',
      url,
      payload: body as object,
      headers: { 'x-restream': '1', ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
    });
    const set = res.cookies.find((c) => c.name === 'restream_session');
    if (set) this.cookie = set.value ? `restream_session=${set.value}` : '';
    return res;
  }
  get = (url: string) => this.req('GET', url);
  post = (url: string, body: unknown = {}) => this.req('POST', url, body);
}

/** Logs in and enrols TOTP; returns the secret. */
export async function loginWithEnrolment(c: Client, email: string, password: string) {
  const r = await c.post('/api/auth/login', { email, password });
  if (r.json().next !== 'mfa_setup') throw new Error(`unexpected ${r.body}`);
  const { secret } = (await c.post('/api/auth/mfa/setup')).json();
  const code = await generate({ secret });
  const conf = await c.post('/api/auth/mfa/setup/confirm', { code });
  if (conf.statusCode !== 200) throw new Error(conf.body);
  return { secret, recoveryCodes: conf.json().recoveryCodes as string[] };
}
