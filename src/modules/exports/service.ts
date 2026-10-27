/**
 * Export and share (SRS §8): scope, formats, provisional marking, missing-receipt warning, the server-side builder
 * and the export log. Exports are queued and built in the background by an in-process worker; the requester is
 * notified when the files are ready (FR-EXPT-05) and every export stays downloadable (FR-EXPT-07).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { config } from '../../config.js';
import { db, schema } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { SYSTEM, withTx, type Ctx } from '../../lib/context.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { log } from '../../lib/logger.js';
import { notify } from '../../lib/notify.js';
import { emitToFinance, emitToUser, tripChanged } from '../../lib/realtime.js';
import { storage } from '../../lib/storage.js';
import { getMember, getTrip, isAccepted } from '../domain.js';
import {
  PROV, SCOPE_LABEL, loadExportData, loadWith, statementName,
  type AttachmentRow, type ExportData, type ExportLimit, type Format, type MemberData, type Scope,
} from './data.js';
import { ExportFileError, buildStatementPdf } from './pdf.js';
import { buildStatementXlsx } from './xlsx.js';
import { ZipSourceError, writeZip, type ZipItem } from './zip.js';

const { exportsTable, locations, users, trips } = schema;
type ExportRow = typeof exportsTable.$inferSelect;

export interface ExportRequest extends ExportLimit {
  scope: Scope;
  memberUserId?: string | null;
  formats: Format[];
}

const MIME: Record<Format, string> = { pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', zip: 'application/zip' };

/** Each member separately and whole trip plus each member are delivered as one ZIP (SRS §8.2). */
export function normalizeFormats(scope: Scope, formats: Format[]): Format[] {
  const set = new Set(formats);
  if (scope === 'each' || scope === 'trip_and_each') set.add('zip');
  return (['pdf', 'xlsx', 'zip'] as const).filter(f => set.has(f));
}

async function validate(ctx: Ctx, tripId: string, r: ExportRequest) {
  const trip = await getTrip(ctx.tx, tripId);
  if (!r.formats.length) throw badRequest('validation', 'Choose at least one format.', [{ field: 'formats', message: 'Choose at least one format.' }]);
  if (r.scope === 'member') {
    if (!r.memberUserId) throw badRequest('validation', 'Pick the member to export.', [{ field: 'memberUserId', message: 'Pick a member.' }]);
    if (!isAccepted(await getMember(ctx.tx, tripId, r.memberUserId))) throw badRequest('validation', 'That person is not a member of this trip.', [{ field: 'memberUserId', message: 'Not a member.' }]);
  }
  if (r.locationId) {
    const l = (await ctx.tx.select().from(locations).where(eq(locations.id, r.locationId)))[0];
    if (!l || l.tripId !== tripId) throw badRequest('validation', 'Pick a location of this trip.', [{ field: 'locationId', message: 'Unknown location.' }]);
  }
  if (r.dateFrom && r.dateTo && r.dateFrom > r.dateTo) throw badRequest('validation', 'The start date is after the end date.', [{ field: 'dateTo', message: 'Must be on or after the start date.' }]);
  return trip;
}

/* ================= planning: the same plan drives the preview and the build ================= */

type Source = { kind: 'statement'; who: MemberData | null; ext: 'pdf' | 'xlsx' } | { kind: 'file'; a: AttachmentRow; name: string };
interface Plan {
  standalone: Array<{ format: 'pdf' | 'xlsx'; name: string; who: MemberData | null }>;
  zip: { name: string; entries: Array<{ path: string; source: Source }> } | null;
  provisional: boolean;
}

const stmtProv = (d: ExportData, who: MemberData | null) => (who ? who.provisional : d.provisional);

