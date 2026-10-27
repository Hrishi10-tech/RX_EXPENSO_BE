/**
 * Expense capture (SRS §5) with the budget source rule (§6.2), entry flags, duplicate check,
 * receipts (1 to 5 attachments, uploaded after the expense so offline capture works), query replies and budget alerts.
 */
import crypto from 'node:crypto';
import sharp from 'sharp';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import type { Ctx } from '../../lib/context.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { inr } from '../../lib/money.js';
import { notify, notifyFinance } from '../../lib/notify.js';
import { tripChanged } from '../../lib/realtime.js';
import { storage } from '../../lib/storage.js';
import { addDays, istDate, minutes } from '../../lib/time.js';
import {
  acceptedIds, activeBudgets, budgetLevel, budgetView, claimLocked, firstName, getMember, getMembers, getTrip, heldBudgets, isAccepted,
  notDeleted, recomputeClaim, userNames, visibleTo, type Expense, type Member, type Trip,
} from '../domain.js';

const { expenses, attachments, locations, expenseMessages, budgets, auditLog } = schema;

export const CATEGORIES = ['airfare', 'train', 'cab', 'fuel_toll', 'accommodation', 'meals', 'client_entertainment', 'event_fee', 'printing', 'courier', 'internet_phone', 'visa_passport', 'other'] as const;
export const CATEGORY_LABEL: Record<string, string> = {
  airfare: 'Airfare', train: 'Train', cab: 'Local travel / cab', fuel_toll: 'Fuel & toll', accommodation: 'Accommodation', meals: 'Meals',
  client_entertainment: 'Client entertainment', event_fee: 'Event / registration fee', printing: 'Printing & stationery', courier: 'Courier',
  internet_phone: 'Internet & phone', visa_passport: 'Visa & passport', other: 'Other',
};
export const MAX_ATTACHMENTS = 5;

export interface AttachmentMeta { clientId?: string | null; name: string; mime: string; size: number; capturedAt?: Date | null }
export interface ExpenseInput {
  clientId?: string | null;
  locationId?: string | null;
  spentAt: Date;
  category: (typeof CATEGORIES)[number];
  description: string;
  amountPaise: number;
  paymentMode: 'upi' | 'cash' | 'card' | 'company';
  paidBy: 'self' | 'company';
  budgetSource?: 'pool' | 'individual' | null;
  remarks?: string | null;
  attachments: AttachmentMeta[];
  confirmDuplicate?: boolean;
  deviceTime?: Date | null;
}

/** Pick the location covering the expense date, or the nearest one in time (FR-EXP-01). */
async function defaultLocation(ctx: Ctx, tripId: string, day: string) {
  const locs = await ctx.tx.select().from(locations).where(and(eq(locations.tripId, tripId), isNull(locations.deletedAt))).orderBy(asc(locations.arrivalDate));
  if (!locs.length) throw conflict('no_location', 'The trip has no location yet.');
  const covering = locs.filter(l => l.arrivalDate <= day && day <= l.departureDate);
  if (covering.length) return covering[covering.length - 1];
  const dist = (l: typeof locs[number]) => Math.min(Math.abs(Date.parse(l.arrivalDate) - Date.parse(day)), Math.abs(Date.parse(l.departureDate) - Date.parse(day)));
  return locs.slice().sort((a, b) => dist(a) - dist(b))[0];
}

function entryFlags(trip: Trip, m: Member, spentAt: Date, now: Date, deviceTime?: Date | null) {
  const f = new Set<string>();
  if (spentAt < trip.scheduledStart && !m.actualStart) f.add('pre_trip');                                   // FR-EXP-11
  else if (m.actualStart && spentAt.getTime() < m.actualStart.getTime() - minutes(1)) f.add(spentAt < trip.scheduledStart ? 'pre_trip' : 'outside_times'); // FR-EXP-12
  if (m.actualEnd && spentAt.getTime() > m.actualEnd.getTime() + minutes(1)) f.add('outside_times');
  if (m.actualEnd) f.add('late_entry');                                                                      // FR-END-06
  if (deviceTime && Math.abs(deviceTime.getTime() - now.getTime()) > minutes(10)) f.add('device_time_mismatch'); // NFR-14
  return [...f];
}

