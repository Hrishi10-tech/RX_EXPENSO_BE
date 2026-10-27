/** Administration (SRS §7.3): users, roles, departments. Every change is audited (FR-ADM-04). */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import type { Ctx } from '../../lib/context.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { notifyFinance } from '../../lib/notify.js';
import { disconnectUser } from '../../lib/realtime.js';
import { config } from '../../config.js';
import { sendMail } from '../../lib/mailer.js';
import { istDate } from '../../lib/time.js';
import { hashPassword, revokeAll } from '../auth/service.js';

const { users, departments, trips, tripMembers, refreshTokens } = schema;

export interface UserInput {
  name: string; email: string; employeeCode: string; phone?: string | null; designation?: string | null; departmentId: string;
  isFinance?: boolean; isAdmin?: boolean; password?: string | null;
}

/** At least two people keep the Finance role, so nobody has to verify or pay their own claim (FR-VER-10, W10). */
async function keepTwoFinance(ctx: Ctx, losingId: string) {
  const rows = await ctx.tx.select({ c: sql<number>`count(*)` }).from(users).where(and(eq(users.isFinance, true), eq(users.active, true), sql`${users.id} <> ${losingId}`));
  if (Number(rows[0].c) < 2) throw conflict('finance_minimum', 'At least two people need Finance so nobody approves their own claim.');
}

const safe = (u: typeof users.$inferSelect) => {
  const { passwordHash: _p, failedLogins: _f, ...rest } = u;
  return { ...rest, hasPassword: !!u.passwordHash, signedInToApp: !!u.firstMobileLoginAt };
};

export async function listUsers(ctx: Ctx, f: { q?: string; departmentId?: string; role?: string; status?: string }) {
  const rows = await ctx.tx.select({ u: users, d: departments }).from(users).innerJoin(departments, eq(departments.id, users.departmentId))
    .where(and(
      f.q?.trim() ? sql`(${users.name} ilike ${'%' + f.q.trim() + '%'} or ${users.email} ilike ${'%' + f.q.trim() + '%'} or ${users.employeeCode} ilike ${'%' + f.q.trim() + '%'})` : sql`true`,
      f.departmentId ? eq(users.departmentId, f.departmentId) : sql`true`,
      f.role === 'finance' ? eq(users.isFinance, true) : f.role === 'admin' ? eq(users.isAdmin, true) : sql`true`,
      f.status === 'active' ? eq(users.active, true) : f.status === 'inactive' ? eq(users.active, false) : sql`true`,
    )).orderBy(asc(users.name));
  const running = await ctx.tx.select({ userId: tripMembers.userId, c: sql<number>`count(*)` }).from(tripMembers).innerJoin(trips, eq(trips.id, tripMembers.tripId))
    .where(and(eq(tripMembers.joinStatus, 'accepted'), inArray(trips.status, ['scheduled', 'active', 'extended']))).groupBy(tripMembers.userId);
  const lastSeen = await ctx.tx.select({ userId: refreshTokens.userId, client: refreshTokens.client, at: sql<Date>`max(${refreshTokens.lastUsedAt})` }).from(refreshTokens).groupBy(refreshTokens.userId, refreshTokens.client);
  return rows.map(({ u, d }) => ({
    ...safe(u), departmentName: d.name, liveTrips: Number(running.find(r => r.userId === u.id)?.c ?? 0),
    lastMobile: lastSeen.find(l => l.userId === u.id && l.client === 'mobile')?.at ?? null, lastWeb: lastSeen.find(l => l.userId === u.id && l.client === 'web')?.at ?? null,
  }));
}

async function checkUnique(ctx: Ctx, email: string, code: string, exceptId?: string) {
  const clash = await ctx.tx.select({ id: users.id, email: users.email, code: users.employeeCode }).from(users)
    .where(and(sql`(lower(${users.email}) = ${email.toLowerCase()} or ${users.employeeCode} = ${code})`, exceptId ? sql`${users.id} <> ${exceptId}` : sql`true`));
  if (clash.length) throw conflict('duplicate_user', clash[0].email.toLowerCase() === email.toLowerCase() ? 'Someone already uses that email.' : 'That employee ID is taken.');
}

export async function createUser(ctx: Ctx, input: UserInput) {
  await checkUnique(ctx, input.email, input.employeeCode);
  const dept = (await ctx.tx.select().from(departments).where(and(eq(departments.id, input.departmentId), isNull(departments.archivedAt))))[0];
  if (!dept) throw badRequest('validation', 'Pick a department.', [{ field: 'departmentId', message: 'Unknown department.' }]);
  const [u] = await ctx.tx.insert(users).values({
    name: input.name.trim(), email: input.email.trim().toLowerCase(), employeeCode: input.employeeCode.trim(), phone: input.phone?.trim() || null, designation: input.designation?.trim() || null,
    departmentId: input.departmentId, isFinance: !!input.isFinance, isAdmin: !!input.isAdmin,
    passwordHash: input.password ? await hashPassword(input.password) : null, createdAt: ctx.now, updatedAt: ctx.now,
  }).returning();
  await audit(ctx, { action: 'user.create', entity: 'user', entityId: u.id, after: safe(u) });
  return safe(u);
}