export function plan(d: ExportData, scope: Scope, formats: Format[]): Plan {
  const provisional = scope === 'member' ? d.members[0]?.provisional ?? d.provisional : d.members.some(m => m.provisional) || d.provisional;
  const standalone: Plan['standalone'] = [];
  const stmt = (who: MemberData | null) => (['pdf', 'xlsx'] as const).map(ext => ({ ext, name: statementName(d, who, ext, stmtProv(d, who)) }));
  const receiptsOf = (m: MemberData) => m.expenses.flatMap(it => it.files.filter(f => f.received).map(f => ({ a: f.a, name: f.name })));
  const entries: Array<{ path: string; source: Source }> = [];
  const add = (dir: string, s: Source, name: string) => entries.push({ path: `${dir}/${name}`, source: s });

  if (scope === 'member') {
    const m = d.members[0];
    for (const f of formats) if (f !== 'zip') standalone.push({ format: f, name: statementName(d, m, f, m.provisional), who: m });
    if (formats.includes('zip')) {
      const base = `${d.ref}_${m.slug}${d.limitSuffix}${m.provisional ? PROV : ''}`;
      for (const s of stmt(m)) add(base, { kind: 'statement', who: m, ext: s.ext }, s.name);
      for (const r of receiptsOf(m)) add(`${base}/Receipts`, { kind: 'file', ...r }, r.name);
      for (const x of m.documents) add(`${base}/Finance-documents`, { kind: 'file', a: x.a, name: x.name }, x.name);
      return { standalone, zip: { name: `${base}.zip`, entries }, provisional };
    }
    return { standalone, zip: null, provisional };
  }
  if (scope === 'each') {
    const base = `${d.ref}_Member-exports${d.limitSuffix}${provisional ? PROV : ''}`;
    for (const m of d.members) {
      for (const s of stmt(m)) add(`${base}/${m.slug}`, { kind: 'statement', who: m, ext: s.ext }, s.name);
      for (const r of receiptsOf(m)) add(`${base}/${m.slug}/Receipts`, { kind: 'file', ...r }, r.name);
      for (const x of m.documents) add(`${base}/${m.slug}/Finance-documents`, { kind: 'file', a: x.a, name: x.name }, x.name);
    }
    return { standalone, zip: { name: `${base}.zip`, entries }, provisional };
  }
  // whole trip, with or without each member
  for (const f of formats) if (f !== 'zip') standalone.push({ format: f, name: statementName(d, null, f, d.provisional), who: null });
  if (!formats.includes('zip')) return { standalone, zip: null, provisional: d.provisional };
  const base = `${d.ref}_${d.tripSlug}${d.limitSuffix}${provisional ? PROV : ''}`;
  for (const s of stmt(null)) add(base, { kind: 'statement', who: null, ext: s.ext }, s.name);
  if (scope === 'trip_and_each') {
    for (const m of d.members) {
      for (const s of stmt(m)) add(`${base}/Members/${m.slug}`, { kind: 'statement', who: m, ext: s.ext }, s.name);
      for (const r of receiptsOf(m)) add(`${base}/Members/${m.slug}/Receipts`, { kind: 'file', ...r }, r.name);
    }
  } else {
    for (const m of d.members) for (const r of receiptsOf(m)) add(`${base}/Receipts/${m.slug}`, { kind: 'file', ...r }, r.name);
  }
  for (const x of d.tripDocuments) add(`${base}/Finance-documents/Trip`, { kind: 'file', a: x.a, name: x.name }, x.name);
  for (const m of d.members) for (const x of m.documents) add(`${base}/Finance-documents/${m.slug}`, { kind: 'file', a: x.a, name: x.name }, x.name);
  return { standalone, zip: { name: `${base}.zip`, entries }, provisional };
}

function loadOptions(r: ExportRequest, actorName: string, via: string) {
  return { scope: r.scope, memberUserId: r.memberUserId ?? null, limit: { locationId: r.locationId ?? null, dateFrom: r.dateFrom ?? null, dateTo: r.dateTo ?? null }, generatedBy: actorName, via };
}