/** Resolve the budget source from what the member holds (§6.2); both held means the member must choose. */
async function resolveSource(ctx: Ctx, tripId: string, userId: string, paidBy: string, chosen?: string | null) {
  if (paidBy === 'company') return null;
  const held = await heldBudgets(ctx.tx, tripId, userId);
  if (held.pool && held.individual) {
    if (chosen !== 'pool' && chosen !== 'individual') throw unprocessable('budget_source_required', 'Choose Trip pool or My budget for this expense.', { field: 'budgetSource' });
    return chosen;
  }
  if (held.pool) return 'pool' as const;
  if (held.individual) return 'individual' as const;
  return 'unbudgeted' as const;
}

export async function createExpense(ctx: Ctx, tripId: string, input: ExpenseInput) {
  const uid = ctx.actor.id!;
  if (input.clientId) {
    const dup = await ctx.tx.select().from(expenses).where(and(eq(expenses.userId, uid), eq(expenses.clientId, input.clientId)));
    if (dup[0]) return { expense: dup[0], uploads: await uploadsFor(ctx, dup[0].id), idempotent: true };
  }
  const trip = await getTrip(ctx.tx, tripId, true);
  const m = await getMember(ctx.tx, tripId, uid, true);
  if (!isAccepted(m)) throw forbidden('You are not a member of this trip.', 'not_member');
  if (trip.status === 'cancelled') throw conflict('trip_cancelled', 'This trip was cancelled.');
  if (claimLocked(m!)) throw conflict('claim_locked', 'Your claim on this trip has been reimbursed and is locked.');
  if (!m!.actualStart && input.spentAt >= trip.scheduledStart) throw conflict('not_started', 'Start the trip first. Before the trip you can log advance bookings dated before its start.');

  const errs: Array<{ field: string; message: string }> = [];
  if (!input.description.trim()) errs.push({ field: 'description', message: 'Say what the expense was for.' });
  if (input.paidBy === 'self' && input.attachments.length === 0) errs.push({ field: 'attachments', message: 'Attach at least one receipt for a self-paid expense.' });
  if (input.attachments.length > MAX_ATTACHMENTS) errs.push({ field: 'attachments', message: `Up to ${MAX_ATTACHMENTS} files per expense.` });
  if (input.paymentMode === 'company' && input.paidBy !== 'company') errs.push({ field: 'paidBy', message: 'Company-paid expenses are paid by the company.' });
  if (input.spentAt.getTime() > ctx.now.getTime() + minutes(5)) errs.push({ field: 'spentAt', message: 'The date and time cannot be in the future.' });
  if (errs.length) throw badRequest('validation', 'Some fields need attention.', errs);

  let location;
  if (input.locationId) {
    location = (await ctx.tx.select().from(locations).where(and(eq(locations.id, input.locationId), eq(locations.tripId, tripId), isNull(locations.deletedAt))))[0];
    if (!location) throw badRequest('validation', 'Pick a location of this trip.', [{ field: 'locationId', message: 'Unknown location.' }]);
  } else location = await defaultLocation(ctx, tripId, istDate(input.spentAt));

  const source = await resolveSource(ctx, tripId, uid, input.paidBy, input.budgetSource);

  if (!input.confirmDuplicate) {
    const day = istDate(input.spentAt);
    const dups = await ctx.tx.select({ id: expenses.id, description: expenses.description, userId: expenses.userId, spentAt: expenses.spentAt, amountPaise: expenses.amountPaise })
      .from(expenses).where(and(eq(expenses.tripId, tripId), notDeleted, visibleTo(uid), eq(expenses.amountPaise, input.amountPaise), eq(expenses.category, input.category),
        sql`(${expenses.spentAt} at time zone 'Asia/Kolkata')::date = ${day}::date`));
    if (dups.length) {
      const names = await userNames(ctx.tx, dups.map(d => d.userId));
      throw conflict('possible_duplicate', 'This may already be claimed.', dups.map(d => ({ ...d, userName: names.get(d.userId)?.name ?? '' })));
    }
  }

  const flags = entryFlags(trip, m!, input.spentAt, ctx.now, input.deviceTime);
  const [e] = await ctx.tx.insert(expenses).values({
    clientId: input.clientId ?? null, tripId, locationId: location.id, userId: uid, spentAt: input.spentAt, category: input.category,
    description: input.description.trim(), amountPaise: input.amountPaise, paymentMode: input.paymentMode, paidBy: input.paidBy,
    budgetSource: source, remarks: input.remarks?.trim() || null, flags, deviceTime: input.deviceTime ?? null, receivedAt: ctx.now,
    createdAt: ctx.now, updatedAt: ctx.now,
  }).returning();
  for (const a of input.attachments) {
    await ctx.tx.insert(attachments).values({
      clientId: a.clientId ?? null, kind: 'receipt', tripId, expenseId: e.id, memberUserId: uid, originalName: a.name, mime: a.mime,
      sizeBytes: a.size, capturedAt: a.capturedAt ?? null, status: 'pending', uploadedBy: uid, createdAt: ctx.now,
    });
  }
  await audit(ctx, { action: 'expense.create', entity: 'expense', entityId: e.id, tripId, memberUserId: uid, after: e });
  if (m!.actualEnd) await recomputeClaim(ctx, tripId, uid); // a late entry returns a Verified claim to Ready (FR-END-06)
  const alerts = await checkBudgetAlerts(ctx, tripId);
  ctx.after.push(() => tripChanged(tripId, 'expense', { expenseId: e.id, userId: uid, private: source !== 'pool' }));
  const overage = source ? alerts.find(a => (source === 'pool' ? a.type === 'pool' : a.memberUserId === uid) && a.remainingPaise < 0) : undefined;
  return { expense: e, uploads: await uploadsFor(ctx, e.id), idempotent: false, overBudgetPaise: overage ? -overage.remainingPaise : 0 };
}

