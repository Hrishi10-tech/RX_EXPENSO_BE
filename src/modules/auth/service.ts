/** Sign-in for both apps (M01, W01): password or emailed one-time code; rotating refresh tokens (NFR-06). */
import crypto from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { config } from '../../config.js';
import { db, schema } from '../../db/client.js';
import { actorFromUser, newOpaqueToken, REFRESH_TTL_MS, sha256, signAccess, type Client } from '../../lib/auth.js';
import { AppError, forbidden, unauthorized } from '../../lib/errors.js';
import { log } from '../../lib/logger.js';
import { sendMail } from '../../lib/mailer.js';
import { minutes } from '../../lib/time.js';

const { users, refreshTokens, otpCodes, departments, userSettings } = schema;
const MAX_ATTEMPTS = 5;
const LOCK_MS = minutes(15);

export const hashPassword = (p: string) => hash(p, { memoryCost: 19456, timeCost: 2, parallelism: 1 });

type UserRow = typeof users.$inferSelect;

async function findByEmail(email: string) {
  return (await db.select().from(users).where(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`))[0];
}

/** Who a deactivated person should contact (M01·d): the configured contact, else the first active administrator. */
export async function supportContact() {
  if (config.SUPPORT_CONTACT_NAME || config.SUPPORT_CONTACT_EMAIL) return { name: config.SUPPORT_CONTACT_NAME ?? null, email: config.SUPPORT_CONTACT_EMAIL ?? null };
  const a = (await db.select({ name: users.name, email: users.email }).from(users).where(and(eq(users.isAdmin, true), eq(users.active, true))).orderBy(users.name).limit(1))[0];
  return a ? { name: a.name, email: a.email } : null;
}
export async function deactivatedError(message = 'This account is no longer active. Trips and claims you logged stay with finance.') {
  return new AppError(401, 'deactivated', message, { contact: await supportContact() });
}

function assertCanSignIn(u: UserRow | undefined, client: Client, now: Date): asserts u is UserRow {
  if (!u) throw new AppError(401, 'invalid_credentials', 'Email or password doesn’t match.');
  if (u.lockedUntil && u.lockedUntil > now) throw new AppError(423, 'locked', 'Too many wrong attempts. Try again later or use a one-time code.', { lockedUntil: u.lockedUntil });
  if (client === 'web' && !u.isFinance && !u.isAdmin) throw forbidden('This is the finance console. Employees use the Expenso mobile app.', 'web_role_required');
}

export async function issueTokens(u: UserRow, client: Client, deviceLabel: string | null, now = new Date()) {
  const refresh = newOpaqueToken();
  await db.insert(refreshTokens).values({ userId: u.id, tokenHash: sha256(refresh), client, deviceLabel, createdAt: now, lastUsedAt: now, expiresAt: new Date(now.getTime() + REFRESH_TTL_MS[client]) });
  const patch: Partial<UserRow> = { lastSeenAt: now, failedLogins: 0, lockedUntil: null };
  if (client === 'mobile' && !u.firstMobileLoginAt) patch.firstMobileLoginAt = now; // FR-MEM-01: invitable once signed in
  await db.update(users).set(patch).where(eq(users.id, u.id));
  return { accessToken: signAccess(u.id, client), refreshToken: refresh, expiresIn: client === 'web' ? 600 : 900, user: await profile({ ...u, ...patch }) };
}

export async function profile(u: UserRow) {
  const dept = (await db.select().from(departments).where(eq(departments.id, u.departmentId)))[0];
  const settings = (await db.select().from(userSettings).where(eq(userSettings.userId, u.id)))[0];
  return {
    id: u.id, name: u.name, email: u.email, phone: u.phone, employeeCode: u.employeeCode, designation: u.designation, departmentId: u.departmentId, departmentName: dept?.name ?? '',
    roles: ['employee', ...(u.isFinance ? ['finance'] : []), ...(u.isAdmin ? ['admin'] : [])], isFinance: u.isFinance, isAdmin: u.isAdmin,
    settings: { dailyDigest: settings?.dailyDigest ?? false, theme: settings?.theme ?? 'system', notificationPrefs: settings?.notificationPrefs ?? {} },
  };
}

/** Password sign-in; five wrong passwords lock password sign-in for 15 minutes (M01·b). */
export async function login(email: string, password: string, client: Client, deviceLabel: string | null) {
  const now = new Date();
  const u = await findByEmail(email);
  if (u && !u.active) throw await deactivatedError();
  assertCanSignIn(u, client, now);
  const ok = !!u.passwordHash && (await verify(u.passwordHash, password).catch(() => false));
  if (!ok) {
    const failed = u.failedLogins + 1;
    const locked = failed >= MAX_ATTEMPTS ? new Date(now.getTime() + LOCK_MS) : null;
    await db.update(users).set({ failedLogins: locked ? 0 : failed, lockedUntil: locked }).where(eq(users.id, u.id));
    if (locked) throw new AppError(423, 'locked', 'Too many wrong attempts. Password sign-in is locked for 15 minutes. You can still use a one-time code.', { lockedUntil: locked });
    throw new AppError(401, 'invalid_credentials', 'Email or password doesn’t match.', { attemptsLeft: MAX_ATTEMPTS - failed });
  }
  return issueTokens(u, client, deviceLabel, now);
}

/** Emails a 6-digit code valid for 10 minutes (M01·a). The answer never reveals whether the email exists. */
export async function requestOtp(email: string) {
  const u = await findByEmail(email);
  if (!u || !u.active) return { sent: true };
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await db.insert(otpCodes).values({ userId: u.id, codeHash: sha256(`${u.id}:${code}`), expiresAt: new Date(Date.now() + minutes(10)) });
  await sendMail({
    to: u.email, subject: `Your Expenso sign-in code: ${code}`,
    text: `Hello ${u.name.split(' ')[0]},\n\nYour Expenso sign-in code is ${code}. It works for 10 minutes.\n\nIf you did not ask for it, you can ignore this email.`,
  });
  log.info({ email: u.email }, 'one-time code issued');
  return config.DEV_ECHO_OTP ? { sent: true, devCode: code } : { sent: true };
}

export async function verifyOtp(email: string, code: string, client: Client, deviceLabel: string | null) {
  const now = new Date();
  const u = await findByEmail(email);
  if (!u) throw new AppError(401, 'invalid_code', 'That code is not right or has expired.');
  if (!u.active) throw await deactivatedError();
  if (client === 'web' && !u.isFinance && !u.isAdmin) throw forbidden('This is the finance console. Employees use the Expenso mobile app.', 'web_role_required');
  const row = (await db.select().from(otpCodes).where(and(eq(otpCodes.userId, u.id), isNull(otpCodes.usedAt), gt(otpCodes.expiresAt, now))).orderBy(desc(otpCodes.createdAt)).limit(1))[0];
  if (!row || row.attempts >= MAX_ATTEMPTS) throw new AppError(401, 'invalid_code', 'That code is not right or has expired. Ask for a new one.');
  if (row.codeHash !== sha256(`${u.id}:${code}`)) {
    await db.update(otpCodes).set({ attempts: row.attempts + 1 }).where(eq(otpCodes.id, row.id));
    throw new AppError(401, 'invalid_code', 'That code is not right.', { attemptsLeft: MAX_ATTEMPTS - row.attempts - 1 });
  }
  await db.update(otpCodes).set({ usedAt: now }).where(eq(otpCodes.id, row.id));
  return issueTokens(u, client, deviceLabel, now);
}

/** Rotate the refresh token. Web sessions slide by 30 minutes, so 30 idle minutes sign finance out (W01·b). */
export async function refresh(token: string) {
  const now = new Date();
  const row = (await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, sha256(token))))[0];
  if (!row || row.revokedAt || row.expiresAt < now) throw new AppError(401, 'session_ended', 'Your session ended. Sign in again.');
  const u = (await db.select().from(users).where(eq(users.id, row.userId)))[0];
  if (!u?.active) throw await deactivatedError();
  const client = row.client as Client;
  await db.update(refreshTokens).set({ revokedAt: now, lastUsedAt: now }).where(eq(refreshTokens.id, row.id));
  return issueTokens(u, client, row.deviceLabel, now);
}

export async function logout(token: string) {
  await db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.tokenHash, sha256(token)), isNull(refreshTokens.revokedAt)));
}

export async function revokeAll(userId: string) {
  await db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}

export async function changePassword(userId: string, current: string, next: string) {
  const u = (await db.select().from(users).where(eq(users.id, userId)))[0];
  if (!u) throw unauthorized();
  if (u.passwordHash && !(await verify(u.passwordHash, current).catch(() => false))) throw new AppError(400, 'invalid_credentials', 'The current password is not right.');
  await db.update(users).set({ passwordHash: await hashPassword(next), updatedAt: new Date() }).where(eq(users.id, userId));
}

export { actorFromUser };