/** W08 preview: counts, provisional state, missing receipts and the ZIP tree with real names (FR-EXPT-03, FR-EXPT-10). */
export async function previewExport(ctx: Ctx, tripId: string, r: ExportRequest) {
  await validate(ctx, tripId, r);
  const formats = normalizeFormats(r.scope, r.formats.length ? r.formats : ['pdf', 'xlsx', 'zip']);
  const d = await loadWith(ctx.tx, tripId, loadOptions(r, ctx.actor.name, 'web'));
  const p = plan(d, r.scope, formats);
  const receipts = d.members.flatMap(m => m.expenses.flatMap(it => it.files));
  const received = receipts.filter(f => f.received);
  const docs = [...d.tripDocuments, ...d.members.flatMap(m => m.documents)];
  const attachmentBytes = received.reduce((s, f) => s + f.a.sizeBytes, 0) + docs.reduce((s, x) => s + x.a.sizeBytes, 0);
  // A statement PDF is about 90 KB plus a compressed page per attachment it prints (FR-EXPT-06).
  const itemsOf = (who: MemberData | null) => (who ? [who] : d.members).reduce((s, m) => s + m.expenses.reduce((t, it) => t + it.files.filter(f => f.received).length, 0) + m.documents.length, 0) + (who ? 0 : d.tripDocuments.length);
  const pdfSize = (who: MemberData | null) => 90_000 + itemsOf(who) * 260_000;
  const zipStatements = p.zip ? p.zip.entries.filter(e => e.source.kind === 'statement').map(e => (e.source as { who: MemberData | null; ext: string })) : [];
  const zipBytes = p.zip ? attachmentBytes + zipStatements.reduce((s, x) => s + (x.ext === 'pdf' ? pdfSize(x.who) : 40_000), 0) : 0;
  return {
    scope: r.scope, scopeLabel: SCOPE_LABEL[r.scope], formats,
    provisional: p.provisional, reasons: d.provisionalReasons,
    members: d.members.map(m => ({ userId: m.userId, name: m.name, provisional: m.provisional, claimStatus: m.member.claimStatus, expenses: m.expenses.length, hasIndividualBudget: !!m.individual })),
    counts: { members: d.members.length, expenses: d.members.reduce((s, m) => s + m.expenses.length, 0), receipts: receipts.length, receiptsReceived: received.length, documents: docs.length },
    budgetsStated: { pool: !!d.pool, individuals: d.members.filter(m => m.individual).map(m => m.name), changeLog: d.budgetLog.length },
    limitLabel: d.limitLabel,
    missingReceipts: d.missingReceipts,
    deliverables: [...p.standalone.map(s => ({ format: s.format, name: s.name })), ...(p.zip ? [{ format: 'zip' as const, name: p.zip.name }] : [])],
    zipPaths: p.zip ? p.zip.entries.map(e => e.path).slice(0, 2000) : [],
    estimatedBytes: { zip: zipBytes, pdf: pdfSize(r.scope === 'member' ? d.members[0] ?? null : null) },
  };
}

/* ================= requests and the log ================= */

export async function requestExport(ctx: Ctx, tripId: string, r: ExportRequest, via: 'web' | 'mobile') {
  const trip = await validate(ctx, tripId, r);
  const formats = normalizeFormats(r.scope, r.formats);
  const d = await loadWith(ctx.tx, tripId, loadOptions(r, ctx.actor.name, via));
  const p = plan(d, r.scope, formats);
  const [row] = await ctx.tx.insert(exportsTable).values({
    tripId, requestedBy: ctx.actor.id!, requestedVia: via, scope: r.scope, memberUserId: r.scope === 'member' ? r.memberUserId! : null, formats,
    locationId: r.locationId ?? null, dateFrom: r.dateFrom ?? null, dateTo: r.dateTo ?? null, provisional: p.provisional, status: 'queued',
    missingReceipts: d.missingReceipts.length, createdAt: ctx.now,
  }).returning();
  await audit(ctx, {
    action: 'export.request', entity: 'export', entityId: row.id, tripId, memberUserId: row.memberUserId,
    meta: { scope: r.scope, formats, via, provisional: p.provisional, limit: d.limitLabel, missingReceipts: d.missingReceipts.length },
  });
  ctx.after.push(() => { autoKick(); void announce(row.id); tripChanged(trip.id, 'export'); });
  return exportDto(row, { tripRef: trip.ref, tripName: trip.name, requestedByName: ctx.actor.name, memberName: d.members.length === 1 && r.scope === 'member' ? d.members[0].name : null, limitLabel: d.limitLabel });
}

