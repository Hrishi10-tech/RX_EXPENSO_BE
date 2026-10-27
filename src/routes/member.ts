/** Endpoints used by the mobile app (members). Every read and write is filtered for the signed-in member. */
import express, { Router, type Request } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { db, schema } from '../db/client.js';
import { me, requireAuth } from '../lib/auth.js';
import { withTx } from '../lib/context.js';
import { forbidden, notFound } from '../lib/errors.js';
import { parse, zDate, zDateTime, zId, zPaise } from '../lib/http.js';
import { notificationDto } from '../lib/notify.js';
import { contentDisposition, storage } from '../lib/storage.js';
import { getMember, isAccepted } from '../modules/domain.js';
import * as ex from '../modules/expenses/service.js';
import * as loc from '../modules/locations/service.js';
import * as trips from '../modules/trips/service.js';
import { timeline } from '../modules/trips/timeline.js';
import * as views from '../modules/trips/views.js';

export const memberRouter = Router();
memberRouter.use(requireAuth);

const deviceTime = (req: Request, body?: unknown): Date | undefined => {
  const b = (body as { deviceTime?: string } | undefined)?.deviceTime ?? req.header('x-device-time');
  if (!b) return undefined;
  const d = new Date(b);
  return Number.isNaN(d.getTime()) ? undefined : d;
};
const run = <T>(req: Request, fn: Parameters<typeof withTx<T>>[1]) => withTx(me(req), fn);

const zTripBase = z.object({
  name: z.string().trim().min(1, 'Enter the trip name.').max(120),
  type: z.enum(['same_day', 'multi_day']),
  purpose: z.enum(trips.PURPOSES),
  clientEvent: z.string().trim().max(160).nullish(),
  scheduledStart: zDateTime,
  tentativeEnd: zDateTime,
  primaryCity: z.string().trim().min(1, 'Enter the primary city.').max(80),
  notes: z.string().max(2000).nullish(),
});

/* ---------- trips ---------- */
memberRouter.get('/trips/mine', async (req, res) => { res.json(await run(req, ctx => views.myTrips(ctx))); });

memberRouter.post('/trips', async (req, res) => {
  const b = parse(zTripBase.extend({ clientId: z.string().max(64).nullish(), inviteeIds: z.array(zId).max(50).optional(), createdOffline: z.boolean().optional() }), req.body);
  const trip = await run(req, ctx => trips.createTrip(ctx, b));
  res.status(201).json(await run(req, ctx => views.tripSnapshot(ctx, trip.id)));
});

memberRouter.get('/trips/:id', async (req, res) => { res.json(await run(req, ctx => views.tripSnapshot(ctx, parse(zId, req.params.id)))); });

memberRouter.patch('/trips/:id', async (req, res) => {
  const b = parse(zTripBase.partial(), req.body);
  const id = parse(zId, req.params.id);
  await run(req, ctx => trips.updateTrip(ctx, id, b));
  res.json(await run(req, ctx => views.tripSnapshot(ctx, id)));
});

memberRouter.post('/trips/:id/cancel', async (req, res) => {
  const b = parse(z.object({ reason: z.string().max(500).nullish() }), req.body ?? {});
  await run(req, ctx => trips.cancelTrip(ctx, parse(zId, req.params.id), b.reason));
  res.json(await run(req, ctx => views.tripSnapshot(ctx, parse(zId, req.params.id))));
});

memberRouter.get('/trips/:id/candidates', async (req, res) => {
  res.json(await run(req, ctx => trips.candidates(ctx, parse(zId, req.params.id), String(req.query.q ?? ''))));
});

memberRouter.post('/trips/:id/invites', async (req, res) => {
  const b = parse(z.object({ userIds: z.array(zId).min(1).max(50) }), req.body);
  const invited = await run(req, ctx => trips.invite(ctx, parse(zId, req.params.id), b.userIds));
  res.json({ invited });
});

memberRouter.delete('/trips/:id/invites/:userId', async (req, res) => {
  await run(req, ctx => trips.withdrawInvite(ctx, parse(zId, req.params.id), parse(zId, req.params.userId)));
  res.status(204).end();
});

