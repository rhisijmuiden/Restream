import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client, addUser, loginWithEnrolment, setup } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
let admin: Client;
beforeAll(async () => {
  ctx = await setup();
  await addUser(ctx.sql, 'admin@example.com', 'correct horse battery');
  admin = new Client(ctx.app);
  await loginWithEnrolment(admin, 'admin@example.com', 'correct horse battery');
});
afterAll(async () => { await ctx.app.close(); await ctx.sql.end(); });

describe('users', () => {
  let id = '';
  let temp = '';
  it('creates a user with a temporary password', async () => {
    const r = await admin.post('/api/users', { email: 'tech@example.com', name: 'Tech', role: 'operator' });
    expect(r.statusCode).toBe(200);
    ({ id, temporaryPassword: temp } = r.json());
    expect((await admin.post('/api/users', { email: 'TECH@example.com', role: 'viewer' })).statusCode).toBe(409);
  });

  it('makes the new user change the password and keeps them out of admin routes', async () => {
    const c = new Client(ctx.app);
    await loginWithEnrolment(c, 'tech@example.com', temp);
    expect((await c.get('/api/system/info')).json().error).toBe('password_change_required');
    expect((await c.post('/api/auth/password', { current: temp, next: 'short' })).json().error).toBe('password_too_short');
    expect((await c.post('/api/auth/password', { current: temp, next: 'a much longer password' })).statusCode).toBe(200);
    expect((await c.get('/api/system/info')).statusCode).toBe(200);
    expect((await c.get('/api/users')).statusCode).toBe(403);
  });

  it('protects the last admin', async () => {
    const me = (await admin.get('/api/auth/me')).json().user.id;
    expect((await admin.req('DELETE', `/api/users/${me}`)).json().error).toBe('cannot_delete_self');
    expect((await admin.req('PATCH', `/api/users/${me}`, { role: 'viewer' })).statusCode).toBe(400);
  });

  it('resets 2FA and deletes users', async () => {
    expect((await admin.post(`/api/users/${id}/reset-2fa`)).statusCode).toBe(200);
    const [u] = await ctx.sql`SELECT totp_enabled FROM users WHERE id = ${id}`;
    expect(u.totp_enabled).toBe(false);
    expect((await admin.req('DELETE', `/api/users/${id}`)).statusCode).toBe(200);
  });

  it('records an audit trail', async () => {
    const rows = (await admin.get('/api/audit')).json();
    expect(rows.map((r: { action: string }) => r.action)).toContain('user.created');
  });
});

describe('settings', () => {
  it('never returns secrets', async () => {
    const put = await admin.req('PUT', '/api/settings', {
      instanceName: 'Studio',
      publicUrl: 'https://stream.example.com/',
      githubToken: 'ghp_secret',
      sso: { enabled: true, tenantId: 'contoso.onmicrosoft.com', clientId: 'abc', clientSecret: 'shh', allowedGroupId: '', autoProvision: true, defaultRole: 'operator' },
    });
    expect(put.statusCode).toBe(200);
    const s = (await admin.get('/api/settings')).json();
    expect(s.instanceName).toBe('Studio');
    expect(s.sso.clientSecretSet).toBe(true);
    expect(s.sso.redirectUri).toBe('https://stream.example.com/api/auth/sso/microsoft/callback');
    expect(JSON.stringify(s)).not.toContain('shh');
    expect(JSON.stringify(s)).not.toContain('ghp_secret');
    expect((await new Client(ctx.app).get('/api/auth/me')).json().ssoEnabled).toBe(true);
  });
});

describe('system', () => {
  it('reports version info', async () => {
    const r = (await admin.get('/api/system/info')).json();
    expect(r.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(['production', 'test']).toContain(r.channel);
  });

  it('queues an update request for the updater', async () => {
    const r = await admin.post('/api/system/update', { channel: 'test' });
    expect(r.statusCode).toBe(200);
    const file = path.join(process.env.UPDATE_REQUEST_DIR!, 'request.json');
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).channel).toBe('test');
    expect((await admin.get('/api/system/update/status')).json().state).toBe('queued');
    expect((await admin.post('/api/system/update', { channel: 'production' })).statusCode).toBe(409);
    expect((await admin.post('/api/system/update', { channel: 'evil; rm -rf /' })).statusCode).toBe(400);
  });
});