/** FR-EXPT-09: a member's export built on the phone from local data is logged here; the files stay on the phone. */
export async function logDeviceExport(ctx: Ctx, tripId: string, x: { clientId?: string | null; formats: Format[]; locationId?: string | null; dateFrom?: string | null; dateTo?: string | null; provisional: boolean; files: Array<{ format: Format; name: string; size: number }>; builtAt: Date }) {
  const trip = await getTrip(ctx.tx, tripId);
  if (!isAccepted(await getMember(ctx.tx, tripId, ctx.actor.id!))) throw forbidden('You are not a member of this trip.', 'not_member');
  if (x.clientId) {
    const prior = (await ctx.tx.select().from(exportsTable).where(and(eq(exportsTable.requestedBy, ctx.actor.id!), eq(exportsTable.clientId, x.clientId))))[0];
    if (prior) return { ...prior, idempotent: true };
  }
  const [row] = await ctx.tx.insert(exportsTable).values({
    clientId: x.clientId ?? null, tripId, requestedBy: ctx.actor.id!, requestedVia: 'mobile', scope: 'member', memberUserId: ctx.actor.id!, formats: x.formats,
    locationId: x.locationId ?? null, dateFrom: x.dateFrom ?? null, dateTo: x.dateTo ?? null, provisional: x.provisional, status: 'ready',
    files: x.files.map(f => ({ ...f, onDevice: true })), createdAt: x.builtAt, startedAt: x.builtAt, finishedAt: x.builtAt,
  }).returning();
  await audit(ctx, { action: 'export.device', entity: 'export', entityId: row.id, tripId, memberUserId: ctx.actor.id, meta: { formats: x.formats, provisional: x.provisional, builtAt: x.builtAt.toISOString() } });
  ctx.after.push(() => { void announce(row.id); tripChanged(trip.id, 'export'); });
  return { ...row, idempotent: false };
}

interface DtoExtra { tripRef?: string; tripName?: string; requestedByName?: string; memberName?: string | null; locationCity?: string | null; limitLabel?: string | null }
interface StoredFile { format: Format; name: string; key?: string; size: number; onDevice?: boolean }

export function exportDto(x: ExportRow, e: DtoExtra = {}) {
  const files = (x.files as StoredFile[]) ?? [];
  const prog = progress.get(x.id);
  const limit = [e.locationCity, x.dateFrom && x.dateTo ? `${x.dateFrom} to ${x.dateTo}` : x.dateFrom ? `from ${x.dateFrom}` : x.dateTo ? `up to ${x.dateTo}` : null].filter(Boolean).join(', ');
  return {
    id: x.id, tripId: x.tripId, tripRef: e.tripRef ?? null, tripName: e.tripName ?? null,
    requestedBy: x.requestedBy, requestedByName: e.requestedByName ?? null, via: x.requestedVia,
    scope: x.scope, scopeLabel: x.scope === 'member' ? (x.requestedVia === 'mobile' && x.memberUserId === x.requestedBy ? 'Own claim' : `One member${e.memberName ? ` · ${e.memberName}` : ''}`) : SCOPE_LABEL[x.scope],
    memberUserId: x.memberUserId, memberName: e.memberName ?? null, formats: x.formats,
    locationId: x.locationId, dateFrom: x.dateFrom, dateTo: x.dateTo, limitLabel: e.limitLabel ?? (limit || null),
    provisional: x.provisional, status: x.status, progress: x.status === 'building' ? prog ?? { pct: 1, step: 'Starting', phase: 'read', subject: null } : null,
    files: files.map(f => ({ format: f.format, name: f.name, size: f.size, onDevice: !!f.onDevice, url: f.onDevice || !f.key ? null : `/api/v1/exports/${x.id}/download/${f.format}` })),
    sizeBytes: files.reduce((s, f) => s + (f.format === 'zip' || files.length === 1 ? f.size : 0), 0) || files.reduce((s, f) => s + f.size, 0),
    missingReceipts: x.missingReceipts, error: x.error, createdAt: x.createdAt, startedAt: x.startedAt, finishedAt: x.finishedAt, baseName: x.baseName,
  };
}
export type ExportDto = ReturnType<typeof exportDto>;