memberRouter.post('/trips/:id/respond', async (req, res) => {
  const b = parse(z.object({ accept: z.boolean(), startChoice: z.enum(['scheduled', 'now']).optional() }), req.body);
  const id = parse(zId, req.params.id);
  const r = await run(req, ctx => trips.respond(ctx, id, b.accept, b.startChoice, deviceTime(req)));
  res.json({ ...r, trip: r.status === 'accepted' ? await run(req, ctx => views.tripSnapshot(ctx, id)) : null });
});

memberRouter.post('/trips/:id/start', async (req, res) => {
  const id = parse(zId, req.params.id);
  const r = await run(req, ctx => trips.startTrip(ctx, id, deviceTime(req, req.body)));
  res.json({ ...r, trip: await run(req, ctx => views.tripSnapshot(ctx, id)) });
});

memberRouter.post('/trips/:id/end', async (req, res) => {
  const id = parse(zId, req.params.id);
  const r = await run(req, ctx => trips.endTrip(ctx, id, deviceTime(req, req.body)));
  res.json({ ...r, trip: await run(req, ctx => views.tripSnapshot(ctx, id)) });
});

memberRouter.post('/trips/:id/resume', async (req, res) => {
  const id = parse(zId, req.params.id);
  await run(req, ctx => trips.resumeTrip(ctx, id));
  res.json(await run(req, ctx => views.tripSnapshot(ctx, id)));
});

memberRouter.post('/trips/:id/leave', async (req, res) => {
  await run(req, ctx => trips.leaveTrip(ctx, parse(zId, req.params.id)));
  res.status(204).end();
});

memberRouter.delete('/trips/:id/members/:userId', async (req, res) => {
  await run(req, ctx => trips.removeMember(ctx, parse(zId, req.params.id), parse(zId, req.params.userId)));
  res.status(204).end();
});

memberRouter.post('/trips/:id/owner', async (req, res) => {
  const b = parse(z.object({ userId: zId }), req.body);
  const id = parse(zId, req.params.id);
  await run(req, ctx => trips.handOver(ctx, id, b.userId));
  res.json(await run(req, ctx => views.tripSnapshot(ctx, id)));
});

memberRouter.get('/trips/:id/timeline', async (req, res) => {
  const id = parse(zId, req.params.id);
  res.json(await run(req, async ctx => {
    const m = await getMember(ctx.tx, id, ctx.actor.id!);
    if (!isAccepted(m)) throw forbidden('You are not a member of this trip.', 'not_member');
    return timeline(ctx, id, false);
  }));
});

memberRouter.get('/trips/:id/claim', async (req, res) => { res.json(await run(req, ctx => views.myClaim(ctx, parse(zId, req.params.id)))); });

/* ---------- locations ---------- */
const zLocation = z.object({
  clientId: z.string().max(64).nullish(), city: z.string().trim().min(1, 'Enter the city.').max(80), venue: z.string().trim().max(120).nullish(),
  address: z.string().trim().max(300).nullish(), lat: z.number().min(-90).max(90).nullish(), lng: z.number().min(-180).max(180).nullish(),
  arrivalDate: zDate, departureDate: zDate, notes: z.string().max(1000).nullish(), confirmOverlap: z.boolean().optional(),
});
memberRouter.post('/trips/:id/locations', async (req, res) => {
  const b = parse(zLocation, req.body);
  res.status(201).json(await run(req, ctx => loc.addLocation(ctx, parse(zId, req.params.id), b)));
});
memberRouter.get('/locations/:id', async (req, res) => { res.json(await run(req, ctx => views.locationView(ctx, parse(zId, req.params.id)))); });
memberRouter.patch('/locations/:id', async (req, res) => {
  const b = parse(zLocation.partial(), req.body);
  res.json(await run(req, ctx => loc.updateLocation(ctx, parse(zId, req.params.id), b)));
});
memberRouter.delete('/locations/:id', async (req, res) => {
  await run(req, ctx => loc.deleteLocation(ctx, parse(zId, req.params.id)));
  res.status(204).end();
});

