/**
 * Export endpoints (SRS §8). Finance exports any trip from the web (FR-EXPT-01); a member exports their own claim
 * from the phone (FR-EXPT-09), built on the server when online or on the phone and logged here when offline.
 * Mounted at the API root before the finance router, so each route carries its own guard.
 */
import { Router, type Request } from 'express';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { db } from '../db/client.js';
import { me, requireAuth, requireFinance } from '../lib/auth.js';
import { withTx } from '../lib/context.js';
import { notFound } from '../lib/errors.js';
import { parse, zDate, zDateTime, zId } from '../lib/http.js';
import { contentDisposition } from '../lib/storage.js';
import { getMember, isAccepted } from '../modules/domain.js';
import * as xs from '../modules/exports/service.js';

export const exportsRouter = Router();
const zFormat = z.enum(['pdf', 'xlsx', 'zip']);
const zScope = z.enum(['trip', 'member', 'each', 'trip_and_each']);
const zLimit = { locationId: zId.nullish(), dateFrom: zDate.nullish(), dateTo: zDate.nullish() };
const id = (req: Request, k = 'id') => parse(zId, req.params[k]);

/* ---------- finance: W08 export page, W08·d export centre, W04·e export log ---------- */
exportsRouter.get('/finance/trips/:id/exports/preview', requireAuth, requireFinance, async (req, res) => {
  const q = parse(z.object({ scope: zScope.default('trip_and_each'), memberUserId: zId.optional(), formats: z.string().optional(), ...zLimit }), req.query);
  const formats = (q.formats ? q.formats.split(',').filter(Boolean) : ['pdf', 'xlsx', 'zip']).map(f => parse(zFormat, f));
  res.json(await withTx(me(req), ctx => xs.previewExport(ctx, id(req), { ...q, formats })));
});

exportsRouter.post('/finance/trips/:id/exports', requireAuth, requireFinance, async (req, res) => {
  const b = parse(z.object({ scope: zScope, memberUserId: zId.nullish(), formats: z.array(zFormat).min(1, 'Choose at least one format.'), ...zLimit }), req.body);
  res.status(202).json(await withTx(me(req), ctx => xs.requestExport(ctx, id(req), b, 'web')));
});

exportsRouter.get('/finance/exports', requireAuth, requireFinance, async (req, res) => {
  const q = parse(z.object({
    tripId: zId.optional(), status: z.enum(['queued', 'building', 'ready', 'failed', 'provisional', 'final']).optional(), via: z.enum(['web', 'mobile']).optional(),
    scope: zScope.optional(), requestedBy: zId.optional(), q: z.string().max(100).optional(),
    page: z.coerce.number().int().min(1).optional(), pageSize: z.coerce.number().int().min(1).max(200).optional(),
  }), req.query);
  res.json(await xs.listExports(q));
});

exportsRouter.post('/finance/exports/:id/retry', requireAuth, requireFinance, async (req, res) => {
  await withTx(me(req), ctx => xs.retryExport(ctx, id(req)));
  res.json(await xs.exportView(id(req)));
});

exportsRouter.delete('/finance/exports/:id', requireAuth, requireFinance, async (req, res) => {
  await withTx(me(req), ctx => xs.cancelExport(ctx, id(req)));
  res.status(204).end();
});

/* ---------- member: own claim (FR-EXPT-09) ---------- */
async function requireTripMember(req: Request) {
  const tripId = id(req);
  if (!isAccepted(await getMember(db, tripId, me(req).id))) throw notFound('Trip');
  return tripId;
}

exportsRouter.post('/trips/:id/exports', requireAuth, async (req, res) => {
  const tripId = await requireTripMember(req);
  const b = parse(z.object({ formats: z.array(zFormat).min(1, 'Choose at least one format.'), ...zLimit }), req.body);
  const u = me(req);
  res.status(202).json(await withTx(u, ctx => xs.requestExport(ctx, tripId, { ...b, scope: 'member', memberUserId: u.id }, u.client === 'web' ? 'web' : 'mobile')));
});

exportsRouter.post('/trips/:id/exports/log', requireAuth, async (req, res) => {
  const tripId = await requireTripMember(req);
  const b = parse(z.object({
    clientId: z.string().max(64).nullish(), formats: z.array(zFormat).min(1), ...zLimit, provisional: z.boolean(), builtAt: zDateTime,
    files: z.array(z.object({ format: zFormat, name: z.string().min(1).max(240), size: z.number().int().min(0) })).min(1).max(3),
  }), req.body);
  const r = await withTx(me(req), ctx => xs.logDeviceExport(ctx, tripId, b));
  res.status(r.idempotent ? 200 : 201).json(r);
});

exportsRouter.get('/trips/:id/exports/mine', requireAuth, async (req, res) => {
  const tripId = await requireTripMember(req);
  res.json(await xs.myExports(me(req).id, tripId));
});

/* ---------- status and download (finance, or the member for their own claim) ---------- */
exportsRouter.get('/exports/:id', requireAuth, async (req, res) => {
  const x = await xs.getExport(id(req));
  if (!xs.canDownload(x, me(req))) throw notFound('Export');
  res.json(await xs.exportView(x.id));
});

exportsRouter.get('/exports/:id/download/:format', requireAuth, async (req, res) => {
  const f = await xs.openDownload(id(req), parse(zFormat, req.params.format), me(req));
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Length', String(f.size));
  res.setHeader('Content-Disposition', contentDisposition(f.name));
  res.setHeader('Cache-Control', 'private, max-age=0, no-store');
  await pipeline(f.stream, res);
});