async function decorate(rows: ExportRow[]) {
  if (!rows.length) return [];
  const tIds = [...new Set(rows.map(r => r.tripId))];
  const ts = await db.select({ id: trips.id, ref: trips.ref, name: trips.name }).from(trips).where(inArray(trips.id, tIds));
  const uIds = [...new Set(rows.flatMap(r => [r.requestedBy, r.memberUserId]).filter((x): x is string => !!x))];
  const us = uIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, uIds)) : [];
  const lIds = [...new Set(rows.map(r => r.locationId).filter((x): x is string => !!x))];
  const ls = lIds.length ? await db.select({ id: locations.id, city: locations.city }).from(locations).where(inArray(locations.id, lIds)) : [];
  return rows.map(r => exportDto(r, {
    tripRef: ts.find(t => t.id === r.tripId)?.ref, tripName: ts.find(t => t.id === r.tripId)?.name,
    requestedByName: us.find(u => u.id === r.requestedBy)?.name, memberName: r.memberUserId ? us.find(u => u.id === r.memberUserId)?.name ?? null : null,
    locationCity: r.locationId ? ls.find(l => l.id === r.locationId)?.city ?? null : null,
  }));
}

export async function getExport(id: string) {
  const x = (await db.select().from(exportsTable).where(eq(exportsTable.id, id)))[0];
  if (!x) throw notFound('Export');
  return x;
}
export async function exportView(id: string) { return (await decorate([await getExport(id)]))[0]; }

/** W08·d export centre and W04·e trip export log: newest first, web and mobile. */
export async function listExports(f: { tripId?: string; status?: string; via?: string; scope?: string; requestedBy?: string; q?: string; page?: number; pageSize?: number }) {
  const where = and(
    f.tripId ? eq(exportsTable.tripId, f.tripId) : sql`true`,
    f.status === 'provisional' ? eq(exportsTable.provisional, true) : f.status === 'final' ? and(eq(exportsTable.provisional, false), eq(exportsTable.status, 'ready')) : f.status ? eq(exportsTable.status, f.status as ExportRow['status']) : sql`true`,
    f.via ? eq(exportsTable.requestedVia, f.via) : sql`true`,
    f.scope ? eq(exportsTable.scope, f.scope as Scope) : sql`true`,
    f.requestedBy ? eq(exportsTable.requestedBy, f.requestedBy) : sql`true`,
    f.q?.trim() ? sql`(exists (select 1 from trips t where t.id = ${exportsTable.tripId} and (t.name ilike ${'%' + f.q.trim() + '%'} or t.ref ilike ${'%' + f.q.trim() + '%'}))
      or exists (select 1 from users u where u.id in (${exportsTable.requestedBy}, ${exportsTable.memberUserId}) and u.name ilike ${'%' + f.q.trim() + '%'})
      or ${exportsTable.files}::text ilike ${'%' + f.q.trim() + '%'})` : sql`true`,
  );
  const size = f.pageSize ?? 50, page = f.page ?? 1;
  const rows = await db.select().from(exportsTable).where(where).orderBy(desc(exportsTable.createdAt)).limit(size).offset((page - 1) * size);
  const total = Number((await db.select({ c: sql<number>`count(*)` }).from(exportsTable).where(where))[0].c);
  return { items: await decorate(rows), total, page, pageSize: size };
}

export async function myExports(userId: string, tripId: string) {
  const rows = await db.select().from(exportsTable).where(and(eq(exportsTable.tripId, tripId), eq(exportsTable.requestedBy, userId))).orderBy(desc(exportsTable.createdAt)).limit(50);
  return decorate(rows);
}

