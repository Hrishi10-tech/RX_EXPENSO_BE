/** Administration endpoints (W10): administrators only. */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { me, requireAdmin, requireAuth } from '../lib/auth.js';
import { withTx } from '../lib/context.js';
import { parse, zId } from '../lib/http.js';
import * as admin from '../modules/admin/service.js';
import { auditHandler } from './audit.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);
const run = <T>(req: Request, fn: Parameters<typeof withTx<T>>[1]) => withTx(me(req), fn);

const zUser = z.object({
  name: z.string().trim().min(1, 'Enter the name.').max(120), email: z.email('Enter a valid email.'), employeeCode: z.string().trim().min(1, 'Enter the employee ID.').max(40),
  phone: z.string().trim().max(30).nullish(), designation: z.string().trim().max(80).nullish(), departmentId: zId, isFinance: z.boolean().optional(), isAdmin: z.boolean().optional(),
  password: z.string().min(8, 'Use at least 8 characters.').nullish(),
});

adminRouter.get('/users', async (req, res) => {
  const q = parse(z.object({ q: z.string().max(100).optional(), departmentId: zId.optional(), role: z.enum(['finance', 'admin']).optional(), status: z.enum(['active', 'inactive']).optional() }), req.query);
  res.json(await run(req, ctx => admin.listUsers(ctx, q)));
});
adminRouter.post('/users', async (req, res) => { res.status(201).json(await run(req, ctx => admin.createUser(ctx, parse(zUser, req.body)))); });
adminRouter.patch('/users/:id', async (req, res) => { res.json(await run(req, ctx => admin.updateUser(ctx, parse(zId, req.params.id), parse(zUser.partial(), req.body)))); });
adminRouter.get('/users/:id/deactivation-impact', async (req, res) => { res.json(await run(req, ctx => admin.deactivationImpact(ctx, parse(zId, req.params.id)))); });
adminRouter.post('/users/:id/deactivate', async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().max(500).nullish() }), req.body ?? {});
  res.json(await run(req, ctx => admin.deactivate(ctx, parse(zId, req.params.id), b.reason)));
});
adminRouter.post('/users/:id/app-link', async (req, res) => {
  await run(req, ctx => admin.sendAppLink(ctx, parse(zId, req.params.id)));
  res.status(204).end();
});
adminRouter.get('/audit', auditHandler('admin'));
adminRouter.post('/users/:id/reactivate', async (req, res) => { res.json(await run(req, ctx => admin.reactivate(ctx, parse(zId, req.params.id)))); });

adminRouter.get('/departments', async (req, res) => { res.json(await run(req, ctx => admin.listDepartments(ctx))); });
adminRouter.post('/departments', async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(2).max(80) }), req.body);
  res.status(201).json(await run(req, ctx => admin.createDepartment(ctx, b.name)));
});
adminRouter.patch('/departments/:id', async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(2).max(80).optional(), archived: z.boolean().optional() }), req.body);
  res.json(await run(req, ctx => admin.updateDepartment(ctx, parse(zId, req.params.id), b)));
});
