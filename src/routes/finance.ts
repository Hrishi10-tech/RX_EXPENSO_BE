/** Finance console endpoints (SRS §7). Finance role required; administrators without it see no expense data. */
import { Router, type Request } from 'express';
import multer from 'multer';
import { and, asc, desc, eq, gte, ilike, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { db, schema } from '../db/client.js';
import { me, requireAuth, requireFinance } from '../lib/auth.js';
import { withTx } from '../lib/context.js';
import { badRequest } from '../lib/errors.js';
import { parse, zDate, zDateTime, zId, zPaise } from '../lib/http.js';
import * as fin from '../modules/finance/service.js';
import * as fv from '../modules/finance/views.js';
import { timeline } from '../modules/trips/timeline.js';
import { auditHandler } from './audit.js';
import { expenseView } from '../modules/trips/views.js';

export const financeRouter = Router();
financeRouter.use(requireAuth, requireFinance);
const run = <T>(req: Request, fn: Parameters<typeof withTx<T>>[1]) => withTx(me(req), fn);
const id = (req: Request, k = 'id') => parse(zId, req.params[k]);

financeRouter.get('/dashboard', async (req, res) => {
  const q = parse(z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM.').optional() }), req.query);
  res.json(await run(req, ctx => fv.dashboard(ctx, q.month)));
});

financeRouter.get('/trips', async (req, res) => {
  const q = parse(z.object({
    status: z.string().optional(), departmentId: zId.optional(), ownerId: zId.optional(), memberId: zId.optional(), from: zDate.optional(), to: zDate.optional(),
    budget: z.enum(['pool', 'individual', 'unbudgeted', 'over']).optional(), claim: z.enum(['open', 'ready', 'verified', 'part_paid', 'reimbursed']).optional(),
    q: z.string().max(100).optional(), sort: z.string().optional(), page: z.coerce.number().int().min(1).optional(), pageSize: z.coerce.number().int().min(1).max(200).optional(),
  }), req.query);
  res.json(await run(req, ctx => fv.tripList(ctx, { ...q, status: q.status ? q.status.split(',').filter(Boolean) : undefined })));
});

financeRouter.get('/trips/:id', async (req, res) => { res.json(await run(req, ctx => fv.financeTrip(ctx, id(req)))); });
financeRouter.get('/trips/:id/timeline', async (req, res) => { res.json(await run(req, ctx => timeline(ctx, id(req), true))); });

/* ---------- budgets ---------- */
financeRouter.get('/trips/:id/budgets/log', async (req, res) => { res.json(await run(req, ctx => fin.budgetLog(ctx, id(req)))); });
financeRouter.post('/trips/:id/budgets/preview', async (req, res) => {
  const b = parse(z.object({ pool: zPaise.nullish(), individuals: z.record(z.string(), zPaise.nullable()).default({}) }), req.body);
  res.json(await run(req, ctx => fin.previewBudgets(ctx, id(req), b.pool, b.individuals)));
});
const zBudget = z.object({ amountPaise: zPaise, note: z.string().max(500).nullish() });
/** The whole W05 save at once: earlier expenses are resolved against the budgets held after the save (FR-BUD-03). */
financeRouter.put('/trips/:id/budgets', async (req, res) => {
  const b = parse(z.object({ pool: zBudget.nullish(), individuals: z.record(z.string(), zBudget.nullable()).optional(), note: z.string().max(500).nullish() }), req.body);
  for (const k of Object.keys(b.individuals ?? {})) parse(zId, k);
  const result = await run(req, ctx => fin.setBudgets(ctx, id(req), { pool: b.pool === undefined ? undefined : b.pool, individuals: b.individuals, note: b.note }));
  res.json({ ...result, trip: await run(req, ctx => fv.financeTrip(ctx, id(req))) });
});
financeRouter.post('/trips/:id/handoff', async (req, res) => {
  const b = parse(z.object({ toUserId: zId, topic: z.enum(['budgets', 'claim']), message: z.string().max(1000).nullish() }), req.body);
  await run(req, ctx => fin.handoff(ctx, id(req), b.toUserId, b.topic, b.message));
  res.status(204).end();
});
financeRouter.put('/trips/:id/budgets/pool', async (req, res) => {
  const b = parse(zBudget, req.body);
  await run(req, ctx => fin.setBudget(ctx, id(req), { type: 'pool', amountPaise: b.amountPaise, note: b.note }));
  res.json(await run(req, ctx => fv.financeTrip(ctx, id(req))));
});
financeRouter.delete('/trips/:id/budgets/pool', async (req, res) => {
  const b = parse(z.object({ note: z.string().max(500).nullish() }), req.body ?? {});
  await run(req, ctx => fin.removeBudget(ctx, id(req), 'pool', null, b.note));
  res.json(await run(req, ctx => fv.financeTrip(ctx, id(req))));
});
financeRouter.put('/trips/:id/budgets/individual/:userId', async (req, res) => {
  const b = parse(zBudget, req.body);
  await run(req, ctx => fin.setBudget(ctx, id(req), { type: 'individual', memberUserId: id(req, 'userId'), amountPaise: b.amountPaise, note: b.note }));
  res.json(await run(req, ctx => fv.financeTrip(ctx, id(req))));
});
financeRouter.delete('/trips/:id/budgets/individual/:userId', async (req, res) => {
  const b = parse(z.object({ note: z.string().max(500).nullish() }), req.body ?? {});
  await run(req, ctx => fin.removeBudget(ctx, id(req), 'individual', id(req, 'userId'), b.note));
  res.json(await run(req, ctx => fv.financeTrip(ctx, id(req))));
});

/* ---------- members ---------- */
financeRouter.post('/trips/:id/members/:userId/end', async (req, res) => {
  const b = parse(z.object({ endAt: zDateTime, reason: z.string().trim().min(3, 'Give the reason.').max(500) }), req.body);
  await run(req, ctx => fin.financeEndMember(ctx, id(req), id(req, 'userId'), b.endAt, b.reason));
  res.json(await run(req, ctx => fv.financeTrip(ctx, id(req))));
});
financeRouter.post('/trips/:id/owner', async (req, res) => {
  const b = parse(z.object({ userId: zId }), req.body);
  await run(req, ctx => fin.handOver(ctx, id(req), b.userId, true));
  res.json(await run(req, ctx => fv.financeTrip(ctx, id(req))));
});

/* ---------- claims and verification ---------- */
financeRouter.get('/claims', async (req, res) => {
  const q = parse(z.object({ status: z.enum(['ready', 'verified', 'part_paid', 'reimbursed', 'open']).optional(), q: z.string().max(100).optional(), departmentId: zId.optional() }), req.query);
  res.json(await run(req, ctx => fv.claimsQueue(ctx, q)));
});
financeRouter.get('/trips/:id/claims/:userId', async (req, res) => { res.json(await run(req, ctx => fv.claimReview(ctx, id(req), id(req, 'userId')))); });
financeRouter.get('/expenses/:id', async (req, res) => { res.json(await run(req, ctx => expenseView(ctx, id(req), true))); });

const zVersion = z.object({ version: z.number().int().min(1) });
financeRouter.post('/expenses/verify-bulk', async (req, res) => {
  const b = parse(z.object({ items: z.array(z.object({ id: zId, version: z.number().int() })).min(1).max(200), includeFlagged: z.boolean().optional() }), req.body);
  res.json({ results: await run(req, ctx => fin.bulkVerify(ctx, b.items, b.includeFlagged)) });
});
financeRouter.post('/expenses/:id/verify', async (req, res) => {
  const b = parse(zVersion.extend({ approvedPaise: zPaise.nullish(), reason: z.string().max(500).nullish() }), req.body);
  res.json(await run(req, ctx => fin.verifyExpense(ctx, id(req), b.version, b.approvedPaise, b.reason)));
});
financeRouter.post('/expenses/:id/query', async (req, res) => {
  const b = parse(zVersion.extend({ remark: z.string().max(2000) }), req.body);
  res.json(await run(req, ctx => fin.queryExpense(ctx, id(req), b.version, b.remark)));
});
financeRouter.post('/expenses/:id/reject', async (req, res) => {
  const b = parse(zVersion.extend({ remark: z.string().max(2000) }), req.body);
  res.json(await run(req, ctx => fin.rejectExpense(ctx, id(req), b.version, b.remark)));
});
financeRouter.post('/expenses/:id/messages', async (req, res) => {
  const b = parse(z.object({ body: z.string().max(2000) }), req.body);
  res.status(201).json(await run(req, ctx => fin.financeMessage(ctx, id(req), b.body)));
});
financeRouter.post('/expenses/:id/remind', async (req, res) => {
  await run(req, ctx => fin.remindReceipt(ctx, id(req)));
  res.status(204).end();
});

/* ---------- reimbursement ---------- */
financeRouter.post('/trips/:id/claims/:userId/payments', async (req, res) => {
  const b = parse(z.object({ amountPaise: zPaise, paidOn: zDate, mode: z.enum(['bank_transfer', 'upi', 'cash']), reference: z.string().max(80).nullish(), proofAttachmentId: zId.nullish(), note: z.string().max(500).nullish() }), req.body);
  res.status(201).json(await run(req, ctx => fin.recordPayment(ctx, id(req), id(req, 'userId'), b)));
});
financeRouter.post('/trips/:id/claims/:userId/reopen', async (req, res) => {
  const b = parse(z.object({ reason: z.string().max(500) }), req.body);
  res.json(await run(req, ctx => fin.reopenClaim(ctx, id(req), id(req, 'userId'), b.reason)));
});
financeRouter.post('/trips/:id/claims/:userId/close', async (req, res) => {
  res.json(await run(req, ctx => fin.closeClaim(ctx, id(req), id(req, 'userId'))));
});

/* ---------- documents ---------- */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024 } });
financeRouter.post('/documents', upload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('validation', 'Choose a file.', [{ field: 'file', message: 'Required.' }]);
  const b = parse(z.object({ tripId: zId, scope: z.enum(['trip', 'claim', 'expense']), memberUserId: zId.optional(), expenseId: zId.optional(), docType: z.enum(['payment_proof', 'invoice', 'approval_note', 'bank_statement', 'other']), note: z.string().max(500).optional() }), req.body);
  const a = await run(req, ctx => fin.uploadDocument(ctx, { ...b, name: req.file!.originalname, mime: req.file!.mimetype, body: req.file!.buffer }));
  res.status(201).json({ id: a.id, name: a.originalName, note: a.note, mime: a.mime, size: a.sizeBytes, docType: a.docType, docScope: a.docScope, url: `/api/v1/attachments/${a.id}/content` });
});
financeRouter.delete('/documents/:id', async (req, res) => {
  await run(req, ctx => fin.deleteDocument(ctx, id(req)));
  res.status(204).end();
});

/* ---------- people and departments for filters ---------- */
financeRouter.get('/people', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const rows = await db.select({ id: schema.users.id, name: schema.users.name, employeeCode: schema.users.employeeCode, departmentId: schema.users.departmentId, active: schema.users.active, isFinance: schema.users.isFinance })
    .from(schema.users).where(q ? ilike(schema.users.name, `%${q}%`) : sql`true`).orderBy(asc(schema.users.name)).limit(200);
  res.json(rows);
});
financeRouter.get('/departments', async (_req, res) => {
  res.json(await db.select().from(schema.departments).orderBy(asc(schema.departments.name)));
});

/* ---------- audit log (W11) ---------- */
financeRouter.get('/audit', auditHandler('finance'));