/* ---------- expenses ---------- */
const zAttachmentMeta = z.object({ clientId: z.string().max(64).nullish(), name: z.string().max(200).default('receipt.jpg'), mime: z.string().max(120), size: z.number().int().min(0).max(config.MAX_UPLOAD_MB * 1024 * 1024), capturedAt: zDateTime.nullish() });
const zExpense = z.object({
  clientId: z.string().max(64).nullish(), locationId: zId.nullish(), spentAt: zDateTime, category: z.enum(ex.CATEGORIES),
  description: z.string().trim().min(1, 'Say what the expense was for.').max(200), amountPaise: zPaise, paymentMode: z.enum(['upi', 'cash', 'card', 'company']),
  paidBy: z.enum(['self', 'company']), budgetSource: z.enum(['pool', 'individual']).nullish(), remarks: z.string().max(1000).nullish(),
  attachments: z.array(zAttachmentMeta).max(ex.MAX_ATTACHMENTS).default([]), confirmDuplicate: z.boolean().optional(),
});
/** Every problem with a new expense comes back at once, so the form can mark all fields (M09·c). */
const zExpenseCreate = zExpense.superRefine((v, ctx) => {
  if (v.paidBy === 'self' && !v.attachments?.length) ctx.addIssue({ code: 'custom', path: ['attachments'], message: 'Attach at least one receipt for a self-paid expense.' });
  if (v.paymentMode === 'company' && v.paidBy !== 'company') ctx.addIssue({ code: 'custom', path: ['paidBy'], message: 'Company-paid expenses are paid by the company.' });
});

memberRouter.post('/trips/:id/expenses', async (req, res) => {
  const b = parse(zExpenseCreate, req.body);
  const r = await run(req, ctx => ex.createExpense(ctx, parse(zId, req.params.id), { ...b, deviceTime: deviceTime(req) }));
  res.status(r.idempotent ? 200 : 201).json(r);
});
memberRouter.get('/expenses/:id', async (req, res) => { res.json(await run(req, ctx => views.expenseView(ctx, parse(zId, req.params.id)))); });
memberRouter.patch('/expenses/:id', async (req, res) => {
  const b = parse(zExpense.omit({ clientId: true, attachments: true, confirmDuplicate: true }).partial(), req.body);
  res.json(await run(req, ctx => ex.updateExpense(ctx, parse(zId, req.params.id), { ...b, locationId: b.locationId ?? undefined })));
});
memberRouter.delete('/expenses/:id', async (req, res) => {
  await run(req, ctx => ex.deleteExpense(ctx, parse(zId, req.params.id)));
  res.status(204).end();
});
memberRouter.post('/expenses/:id/budget-source', async (req, res) => {
  const b = parse(z.object({ budgetSource: z.enum(['pool', 'individual']) }), req.body);
  res.json(await run(req, ctx => ex.setBudgetSource(ctx, parse(zId, req.params.id), b.budgetSource)));
});
memberRouter.post('/expenses/:id/attachments', async (req, res) => {
  const b = parse(zAttachmentMeta, req.body);
  const a = await run(req, ctx => ex.addAttachment(ctx, parse(zId, req.params.id), b));
  res.status(201).json({ attachmentId: a.id, clientId: a.clientId, status: a.status, uploadPath: `/api/v1/attachments/${a.id}/content` });
});
memberRouter.post('/expenses/:id/replies', async (req, res) => {
  const b = parse(z.object({ clientId: z.string().max(64).nullish(), body: z.string().max(2000).default(''), attachments: z.array(zAttachmentMeta).max(ex.MAX_ATTACHMENTS).default([]) }), req.body);
  const r = await run(req, ctx => ex.replyToQuery(ctx, parse(zId, req.params.id), b.body, b.attachments, b.clientId));
  res.status(r.idempotent ? 200 : 201).json(r);
});
memberRouter.post('/expenses/:id/move', async (req, res) => {
  const b = parse(z.object({ tripId: zId, locationId: zId.nullish(), budgetSource: z.enum(['pool', 'individual']).nullish() }), req.body);
  res.json(await run(req, ctx => ex.moveExpense(ctx, parse(zId, req.params.id), b)));
});