async function uploadsFor(ctx: Ctx, expenseId: string) {
  const rows = await ctx.tx.select().from(attachments).where(and(eq(attachments.expenseId, expenseId), isNull(attachments.deletedAt)));
  return rows.map(r => ({ attachmentId: r.id, clientId: r.clientId, status: r.status, uploadPath: `/api/v1/attachments/${r.id}/content` }));
}

async function ownExpenseForChange(ctx: Ctx, expenseId: string, purpose: 'edit' | 'delete' | 'source' | 'attach') {
  const e = (await ctx.tx.select().from(expenses).where(and(eq(expenses.id, expenseId), notDeleted)).for('update'))[0];
  if (!e) throw notFound('Expense');
  if (e.userId !== ctx.actor.id) throw forbidden('You can change only your own expenses.', 'not_owner');
  const trip = await getTrip(ctx.tx, e.tripId, true);
  const m = (await getMember(ctx.tx, e.tripId, e.userId, true))!;
  if (claimLocked(m)) throw conflict('claim_locked', 'Your claim has been reimbursed and is locked.');
  if (trip.status === 'cancelled') throw conflict('trip_cancelled', 'This trip was cancelled.');
  if (e.verification === 'verified' || e.verification === 'rejected') throw conflict('expense_settled', `Finance has already ${e.verification} this expense.`);
  // FR-EXP-04: after ending, only an expense under query can change.
  if (m.actualEnd && e.verification !== 'query' && purpose !== 'attach') throw conflict('expense_locked', 'You ended the trip, so only expenses finance queried can change.');
  return { e, trip, m };
}

export interface ExpensePatch {
  locationId?: string; spentAt?: Date; category?: ExpenseInput['category']; description?: string; amountPaise?: number;
  paymentMode?: ExpenseInput['paymentMode']; paidBy?: ExpenseInput['paidBy']; budgetSource?: 'pool' | 'individual' | null; remarks?: string | null;
}