/** Who may fetch an export's files: finance, or the member who asked for their own claim. */
export function canDownload(x: ExportRow, u: { id: string; isFinance: boolean }) {
  return u.isFinance || (x.requestedBy === u.id && x.scope === 'member' && x.memberUserId === u.id);
}

export async function openDownload(id: string, format: Format, u: { id: string; isFinance: boolean }) {
  const x = await getExport(id);
  if (!canDownload(x, u)) throw notFound('Export');
  if (x.status !== 'ready') throw conflict('export_not_ready', x.status === 'failed' ? 'This export failed. Retry it from the export centre.' : 'This export is still being built.');
  const f = ((x.files as StoredFile[]) ?? []).find(y => y.format === format);
  if (!f || !f.key) throw notFound('File');
  return { stream: await storage.stream(f.key), name: f.name, size: f.size, mime: MIME[format] };
}

export async function retryExport(ctx: Ctx, id: string) {
  const x = (await ctx.tx.select().from(exportsTable).where(eq(exportsTable.id, id)).for('update'))[0];
  if (!x) throw notFound('Export');
  if (x.status !== 'failed') throw conflict('not_failed', 'Only a failed export can be retried.');
  await ctx.tx.update(exportsTable).set({ status: 'queued', error: null, files: [], startedAt: null, finishedAt: null }).where(eq(exportsTable.id, id));
  await audit(ctx, { action: 'export.retry', entity: 'export', entityId: id, tripId: x.tripId, memberUserId: x.memberUserId });
  ctx.after.push(() => { autoKick(); void announce(id); });
}

/** W08·b "Cancel export": nothing is logged, so the row goes away; a running build notices and discards its files. */
export async function cancelExport(ctx: Ctx, id: string) {
  const x = (await ctx.tx.select().from(exportsTable).where(eq(exportsTable.id, id)).for('update'))[0];
  if (!x) throw notFound('Export');
  if (x.status === 'ready' || x.status === 'failed') throw conflict('export_done', 'This export has finished. Exports stay in the log and can’t be deleted.');
  if (x.requestedBy !== ctx.actor.id && !ctx.actor.isFinance) throw forbidden();
  await ctx.tx.delete(exportsTable).where(eq(exportsTable.id, id));
  progress.delete(id);
  ctx.after.push(() => { emitToFinance('export.removed', { id }); emitToUser(x.requestedBy, 'export.removed', { id }); tripChanged(x.tripId, 'export'); });
}

/* ================= the worker ================= */

type Phase = 'read' | 'pdf' | 'xlsx' | 'zip';
const progress = new Map<string, { pct: number; step: string; detail?: string; phase: Phase; subject: { userId: string; name: string } | null }>();
let drainP: Promise<void> | null = null;
let again = false;
let timer: NodeJS.Timeout | null = null;

async function announce(id: string) {
  try {
    const x = (await db.select().from(exportsTable).where(eq(exportsTable.id, id)))[0];
    if (!x) return;
    const [dto] = await decorate([x]);
    if (x.requestedVia === 'web') emitToFinance('export.updated', dto);
    emitToUser(x.requestedBy, 'export.updated', dto);
  } catch (e) { log.warn({ err: e }, 'export announce failed'); }
}

/** Wake the worker. Work queued while it runs is picked up before it stops, so nothing waits for the next poll. */
export function kickExports(): Promise<void> {
  again = true;
  drainP ??= (async () => {
    try {
      while (again) {
        again = false;
        for (;;) {
          const job = await claimNext();
          if (!job) break;
          await build(job);
        }
      }
    } catch (e) {
      log.error({ err: e }, 'export worker stopped');
    } finally { drainP = null; }
  })();
  return drainP;
}
/** Build everything queued and wait for it (tests, scripts and the seed). */
export async function runQueuedExports() { await kickExports(); }
const autoKick = () => { if (config.RUN_JOBS) void kickExports(); };

