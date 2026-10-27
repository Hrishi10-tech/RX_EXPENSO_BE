import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/client.js';
import type { Actor } from './context.js';
import { forbidden, unauthorized, AppError } from './errors.js';

export type Client = 'mobile' | 'web';
export interface AuthUser extends Actor { id: string; email: string; client: Client; }

declare module 'express-serve-static-core' {
  interface Request { user?: AuthUser }
}

const ACCESS_TTL: Record<Client, string> = { mobile: '15m', web: '10m' };
/** Mobile refresh tokens slide for 60 days; web sessions end after 30 idle minutes (NFR-06). */
export const REFRESH_TTL_MS: Record<Client, number> = { mobile: 60 * 24 * 3600 * 1000, web: 30 * 60 * 1000 };

export function signAccess(userId: string, client: Client) {
  return jwt.sign({ sub: userId, cl: client }, config.JWT_SECRET, { expiresIn: ACCESS_TTL[client] as jwt.SignOptions['expiresIn'], issuer: 'expenso' });
}
export const newOpaqueToken = () => crypto.randomBytes(32).toString('base64url');
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

type UserRow = typeof schema.users.$inferSelect;
export function actorFromUser(u: UserRow, client: Client): AuthUser {
  return { id: u.id, name: u.name, email: u.email, isFinance: u.isFinance, isAdmin: u.isAdmin, departmentId: u.departmentId, client };
}

/** Verifies the bearer token and loads the user fresh on every request, so deactivation bites at once (FR-ROLE-08). */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) throw unauthorized();
  let payload: { sub: string; cl: Client };
  try {
    payload = jwt.verify(h.slice(7), config.JWT_SECRET, { issuer: 'expenso' }) as typeof payload;
  } catch {
    throw new AppError(401, 'token_expired', 'Session expired. Sign in again.');
  }
  const u = await db.query.users.findFirst({ where: eq(schema.users.id, payload.sub) });
  if (!u) throw unauthorized();
  if (!u.active) throw new AppError(401, 'deactivated', 'This account is no longer active.', { contact: await (await import('../modules/auth/service.js')).supportContact() });
  if (payload.cl === 'web' && !u.isFinance && !u.isAdmin) throw forbidden('The web app is for finance and administrators.', 'web_role_required');
  req.user = actorFromUser(u, payload.cl);
  next();
}

export function requireFinance(req: Request, _res: Response, next: NextFunction) {
  if (!req.user?.isFinance) throw forbidden('Finance only.', 'finance_only');
  next();
}
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user?.isAdmin) throw forbidden('Administrators only.', 'admin_only');
  next();
}
export function requireMobile(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.client !== 'mobile') throw forbidden('Use the mobile app for this.', 'mobile_only');
  next();
}
export function me(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
