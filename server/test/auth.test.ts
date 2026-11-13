import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generate } from 'otplib';
import { Client, addUser, loginWithEnrolment, setup } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { ctx = await setup(); await addUser(ctx.sql, 'admin@example.com', 'correct horse battery'); });
afterAll(async () => { await ctx.app.close(); await ctx.sql.end(); });

describe('authentication', () => {
  it('rejects wrong passwords and unknown users alike', async () => {
    const c = new Client(ctx.app);
    expect((await c.post('/api/auth/login', { email: 'admin@example.com', password: 'nope' })).statusCode).toBe(401);
    expect((await c.post('/api/auth/login', { email: 'ghost@example.com', password: 'nope' })).statusCode).toBe(401);
  });

  it('forces 2FA enrolment before anything else is reachable', async () => {
    const c = new Client(ctx.app);
    const r = await c.post('/api/auth/login', { email: 'admin@example.com', password: 'correct horse battery' });
    expect(r.json()).toEqual({ next: 'mfa_setup' });
    expect((await c.get('/api/system/info')).statusCode).toBe(401);
    expect((await c.get('/api/auth/me')).json().stage).toBe('mfa_setup');
  });

  it('enrols TOTP, then requires the code on the next login', async () => {
    const c = new Client(ctx.app);
    const { secret, recoveryCodes } = await loginWithEnrolment(c, 'admin@example.com', 'correct horse battery');
    expect(recoveryCodes).toHaveLength(10);
    expect((await c.get('/api/system/info')).statusCode).toBe(200);

    const c2 = new Client(ctx.app);
    expect((await c2.post('/api/auth/login', { email: 'admin@example.com', password: 'correct horse battery' })).json()).toEqual({ next: 'mfa' });
    expect((await c2.post('/api/auth/mfa', { code: '000000' })).statusCode).toBe(401);
    // A code already used (same time step as enrolment) is refused: replay protection.
    const used = await generate({ secret });
    expect((await c2.post('/api/auth/mfa', { code: used })).statusCode).toBe(401);
    // Recovery codes work once.
    expect((await c2.post('/api/auth/mfa', { code: recoveryCodes[0] })).statusCode).toBe(200);
    expect((await c2.get('/api/auth/me')).json().user.recovery_left).toBe(9);
    const c3 = new Client(ctx.app);
    await c3.post('/api/auth/login', { email: 'admin@example.com', password: 'correct horse battery' });
    expect((await c3.post('/api/auth/mfa', { code: recoveryCodes[0] })).statusCode).toBe(401);
  });

  it('blocks state-changing requests without the CSRF header', async () => {
    const c = new Client(ctx.app);
    const r = await c.req('POST', '/api/auth/login', { email: 'a@b.c', password: 'x' }, { 'x-restream': '0' });
    expect(r.statusCode).toBe(403);
  });

  it('remembers the colour theme per user', async () => {
    await addUser(ctx.sql, 'theme@example.com', 'correct horse battery', 'viewer');
    const c = new Client(ctx.app);
    await loginWithEnrolment(c, 'theme@example.com', 'correct horse battery');
    expect((await c.get('/api/auth/me')).json().user.theme).toBe('dark');
    expect((await c.req('PATCH', '/api/auth/me', { theme: 'light' })).statusCode).toBe(200);
    expect((await c.get('/api/auth/me')).json().user.theme).toBe('light');
    expect((await c.req('PATCH', '/api/auth/me', { theme: 'system' })).statusCode).toBe(200);
    expect((await c.get('/api/auth/me')).json().user.theme).toBe('system');
    expect((await c.req('PATCH', '/api/auth/me', { theme: 'purple' })).statusCode).toBe(400);
    // Changing only the language keeps the theme.
    await c.req('PATCH', '/api/auth/me', { language: 'nl' });
    expect((await c.get('/api/auth/me')).json().user).toMatchObject({ theme: 'system', language: 'nl' });
  });

  it('logs out', async () => {
    const c = new Client(ctx.app);
    await c.post('/api/auth/login', { email: 'admin@example.com', password: 'correct horse battery' });
    await c.post('/api/auth/logout');
    expect((await c.get('/api/auth/me')).json().user).toBeNull();
  });
});
