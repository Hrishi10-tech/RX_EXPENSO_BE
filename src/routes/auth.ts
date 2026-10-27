import { Router } from 'express';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/client.js';
import { me, requireAuth } from '../lib/auth.js';
import { parse } from '../lib/http.js';
import * as auth from '../modules/auth/service.js';

export const authRouter = Router();
const zClient = z.enum(['mobile', 'web']);

authRouter.post('/auth/login', async (req, res) => {
  const b = parse(z.object({ email: z.string().trim().min(3), password: z.string().min(1), client: zClient, deviceLabel: z.string().max(120).optional() }), req.body);
  res.json(await auth.login(b.email, b.password, b.client, b.deviceLabel ?? null));
});

authRouter.post('/auth/otp/request', async (req, res) => {
  const b = parse(z.object({ email: z.string().trim().min(3) }), req.body);
  res.json(await auth.requestOtp(b.email));
});

authRouter.post('/auth/otp/verify', async (req, res) => {
  const b = parse(z.object({ email: z.string().trim().min(3), code: z.string().regex(/^\d{6}$/), client: zClient, deviceLabel: z.string().max(120).optional() }), req.body);
  res.json(await auth.verifyOtp(b.email, b.code, b.client, b.deviceLabel ?? null));
});

authRouter.post('/auth/refresh', async (req, res) => {
  const b = parse(z.object({ refreshToken: z.string().min(20) }), req.body);
  res.json(await auth.refresh(b.refreshToken));
});

authRouter.post('/auth/logout', async (req, res) => {
  const b = parse(z.object({ refreshToken: z.string().min(20) }), req.body);
  await auth.logout(b.refreshToken);
  res.status(204).end();
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const u = (await db.select().from(schema.users).where(eq(schema.users.id, me(req).id)))[0];
  res.json(await auth.profile(u));
});

authRouter.patch('/me/settings', requireAuth, async (req, res) => {
  const b = parse(z.object({ dailyDigest: z.boolean().optional(), theme: z.enum(['light', 'dark', 'system']).optional(), notificationPrefs: z.record(z.string(), z.boolean()).optional() }), req.body);
  const uid = me(req).id;
  const cur = (await db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, uid)))[0];
  const next = { dailyDigest: b.dailyDigest ?? cur?.dailyDigest ?? false, theme: b.theme ?? cur?.theme ?? 'system', notificationPrefs: { ...((cur?.notificationPrefs as object) ?? {}), ...(b.notificationPrefs ?? {}) }, updatedAt: new Date() };
  await db.insert(schema.userSettings).values({ userId: uid, ...next }).onConflictDoUpdate({ target: schema.userSettings.userId, set: next });
  res.json(next);
});

authRouter.post('/me/password', requireAuth, async (req, res) => {
  const b = parse(z.object({ currentPassword: z.string().default(''), newPassword: z.string().min(8, 'Use at least 8 characters.') }), req.body);
  await auth.changePassword(me(req).id, b.currentPassword, b.newPassword);
  res.status(204).end();
});

/** Colleagues the member can invite before the trip exists (M03 to M04, offline creation). */
authRouter.get('/me/colleagues', requireAuth, async (req, res) => {
  const u = me(req);
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const rows = await db.select({ id: schema.users.id, name: schema.users.name, code: schema.users.employeeCode, first: schema.users.firstMobileLoginAt, designation: schema.users.designation })
    .from(schema.users).where(and(eq(schema.users.departmentId, u.departmentId!), eq(schema.users.active, true))).orderBy(asc(schema.users.name));
  res.json(rows.filter(r => r.id !== u.id && (!q || r.name.toLowerCase().includes(q)))
    .map(r => ({ userId: r.id, name: r.name, employeeCode: r.code, designation: r.designation, signedIn: !!r.first, selectable: !!r.first })));
});

authRouter.post('/me/device-tokens', requireAuth, async (req, res) => {
  const b = parse(z.object({ platform: z.enum(['android', 'ios', 'web']), token: z.string().min(10) }), req.body);
  await db.insert(schema.deviceTokens).values({ userId: me(req).id, platform: b.platform, token: b.token })
    .onConflictDoUpdate({ target: schema.deviceTokens.token, set: { userId: me(req).id, platform: b.platform, updatedAt: new Date() } });
  res.status(204).end();
});