/** Own edits apply field by field (last write wins, NFR-02); finance sees the new version (W06·f). */
export async function updateExpense(ctx: Ctx, expenseId: string, patch: ExpensePatch) {
  const { e, trip, m } = await ownExpenseForChange(ctx, expenseId, 'edit');
  const next: Partial<Expense> = {};
  if (patch.locationId && patch.locationId !== e.locationId) {
    const l = (await ctx.tx.select().from(locations).where(and(eq(locations.id, patch.locationId), eq(locations.tripId, e.tripId), isNull(locations.deletedAt))))[0];
    if (!l) throw badRequest('validation', 'Pick a location of this trip.', [{ field: 'locationId', message: 'Unknown location.' }]);
    next.locationId = l.id; // FR-LOC-05
  }
  if (patch.spentAt) next.spentAt = patch.spentAt;
  if (patch.category) next.category = patch.category;
  if (patch.description !== undefined) next.description = patch.description.trim();
  if (patch.amountPaise !== undefined) next.amountPaise = patch.amountPaise;
  if (patch.paymentMode) next.paymentMode = patch.paymentMode;
  if (patch.paidBy) next.paidBy = patch.paidBy;
  if (patch.remarks !== undefined) next.remarks = patch.remarks?.trim() || null;
  const paidBy = next.paidBy ?? e.paidBy;
  const mode = next.paymentMode ?? e.paymentMode;
  if (mode === 'company' && paidBy !== 'company') throw badRequest('validation', 'Company-paid expenses are paid by the company.', [{ field: 'paidBy', message: 'Must be company.' }]);
  if (paidBy !== e.paidBy || patch.budgetSource !== undefined) {
    next.budgetSource = await resolveSource(ctx, e.tripId, e.userId, paidBy, patch.budgetSource ?? (e.budgetSource === 'unbudgeted' ? null : e.budgetSource));
    next.needsBudgetChoice = false;
  }
  if (paidBy === 'self') {
    const n = await ctx.tx.select({ c: sql<number>`count(*)` }).from(attachments).where(and(eq(attachments.expenseId, e.id), isNull(attachments.deletedAt)));
    if (Number(n[0].c) === 0) throw badRequest('validation', 'Attach at least one receipt for a self-paid expense.', [{ field: 'attachments', message: 'Receipt required.' }]);
  }
  if (next.spentAt) next.flags = entryFlags(trip, m, next.spentAt, ctx.now, e.deviceTime);
  if (!Object.keys(next).length) return e;
  const [u] = await ctx.tx.update(expenses).set({ ...next, updatedAt: ctx.now, version: sql`${expenses.version} + 1` }).where(eq(expenses.id, e.id)).returning();
  await audit(ctx, { action: 'expense.update', entity: 'expense', entityId: e.id, tripId: e.tripId, memberUserId: e.userId, before: Object.fromEntries(Object.keys(next).map(k => [k, (e as Record<string, unknown>)[k]])), after: next });
  if (e.verification === 'query') {
    await notifyFinance(ctx, { type: 'expense.edited', tripId: e.tripId, title: `${firstName(ctx.actor.name)} edited a queried expense`, body: `${u.description} · ${inr(u.amountPaise)}`, data: { tripId: e.tripId, expenseId: e.id, userId: e.userId } });
  }
  await checkBudgetAlerts(ctx, e.tripId);
  await recomputeClaim(ctx, e.tripId, e.userId);
  ctx.after.push(() => tripChanged(e.tripId, 'expense', { expenseId: e.id, userId: e.userId, version: u.version }));
  return u;
}

/** FR-EXP-04: delete own expense while it can still change; its attachments go with it. */
export async function deleteExpense(ctx: Ctx, expenseId: string) {
  const { e } = await ownExpenseForChange(ctx, expenseId, 'delete');
  await ctx.tx.update(expenses).set({ deletedAt: ctx.now, updatedAt: ctx.now, version: sql`${expenses.version} + 1` }).where(eq(expenses.id, e.id));
  await ctx.tx.update(attachments).set({ deletedAt: ctx.now, deletedBy: ctx.actor.id }).where(and(eq(attachments.expenseId, e.id), isNull(attachments.deletedAt)));
  await audit(ctx, { action: 'expense.delete', entity: 'expense', entityId: e.id, tripId: e.tripId, memberUserId: e.userId, before: e });
  await checkBudgetAlerts(ctx, e.tripId);
  await recomputeClaim(ctx, e.tripId, e.userId);
  ctx.after.push(() => tripChanged(e.tripId, 'expense', { expenseId: e.id, deleted: true }));
}