/** FR-ADM-03: a department change applies to new join requests only; trips keep their department. */
export async function updateUser(ctx: Ctx, id: string, patch: Partial<UserInput>) {
  const u = (await ctx.tx.select().from(users).where(eq(users.id, id)).for('update'))[0];
  if (!u) throw notFound('User');
  if (patch.email || patch.employeeCode) await checkUnique(ctx, patch.email ?? u.email, patch.employeeCode ?? u.employeeCode, id);
  if (patch.departmentId) {
    const dept = (await ctx.tx.select().from(departments).where(and(eq(departments.id, patch.departmentId), isNull(departments.archivedAt))))[0];
    if (!dept) throw badRequest('validation', 'Pick a department.', [{ field: 'departmentId', message: 'Unknown department.' }]);
  }
  if (patch.isAdmin === false && u.isAdmin && id === ctx.actor.id) throw conflict('self_admin', 'You cannot remove your own administrator role.');
  if (patch.isFinance === false && u.isFinance && u.active) await keepTwoFinance(ctx, id);
  const next = {
    name: patch.name?.trim() ?? u.name, email: patch.email?.trim().toLowerCase() ?? u.email, employeeCode: patch.employeeCode?.trim() ?? u.employeeCode,
    phone: patch.phone === undefined ? u.phone : patch.phone?.trim() || null, departmentId: patch.departmentId ?? u.departmentId,
    designation: patch.designation === undefined ? u.designation : patch.designation?.trim() || null,
    isFinance: patch.isFinance ?? u.isFinance, isAdmin: patch.isAdmin ?? u.isAdmin,
    ...(patch.password ? { passwordHash: await hashPassword(patch.password) } : {}),
  };
  const [n] = await ctx.tx.update(users).set({ ...next, updatedAt: ctx.now }).where(eq(users.id, id)).returning();
  const { passwordHash: _a, ...before } = u;
  const { passwordHash: _b, ...after } = n;
  await audit(ctx, { action: u.departmentId !== n.departmentId ? 'user.department' : (u.isFinance !== n.isFinance || u.isAdmin !== n.isAdmin) ? 'user.roles' : 'user.update', entity: 'user', entityId: id, before, after, meta: patch.password ? { passwordReset: true } : {} });
  return safe(n);
}

/** What deactivating someone touches, listed before confirming (W10·b). */
export async function deactivationImpact(ctx: Ctx, id: string) {
  const owned = await ctx.tx.select({ id: trips.id, ref: trips.ref, name: trips.name, status: trips.status }).from(trips).where(and(eq(trips.ownerId, id), inArray(trips.status, ['scheduled', 'active', 'extended'])));
  const running = await ctx.tx.select({ id: trips.id, ref: trips.ref, name: trips.name }).from(tripMembers).innerJoin(trips, eq(trips.id, tripMembers.tripId))
    .where(and(eq(tripMembers.userId, id), eq(tripMembers.joinStatus, 'accepted'), sql`${tripMembers.actualStart} is not null and ${tripMembers.actualEnd} is null`));
  const claims = await ctx.tx.select({ c: sql<number>`count(*)` }).from(tripMembers).where(and(eq(tripMembers.userId, id), eq(tripMembers.joinStatus, 'accepted'), inArray(tripMembers.claimStatus, ['open', 'ready', 'verified', 'part_paid'])));
  return { ownedLiveTrips: owned, runningTrips: running, openClaims: Number(claims[0].c) };
}

/** FR-ROLE-08: access ends at once; trips, expenses and claims stay for finance. */
export async function deactivate(ctx: Ctx, id: string, reason?: string | null) {
  if (id === ctx.actor.id) throw conflict('self_deactivate', 'You cannot deactivate your own account.');
  const u = (await ctx.tx.select().from(users).where(eq(users.id, id)))[0];
  if (!u) throw notFound('User');
  if (!u.active) return safe(u);
  if (u.isFinance) await keepTwoFinance(ctx, id);
  const impact = await deactivationImpact(ctx, id);
  const [n] = await ctx.tx.update(users).set({ active: false, deactivatedAt: ctx.now, updatedAt: ctx.now }).where(eq(users.id, id)).returning();
  await ctx.tx.update(tripMembers).set({ joinStatus: 'withdrawn', updatedAt: ctx.now }).where(and(eq(tripMembers.userId, id), eq(tripMembers.joinStatus, 'invited')));
  await audit(ctx, { action: 'user.deactivate', entity: 'user', entityId: id, before: { active: true }, after: { active: false }, meta: { reason: reason?.trim() || null, ownedLiveTrips: impact.ownedLiveTrips.map(t => t.ref) } });
  for (const t of impact.ownedLiveTrips) {
    await notifyFinance(ctx, { type: 'trip.owner_inactive', tripId: t.id, title: `${t.ref} needs a new owner`, body: `${u.name}'s account was deactivated. Assign a new owner from the trip page.`, data: { tripId: t.id } });
  }
  ctx.after.push(async () => { await revokeAll(id); disconnectUser(id); });
  return { ...safe(n), impact };
}