/** Start the background worker: requeue builds interrupted by a restart, then poll for queued work (other instances). */
export async function startExportWorker(pollSeconds = 10) {
  await db.update(exportsTable).set({ status: 'queued', startedAt: null })
    .where(and(eq(exportsTable.status, 'building'), sql`${exportsTable.startedAt} < now() - interval '15 minutes'`));
  void kickExports();
  timer = setInterval(() => void kickExports(), pollSeconds * 1000);
}
export function stopExportWorker() { if (timer) clearInterval(timer); timer = null; }

async function claimNext(): Promise<ExportRow | undefined> {
  const r = await db.execute(sql`
    update exports set status = 'building', started_at = now()
    where id = (select id from exports where status = 'queued' order by created_at for update skip locked limit 1)
    returning id`);
  const id = (r.rows[0] as { id?: string } | undefined)?.id;
  return id ? getExport(id) : undefined;
}

async function build(job: ExportRow) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'expenso-export-'));
  const stored: string[] = [];
  let last = 0;
  const report = (pct: number, step: string, detail?: string, phase: Phase = 'read', subject: MemberData | null = null) => {
    progress.set(job.id, { pct: Math.max(1, Math.min(99, Math.round(pct))), step, detail, phase, subject: subject ? { userId: subject.userId, name: subject.name } : null });
    const now = Date.now();
    if (now - last > 400) {
      last = now;
      const payload = { id: job.id, tripId: job.tripId, ...progress.get(job.id) };
      if (job.requestedVia === 'web') emitToFinance('export.progress', payload);
      emitToUser(job.requestedBy, 'export.progress', payload);
    }
  };
  try {
    report(2, 'Reading the trip');
    const requester = (await db.select({ name: users.name }).from(users).where(eq(users.id, job.requestedBy)))[0];
    const d = await loadExportData(job.tripId, {
      scope: job.scope, memberUserId: job.memberUserId, generatedBy: requester?.name ?? 'Expenso', via: job.requestedVia,
      limit: { locationId: job.locationId, dateFrom: job.dateFrom, dateTo: job.dateTo },
    });
    const p = plan(d, job.scope, job.formats as Format[]);

    // Statements needed anywhere in the plan, built once each.
    const needed = new Map<string, { who: MemberData | null; ext: 'pdf' | 'xlsx' }>();
    for (const s of p.standalone) needed.set(`${s.who?.userId ?? 'trip'}:${s.format}`, { who: s.who, ext: s.format });
    for (const e of p.zip?.entries ?? []) if (e.source.kind === 'statement') needed.set(`${e.source.who?.userId ?? 'trip'}:${e.source.ext}`, { who: e.source.who, ext: e.source.ext });
    const built = new Map<string, string>();
    const zipShare = p.zip ? 35 : 0;
    const list = [...needed.entries()];
    for (let i = 0; i < list.length; i++) {
      const [key, s] = list[i];
      const base = 3 + (i / list.length) * (95 - zipShare);
      const span = (95 - zipShare) / list.length;
      const label = s.who ? `${s.who.name}: ${s.ext === 'pdf' ? 'statement PDF' : 'Excel workbook'}` : s.ext === 'pdf' ? 'Statement PDF' : 'Excel workbook';
      report(base, label, undefined, s.ext, s.who);
      const file = path.join(tmp, `${key.replace(':', '.')}.${s.ext}`);
      if (s.ext === 'pdf') {
        const r = await buildStatementPdf(d, s.who, stmtProv(d, s.who), (done, total) => report(base + (span * done) / Math.max(1, total), label, `${done} of ${total}`, 'pdf', s.who));
        await fs.writeFile(file, r.buffer);
      } else {
        await fs.writeFile(file, await buildStatementXlsx(d, s.who, stmtProv(d, s.who)));
      }
      built.set(key, file);
      if (!(await stillWanted(job.id))) return discard(job, tmp, stored);
    }

    const files: StoredFile[] = [];
    for (const s of p.standalone) {
      const src = built.get(`${s.who?.userId ?? 'trip'}:${s.format}`)!;
      const key = `exports/${job.id}/${s.name}`;
      const size = await storage.putFile(key, src, MIME[s.format]);
      stored.push(key);
      files.push({ format: s.format, name: s.name, key, size });
    }
    if (p.zip) {
      const items: ZipItem[] = p.zip.entries.map(e => e.source.kind === 'statement'
        ? { path: e.path, file: built.get(`${e.source.who?.userId ?? 'trip'}:${e.source.ext}`)! }
        : { path: e.path, label: e.source.name, open: (() => { const a = (e.source as { a: AttachmentRow }).a; return () => { if (!a.storageKey) throw new Error('no storage key'); return storage.stream(a.storageKey); }; })() });
      const zipFile = path.join(tmp, 'package.zip');
      await writeZip(zipFile, items, (done, total) => report(95 - zipShare + (zipShare * done) / total, 'Packing the ZIP', `${done} of ${total} files`, 'zip'));
      const key = `exports/${job.id}/${p.zip.name}`;
      const size = await storage.putFile(key, zipFile, MIME.zip);
      stored.push(key);
      files.push({ format: 'zip', name: p.zip.name, key, size });
    }
    const baseName = p.zip ? p.zip.name.replace(/\.zip$/, '') : files[0]?.name.replace(/\.(pdf|xlsx)$/, '') ?? null;
    const done = await withTx(SYSTEM, async ctx => {
      const [row] = await ctx.tx.update(exportsTable).set({ status: 'ready', files, baseName, provisional: p.provisional, missingReceipts: d.missingReceipts.length, finishedAt: ctx.now, error: null })
        .where(and(eq(exportsTable.id, job.id), eq(exportsTable.status, 'building'))).returning();
      if (!row) return null;
      await audit(ctx, { action: 'export.ready', entity: 'export', entityId: job.id, tripId: job.tripId, memberUserId: job.memberUserId, meta: { files: files.map(f => ({ name: f.name, size: f.size })) } });
      await notify(ctx, [job.requestedBy], {
        type: 'export.ready', tripId: job.tripId, channel: job.requestedVia === 'mobile' ? 'app' : 'web',
        title: 'Your export is ready', body: `${d.ref} · ${exportDto(row).scopeLabel}${p.provisional ? ' · Provisional' : ''}`, data: { exportId: job.id, tripId: job.tripId },
      });
      return row;
    });
    if (!done) return discard(job, tmp, stored);
    progress.delete(job.id);
    await announce(job.id);
    tripChanged(job.tripId, 'export');
  } catch (e) {
    const fileName = e instanceof ExportFileError ? e.fileName : e instanceof ZipSourceError ? e.label : null;
    const message = fileName ? `Couldn’t read ${fileName} from storage. Nothing partial was delivered; retry when storage answers.` : 'The export couldn’t be built. Retry, and tell support if it fails again.';
    log.error({ err: e, exportId: job.id }, 'export failed');
    for (const k of stored) await storage.delete(k).catch(() => undefined);
    progress.delete(job.id);
    await withTx(SYSTEM, async ctx => {
      const [row] = await ctx.tx.update(exportsTable).set({ status: 'failed', error: message, finishedAt: ctx.now, files: [] }).where(and(eq(exportsTable.id, job.id), eq(exportsTable.status, 'building'))).returning();
      if (!row) return;
      await audit(ctx, { action: 'export.failed', entity: 'export', entityId: job.id, tripId: job.tripId, memberUserId: job.memberUserId, meta: { error: message } });
      await notify(ctx, [job.requestedBy], { type: 'export.failed', tripId: job.tripId, channel: job.requestedVia === 'mobile' ? 'app' : 'web', title: 'Export failed', body: message, data: { exportId: job.id, tripId: job.tripId } });
    }).catch(err => log.error({ err }, 'could not record export failure'));
    await announce(job.id);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function stillWanted(id: string) {
  const r = await db.select({ s: exportsTable.status }).from(exportsTable).where(eq(exportsTable.id, id));
  return r[0]?.s === 'building';
}
async function discard(job: ExportRow, tmp: string, stored: string[]) {
  for (const k of stored) await storage.delete(k).catch(() => undefined);
  progress.delete(job.id);
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
}