/** FR-BUD-03/04: a member holding both budgets picks or switches the source of their own expense until verified. */
export async function setBudgetSource(ctx: Ctx, expenseId: string, source: 'pool' | 'individual') {
  const { e } = await ownExpenseForChange(ctx, expenseId, 'source');
  if (e.paidBy === 'company') throw conflict('company_paid', 'Company-paid expenses draw on no budget.');
  const held = await heldBudgets(ctx.tx, e.tripId, e.userId);
  if (!(held.pool && held.individual)) throw conflict('single_budget', 'You hold only one budget on this trip, so the source is set for you.');
  const [u] = await ctx.tx.update(expenses).set({ budgetSource: source, needsBudgetChoice: false, updatedAt: ctx.now, version: sql`${expenses.version} + 1` }).where(eq(expenses.id, e.id)).returning();
  await audit(ctx, { action: 'expense.budget_source', entity: 'expense', entityId: e.id, tripId: e.tripId, memberUserId: e.userId, before: { budgetSource: e.budgetSource }, after: { budgetSource: source } });
  await checkBudgetAlerts(ctx, e.tripId);
  ctx.after.push(() => tripChanged(e.tripId, 'expense', { expenseId: e.id }));
  return u;
}

/** Add a receipt placeholder to an own expense (reply attachments too); the file follows with uploadContent. */
export async function addAttachment(ctx: Ctx, expenseId: string, meta: AttachmentMeta, messageId?: string | null) {
  const e = (await ctx.tx.select().from(expenses).where(and(eq(expenses.id, expenseId), notDeleted)))[0];
  if (!e) throw notFound('Expense');
  if (e.userId !== ctx.actor.id) throw forbidden('You can add receipts only to your own expenses.', 'not_owner');
  const m = (await getMember(ctx.tx, e.tripId, e.userId))!;
  if (claimLocked(m)) throw conflict('claim_locked', 'Your claim has been reimbursed and is locked.');
  if (e.verification === 'verified' || e.verification === 'rejected') throw conflict('expense_settled', `Finance has already ${e.verification} this expense.`);
  if (m.actualEnd && e.verification !== 'query') throw conflict('expense_locked', 'You ended the trip, so only expenses finance queried can change.');
  if (meta.clientId) {
    const ex = (await ctx.tx.select().from(attachments).where(and(eq(attachments.uploadedBy, e.userId), eq(attachments.clientId, meta.clientId))))[0];
    if (ex) return ex;
  }
  const n = await ctx.tx.select({ c: sql<number>`count(*)` }).from(attachments).where(and(eq(attachments.expenseId, e.id), eq(attachments.kind, 'receipt'), isNull(attachments.deletedAt)));
  if (Number(n[0].c) >= MAX_ATTACHMENTS) throw conflict('too_many_files', `Up to ${MAX_ATTACHMENTS} files per expense.`);
  const [a] = await ctx.tx.insert(attachments).values({
    clientId: meta.clientId ?? null, kind: 'receipt', tripId: e.tripId, expenseId: e.id, memberUserId: e.userId, messageId: messageId ?? null,
    originalName: meta.name, mime: meta.mime, sizeBytes: meta.size, capturedAt: meta.capturedAt ?? null, status: 'pending', uploadedBy: e.userId, createdAt: ctx.now,
  }).returning();
  await ctx.tx.update(expenses).set({ updatedAt: ctx.now, version: sql`${expenses.version} + 1` }).where(eq(expenses.id, e.id));
  await audit(ctx, { action: 'attachment.add', entity: 'attachment', entityId: a.id, tripId: e.tripId, memberUserId: e.userId, meta: { expenseId: e.id, name: a.originalName } });
  return a;
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/msword': 'doc' };
export const extFor = (mime: string, name = '') => EXT[mime] ?? (name.includes('.') ? name.split('.').pop()!.toLowerCase() : 'bin');

/** Store the bytes of a pending attachment. Only its uploader may send them; re-sending is harmless. */
export async function uploadContent(ctx: Ctx, attachmentId: string, body: Buffer, mime: string) {
  const a = (await ctx.tx.select().from(attachments).where(and(eq(attachments.id, attachmentId), isNull(attachments.deletedAt))).for('update'))[0];
  if (!a) throw notFound('Attachment');
  if (a.uploadedBy !== ctx.actor.id) throw forbidden('Only the person who added this file can upload it.', 'not_owner');
  if (!body.length) throw badRequest('empty_file', 'The file is empty.');
  const realMime = mime && mime !== 'application/octet-stream' ? mime : a.mime;
  const key = `${a.kind === 'receipt' ? 'receipts' : 'documents'}/${a.tripId}/${a.expenseId ?? 'trip'}/${a.id}.${extFor(realMime, a.originalName)}`;
  let width: number | null = null, height: number | null = null;
  if (realMime.startsWith('image/')) {
    try { const meta = await sharp(body).metadata(); width = meta.width ?? null; height = meta.height ?? null; } catch { throw badRequest('bad_image', 'The image could not be read.'); }
  }
  await storage.put(key, body, realMime);
  const [u] = await ctx.tx.update(attachments).set({ storageKey: key, mime: realMime, sizeBytes: body.length, width, height, sha256: crypto.createHash('sha256').update(body).digest('hex'), status: 'uploaded', uploadedAt: ctx.now })
    .where(eq(attachments.id, a.id)).returning();
  if (a.expenseId) {
    await ctx.tx.update(expenses).set({ updatedAt: ctx.now }).where(eq(expenses.id, a.expenseId));
    ctx.after.push(() => tripChanged(a.tripId, 'attachment', { expenseId: a.expenseId, attachmentId: a.id }));
  }
  return u;
}

export async function deleteAttachment(ctx: Ctx, attachmentId: string) {
  const a = (await ctx.tx.select().from(attachments).where(and(eq(attachments.id, attachmentId), isNull(attachments.deletedAt))))[0];
  if (!a) throw notFound('Attachment');
  if (a.kind !== 'receipt' || !a.expenseId) throw forbidden('Finance documents are removed in the web app.');
  const { e } = await ownExpenseForChange(ctx, a.expenseId, 'attach');
  const n = await ctx.tx.select({ c: sql<number>`count(*)` }).from(attachments).where(and(eq(attachments.expenseId, e.id), eq(attachments.kind, 'receipt'), isNull(attachments.deletedAt)));
  if (e.paidBy === 'self' && Number(n[0].c) <= 1) throw conflict('last_receipt', 'A self-paid expense needs at least one receipt. Add another before deleting this one.');
  await ctx.tx.update(attachments).set({ deletedAt: ctx.now, deletedBy: ctx.actor.id }).where(eq(attachments.id, a.id));
  await ctx.tx.update(expenses).set({ updatedAt: ctx.now, version: sql`${expenses.version} + 1` }).where(eq(expenses.id, e.id));
  await audit(ctx, { action: 'attachment.delete', entity: 'attachment', entityId: a.id, tripId: a.tripId, memberUserId: a.memberUserId, meta: { expenseId: e.id } });
  ctx.after.push(() => tripChanged(a.tripId, 'attachment', { expenseId: e.id }));
}

/**
 * FR-VER-03: the member answers a query with text and optionally new files (added as placeholders).
 * After a rejection or a lower approval the member may still write to finance about it ("Ask finance", M10·b/c):
 * that message is a dispute and does not reopen the decision. A replayed clientId returns the first reply (NFR-02).
 */
export async function replyToQuery(ctx: Ctx, expenseId: string, body: string, files: AttachmentMeta[] = [], clientId?: string | null) {
  const e = (await ctx.tx.select().from(expenses).where(and(eq(expenses.id, expenseId), notDeleted)))[0];
  if (!e) throw notFound('Expense');
  if (e.userId !== ctx.actor.id) throw forbidden('Only the member who logged the expense can reply.', 'not_owner');
  if (clientId) {
    const prior = (await ctx.tx.select().from(expenseMessages).where(and(eq(expenseMessages.authorId, e.userId), eq(expenseMessages.clientId, clientId))))[0];
    if (prior) {
      const ups = await ctx.tx.select().from(attachments).where(and(eq(attachments.messageId, prior.id), isNull(attachments.deletedAt)));
      return { message: prior, uploads: ups.map(u => ({ attachmentId: u.id, clientId: u.clientId, status: u.status, uploadPath: `/api/v1/attachments/${u.id}/content` })), idempotent: true };
    }
  }
  const lowered = e.verification === 'verified' && e.approvedPaise != null && e.approvedPaise !== e.amountPaise;
  const kind = e.verification === 'query' ? 'reply' as const : (e.verification === 'rejected' || lowered) ? 'dispute' as const : null;
  if (!kind) throw conflict('no_open_query', 'There is no open question on this expense.');
  const m = (await getMember(ctx.tx, e.tripId, e.userId))!;
  if (kind === 'dispute' && claimLocked(m)) throw conflict('claim_locked', 'Your claim has been reimbursed and is locked.');
  if (kind === 'dispute' && files.length) throw badRequest('validation', 'Attach files to an open query only.', [{ field: 'attachments', message: 'Not after a decision.' }]);
  if (!body.trim() && !files.length) throw badRequest('validation', 'Write a reply or attach a file.', [{ field: 'body', message: 'Required.' }]);
  const [msg] = await ctx.tx.insert(expenseMessages).values({ clientId: clientId ?? null, expenseId, tripId: e.tripId, authorId: e.userId, side: 'member', kind, body: body.trim(), createdAt: ctx.now }).returning();
  const uploads = [];
  for (const f of files) uploads.push(await addAttachment(ctx, expenseId, f, msg.id));
  await ctx.tx.update(expenses).set({ updatedAt: ctx.now, version: sql`${expenses.version} + 1` }).where(eq(expenses.id, e.id));
  await audit(ctx, { action: kind === 'reply' ? 'expense.reply' : 'expense.dispute', entity: 'expense', entityId: e.id, tripId: e.tripId, memberUserId: e.userId, meta: { files: files.length } });
  await notifyFinance(ctx, kind === 'reply'
    ? { type: 'query.reply', tripId: e.tripId, title: `${firstName(ctx.actor.name)} replied to your query`, body: `${e.description} · ${inr(e.amountPaise)}${files.length ? ` · ${files.length} new attachment${files.length > 1 ? 's' : ''}` : ''}`, data: { tripId: e.tripId, expenseId: e.id, userId: e.userId } }
    : { type: 'expense.disputed', tripId: e.tripId, title: `${firstName(ctx.actor.name)} asks about a ${e.verification === 'rejected' ? 'rejected' : 'lowered'} expense`, body: `${e.description} · ${inr(e.amountPaise)}: ${body.trim()}`, data: { tripId: e.tripId, expenseId: e.id, userId: e.userId } });
  ctx.after.push(() => tripChanged(e.tripId, 'reply', { expenseId: e.id, userId: e.userId }));
  return { message: msg, uploads: uploads.map(u => ({ attachmentId: u.id, clientId: u.clientId, status: u.status, uploadPath: `/api/v1/attachments/${u.id}/content` })), idempotent: false };
}

/**
 * Move an own expense to another trip the member is on, until it is verified (M09·i edge: two trips running).
 * The location defaults to the one covering the date on the target trip; the budget source is decided again there.
 */
export async function moveExpense(ctx: Ctx, expenseId: string, target: { tripId: string; locationId?: string | null; budgetSource?: 'pool' | 'individual' | null }) {
  const { e } = await ownExpenseForChange(ctx, expenseId, 'edit');
  if (target.tripId === e.tripId) throw badRequest('validation', 'Pick a different trip.', [{ field: 'tripId', message: 'Same trip.' }]);
  const trip = await getTrip(ctx.tx, target.tripId, true);
  const tm = await getMember(ctx.tx, target.tripId, e.userId, true);
  if (!isAccepted(tm)) throw forbidden('You are not a member of that trip.', 'not_member');
  if (trip.status === 'cancelled') throw conflict('trip_cancelled', 'That trip was cancelled.');
  if (claimLocked(tm!)) throw conflict('claim_locked', 'Your claim on that trip has been reimbursed and is locked.');
  if (!tm!.actualStart && e.spentAt >= trip.scheduledStart) throw conflict('not_started', 'Start that trip first, or keep the expense where it is.');
  let location;
  if (target.locationId) {
    location = (await ctx.tx.select().from(locations).where(and(eq(locations.id, target.locationId), eq(locations.tripId, trip.id), isNull(locations.deletedAt))))[0];
    if (!location) throw badRequest('validation', 'Pick a location of that trip.', [{ field: 'locationId', message: 'Unknown location.' }]);
  } else location = await defaultLocation(ctx, trip.id, istDate(e.spentAt));
  const source = await resolveSource(ctx, trip.id, e.userId, e.paidBy, target.budgetSource);
  const flags = entryFlags(trip, tm!, e.spentAt, ctx.now, e.deviceTime);
  const [u] = await ctx.tx.update(expenses).set({ tripId: trip.id, locationId: location.id, budgetSource: source, needsBudgetChoice: false, flags, updatedAt: ctx.now, version: sql`${expenses.version} + 1` })
    .where(eq(expenses.id, e.id)).returning();
  await ctx.tx.update(attachments).set({ tripId: trip.id }).where(eq(attachments.expenseId, e.id));
  await ctx.tx.update(expenseMessages).set({ tripId: trip.id }).where(eq(expenseMessages.expenseId, e.id));
  await audit(ctx, { action: 'expense.move', entity: 'expense', entityId: e.id, tripId: e.tripId, memberUserId: e.userId, before: { tripId: e.tripId, locationId: e.locationId, budgetSource: e.budgetSource }, after: { tripId: trip.id, locationId: location.id, budgetSource: source } });
  await audit(ctx, { action: 'expense.move', entity: 'expense', entityId: e.id, tripId: trip.id, memberUserId: e.userId, before: { tripId: e.tripId }, after: { tripId: trip.id } });
  await checkBudgetAlerts(ctx, e.tripId);
  await checkBudgetAlerts(ctx, trip.id);
  await recomputeClaim(ctx, e.tripId, e.userId);
  await recomputeClaim(ctx, trip.id, e.userId);
  ctx.after.push(() => { tripChanged(e.tripId, 'expense', { expenseId: e.id, moved: true }); tripChanged(trip.id, 'expense', { expenseId: e.id, moved: true }); });
  return u;
}

/**
 * FR-BUD-07: crossing 80% and 100% each raise one notification per budget (pool: members and finance;
 * individual: that member and finance, no amounts on the lock screen). Dropping below re-arms the alert.
 */
export async function checkBudgetAlerts(ctx: Ctx, tripId: string) {
  const bs = await activeBudgets(ctx.tx, tripId);
  const views = [];
  let ms: Member[] | null = null;
  const trip = await getTrip(ctx.tx, tripId);
  for (const b of bs) {
    const v = await budgetView(ctx.tx, b);
    views.push(v);
    const level = budgetLevel(v.spentPaise, v.allocatedPaise);
    if (level === b.alertLevel) continue;
    await ctx.tx.update(budgets).set({ alertLevel: level }).where(eq(budgets.id, b.id));
    if (level < b.alertLevel || level === 0) continue;
    ms ??= await getMembers(ctx.tx, tripId);
    const label = b.type === 'pool' ? 'Trip pool' : 'Individual budget';
    const over = v.remainingPaise < 0;
    const title = level >= 100 ? (over ? `${label} is over budget` : `${label} is fully used`) : `${label} is ${v.pct}% used`;
    const body = level >= 100
      ? (over ? `${trip.name}: over by ${inr(-v.remainingPaise)}. Expenses still save.` : `${trip.name}: all ${inr(v.allocatedPaise)} is used. Expenses still save.`)
      : `${trip.name}: ${inr(v.remainingPaise)} left of ${inr(v.allocatedPaise)}.`;
    const recipients = b.type === 'pool' ? acceptedIds(ms) : [b.memberUserId!];
    await notify(ctx, recipients, { type: level >= 100 ? 'budget.over' : 'budget.warn', tripId, title, body, sensitive: b.type === 'individual', data: { tripId, budgetType: b.type } });
    await notifyFinance(ctx, { type: level >= 100 ? 'budget.over' : 'budget.warn', tripId, title: `${trip.ref}: ${title.toLowerCase()}`, body, data: { tripId, budgetType: b.type, userId: b.memberUserId } });
    await audit(ctx, { action: 'budget.alert', entity: 'budget', entityId: b.id, tripId, memberUserId: b.memberUserId, meta: { level, pct: v.pct } });
  }
  return views;
}

/** Expense history (NFR-11): members see their own expense's history, finance sees everything. */
export async function expenseHistory(ctx: Ctx, expenseId: string) {
  const rows = await ctx.tx.select().from(auditLog).where(and(eq(auditLog.entityId, expenseId))).orderBy(desc(auditLog.at));
  const att = await ctx.tx.select({ id: attachments.id }).from(attachments).where(eq(attachments.expenseId, expenseId));
  const attRows = att.length ? await ctx.tx.select().from(auditLog).where(inArray(auditLog.entityId, att.map(a => a.id))) : [];
  return [...rows, ...attRows].sort((a, b) => b.at.getTime() - a.at.getTime()).map(r => ({ at: r.at, action: r.action, actor: r.actorLabel, before: r.before, after: r.after, meta: r.meta }));
}

export { addDays };