export async function reactivate(ctx: Ctx, id: string) {
  const u = (await ctx.tx.select().from(users).where(eq(users.id, id)))[0];
  if (!u) throw notFound('User');
  const [n] = await ctx.tx.update(users).set({ active: true, deactivatedAt: null, updatedAt: ctx.now }).where(eq(users.id, id)).returning();
  await audit(ctx, { action: 'user.reactivate', entity: 'user', entityId: id, before: { active: u.active }, after: { active: true } });
  return safe(n);
}

export async function listDepartments(ctx: Ctx) {
  const rows = await ctx.tx.select().from(departments).orderBy(asc(departments.name));
  const counts = await ctx.tx.select({ d: users.departmentId, c: sql<number>`count(*)` }).from(users).where(eq(users.active, true)).groupBy(users.departmentId);
  const live = await ctx.tx.select({ d: trips.departmentId, c: sql<number>`count(*)` }).from(trips).where(inArray(trips.status, ['scheduled', 'active', 'extended'])).groupBy(trips.departmentId);
  const yearStart = istDate(ctx.now).slice(0, 4) + '-01-01';
  const year = await ctx.tx.select({ d: trips.departmentId, c: sql<number>`count(*)` }).from(trips)
    .where(sql`(${trips.createdAt} at time zone 'Asia/Kolkata')::date >= ${yearStart}::date`).groupBy(trips.departmentId);
  return rows.map(r => ({
    ...r, userCount: Number(counts.find(c => c.d === r.id)?.c ?? 0), liveTrips: Number(live.find(c => c.d === r.id)?.c ?? 0),
    tripsThisYear: Number(year.find(c => c.d === r.id)?.c ?? 0),
  }));
}

/** W10 "Send app link": email the install link and sign-in steps to someone who has not signed in to the app yet. */
export async function sendAppLink(ctx: Ctx, id: string) {
  const u = (await ctx.tx.select().from(users).where(eq(users.id, id)))[0];
  if (!u) throw notFound('User');
  if (!u.active) throw conflict('inactive', 'This account is deactivated.');
  if (u.firstMobileLoginAt) throw conflict('already_signed_in', `${u.name} has already signed in to the app.`);
  await audit(ctx, { action: 'user.app_link', entity: 'user', entityId: id, meta: { email: u.email } });
  ctx.after.push(() => sendMail({
    to: u.email, subject: 'Get the Expenso app',
    text: `Hello ${u.name.split(' ')[0]},\n\nExpenso is how Xelements records trip expenses. Install the app from ${config.APP_DOWNLOAD_URL} and sign in with ${u.email}; ` +
      `you can ask for a one-time code on the sign-in screen.\n\nOnce you have signed in, colleagues can add you to their trips.\n\n${ctx.actor.name}`,
  }));
}

export async function createDepartment(ctx: Ctx, name: string) {
  const clash = await ctx.tx.select().from(departments).where(sql`lower(${departments.name}) = ${name.trim().toLowerCase()}`);
  if (clash.length) throw conflict('duplicate_department', 'A department with that name exists.');
  const [d] = await ctx.tx.insert(departments).values({ name: name.trim(), createdAt: ctx.now, updatedAt: ctx.now }).returning();
  await audit(ctx, { action: 'department.create', entity: 'department', entityId: d.id, after: d });
  return d;
}

export async function updateDepartment(ctx: Ctx, id: string, patch: { name?: string; archived?: boolean }) {
  const d = (await ctx.tx.select().from(departments).where(eq(departments.id, id)))[0];
  if (!d) throw notFound('Department');
  if (patch.archived) {
    const n = await ctx.tx.select({ c: sql<number>`count(*)` }).from(users).where(and(eq(users.departmentId, id), eq(users.active, true)));
    if (Number(n[0].c) > 0) throw conflict('department_in_use', 'Move its active people to another department first.');
  }
  if (patch.name) {
    const clash = await ctx.tx.select().from(departments).where(and(sql`lower(${departments.name}) = ${patch.name.trim().toLowerCase()}`, sql`${departments.id} <> ${id}`));
    if (clash.length) throw conflict('duplicate_department', 'A department with that name exists.');
  }
  const [n] = await ctx.tx.update(departments).set({ name: patch.name?.trim() ?? d.name, archivedAt: patch.archived === undefined ? d.archivedAt : patch.archived ? ctx.now : null, updatedAt: ctx.now }).where(eq(departments.id, id)).returning();
  await audit(ctx, { action: 'department.update', entity: 'department', entityId: id, before: d, after: n });
  return n;
}