/* ---------- attachment bytes (both apps) ---------- */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024 } });
memberRouter.put('/attachments/:id/content',
  (req, res, next) => (req.is('multipart/form-data') ? upload.single('file')(req, res, next) : express.raw({ type: () => true, limit: `${config.MAX_UPLOAD_MB}mb` })(req, res, next)),
  async (req, res) => {
    const body = req.file ? req.file.buffer : (req.body as Buffer);
    const mime = req.file?.mimetype ?? req.header('content-type') ?? 'application/octet-stream';
    const a = await run(req, ctx => ex.uploadContent(ctx, parse(zId, req.params.id), Buffer.isBuffer(body) ? body : Buffer.alloc(0), mime.split(';')[0]));
    res.json(views.attachmentDto(a));
  });

memberRouter.get('/attachments/:id/content', async (req, res) => {
  const id = parse(zId, req.params.id);
  const u = me(req);
  const a = (await db.select().from(schema.attachments).where(and(eq(schema.attachments.id, id), isNull(schema.attachments.deletedAt))))[0];
  if (!a) throw notFound('File');
  if (!u.isFinance) {
    if (a.kind === 'document') { if (!(a.visibleToMember && a.memberUserId === u.id)) throw notFound('File'); }
    else {
      const e = a.expenseId ? (await db.select().from(schema.expenses).where(eq(schema.expenses.id, a.expenseId)))[0] : undefined;
      const m = await getMember(db, a.tripId, u.id);
      if (!e || !isAccepted(m) || (e.userId !== u.id && e.budgetSource !== 'pool')) throw notFound('File');
    }
  }
  if (a.status !== 'uploaded' || !a.storageKey) { res.status(409).json({ error: { code: 'not_uploaded', message: 'The file is still on the member’s phone.' } }); return; }
  let body = await storage.get(a.storageKey);
  let mime = a.mime;
  const w = Number(req.query.w ?? 0);
  if (w > 0 && a.mime.startsWith('image/')) { body = await sharp(body).rotate().resize({ width: Math.min(w, 1600), withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer(); mime = 'image/jpeg'; }
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  if (req.query.download) res.setHeader('Content-Disposition', contentDisposition(a.originalName));
  res.send(body);
});

memberRouter.delete('/attachments/:id', async (req, res) => {
  await run(req, ctx => ex.deleteAttachment(ctx, parse(zId, req.params.id)));
  res.status(204).end();
});

/* ---------- notifications (both apps) ---------- */
memberRouter.get('/notifications', async (req, res) => {
  const u = me(req);
  const before = req.query.before ? new Date(String(req.query.before)) : null;
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const channels = u.client === 'web' ? ['web', 'both'] : ['app', 'both'];
  const rows = await db.select().from(schema.notifications)
    .where(and(eq(schema.notifications.userId, u.id), inArray(schema.notifications.channel, channels), before ? lt(schema.notifications.createdAt, before) : sql`true`))
    .orderBy(desc(schema.notifications.createdAt)).limit(limit);
  const unread = await db.select({ c: sql<number>`count(*)` }).from(schema.notifications).where(and(eq(schema.notifications.userId, u.id), inArray(schema.notifications.channel, channels), isNull(schema.notifications.readAt)));
  res.json({ items: rows.map(notificationDto), unread: Number(unread[0].c) });
});

memberRouter.post('/notifications/read', async (req, res) => {
  const b = parse(z.object({ ids: z.array(zId).optional(), all: z.boolean().optional() }), req.body);
  const u = me(req);
  const channels = u.client === 'web' ? ['web', 'both'] : ['app', 'both'];
  await db.update(schema.notifications).set({ readAt: new Date() }).where(and(eq(schema.notifications.userId, u.id), isNull(schema.notifications.readAt), inArray(schema.notifications.channel, channels),
    b.all ? sql`true` : inArray(schema.notifications.id, b.ids?.length ? b.ids : ['00000000-0000-0000-0000-000000000000'])));
  res.status(204).end();
});
