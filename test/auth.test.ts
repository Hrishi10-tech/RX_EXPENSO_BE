import { beforeAll, describe, expect, it } from 'vitest';
import { DEMO_PASSWORD, emailOf, seed } from '../src/db/seed.js';
import { api, as, login } from './helpers.js';

beforeAll(async () => { await seed({ exports: false, quiet: true, tinyReceipts: true }); });

describe('sign-in (M01, W01, NFR-06)', () => {
  it('signs in with a password and returns the profile with roles', async () => {
    const r = await api().post('/api/v1/auth/login').send({ email: emailOf('arjun'), password: DEMO_PASSWORD, client: 'mobile' });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ name: 'Arjun Mehta', departmentName: 'Sales', roles: ['employee'] });
    expect(r.body.expiresIn).toBe(900);
    const me = await api().get('/api/v1/me').set('Authorization', `Bearer ${r.body.accessToken}`);
    expect(me.body.email).toBe(emailOf('arjun'));
  });

  it('keeps employees out of the finance console', async () => {
    const r = await api().post('/api/v1/auth/login').send({ email: emailOf('arjun'), password: DEMO_PASSWORD, client: 'web' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('web_role_required');
  });

  it('locks password sign-in after five wrong attempts, while a one-time code still works', async () => {
    for (let i = 0; i < 4; i++) {
      const r = await api().post('/api/v1/auth/login').send({ email: emailOf('priya'), password: 'wrong-password', client: 'mobile' });
      expect(r.status).toBe(401);
      expect(r.body.error.details.attemptsLeft).toBe(4 - i);
    }
    const locked = await api().post('/api/v1/auth/login').send({ email: emailOf('priya'), password: 'wrong-password', client: 'mobile' });
    expect(locked.status).toBe(423);
    const right = await api().post('/api/v1/auth/login').send({ email: emailOf('priya'), password: DEMO_PASSWORD, client: 'mobile' });
    expect(right.status).toBe(423);
    const otp = await api().post('/api/v1/auth/otp/request').send({ email: emailOf('priya') });
    expect(otp.body.devCode).toMatch(/^\d{6}$/);
    const bad = await api().post('/api/v1/auth/otp/verify').send({ email: emailOf('priya'), code: otp.body.devCode === '000000' ? '111111' : '000000', client: 'mobile' });
    expect(bad.status).toBe(401);
    const ok = await api().post('/api/v1/auth/otp/verify').send({ email: emailOf('priya'), code: otp.body.devCode, client: 'mobile' });
    expect(ok.status).toBe(200);
  });

  it('never reveals whether an email exists', async () => {
    const r = await api().post('/api/v1/auth/otp/request').send({ email: 'nobody@xelements.test' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ sent: true });
  });

  it('rotates refresh tokens and refuses a used one', async () => {
    const s = await login('rohan', 'mobile', true);
    const r1 = await api().post('/api/v1/auth/refresh').send({ refreshToken: s.refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(s.refreshToken);
    const again = await api().post('/api/v1/auth/refresh').send({ refreshToken: s.refreshToken });
    expect(again.status).toBe(401);
    const out = await api().post('/api/v1/auth/logout').send({ refreshToken: r1.body.refreshToken });
    expect(out.status).toBe(204);
    const after = await api().post('/api/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken });
    expect(after.status).toBe(401);
  });

  it('refuses a deactivated account (FR-ROLE-08)', async () => {
    const r = await api().post('/api/v1/auth/login').send({ email: emailOf('nikhil'), password: DEMO_PASSWORD, client: 'mobile' });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('deactivated');
  });

  it('gives administrators the admin console but no expense data', async () => {
    const farah = as(await login('farah', 'web'));
    expect((await farah.get('/admin/users')).status).toBe(200);
    const fin = await farah.get('/finance/dashboard');
    expect(fin.status).toBe(403);
    expect(fin.body.error.code).toBe('finance_only');
  });

  it('keeps admin endpoints from finance users who are not administrators', async () => {
    const meera = as(await login('meera', 'web'));
    expect((await meera.get('/admin/users')).status).toBe(403);
  });
});
