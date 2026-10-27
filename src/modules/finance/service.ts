/**
 * Finance actions (SRS §6, §7): budgets with the rules of FR-BUD-01..06, verification (FR-VER-01..05),
 * reimbursement (FR-VER-06..09) and finance documents (FR-WEB-06). FR-VER-10 is enforced on every action.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import type { Ctx } from '../../lib/context.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { inr } from '../../lib/money.js';
import { notify } from '../../lib/notify.js';
import { tripChanged } from '../../lib/realtime.js';
import { storage } from '../../lib/storage.js';
import { istDate, istLabel } from '../../lib/time.js';
import {
  acceptedIds, activeBudgets, budgetView, claimLocked, claimTotals, firstName, getMember, getMembers, getTrip, heldBudgets, isAccepted,
  notDeleted, recomputeClaim, userNames, type Budget, type Trip,
} from '../domain.js';
import { checkBudgetAlerts, extFor } from '../expenses/service.js';
import crypto from 'node:crypto';

const { budgets, budgetChanges, expenses, expenseMessages, attachments, payments, tripMembers } = schema;

async function notOnTrip(ctx: Ctx, tripId: string, what: string) {
  const m = await getMember(ctx.tx, tripId, ctx.actor.id!);
  if (isAccepted(m)) throw forbidden(`You are a member of this trip, so another finance user must ${what}.`, 'finance_member_of_trip');
}

/* ================= budgets ================= */

export interface BudgetSet { type: 'pool' | 'individual'; memberUserId?: string | null; amountPaise: number; note?: string | null }

/** Insert or change one budget row, log it (FR-BUD-06) and tell the right people. Earlier expenses are resolved by the caller. */
async function upsertBudgetRow(ctx: Ctx, trip: Trip, input: BudgetSet) {
  if (input.type === 'individual') {
    if (!input.memberUserId) throw badRequest('validation', 'Pick the member.', [{ field: 'memberUserId', message: 'Required.' }]);
    if (!isAccepted(await getMember(ctx.tx, trip.id, input.memberUserId))) throw unprocessable('not_member', 'Individual budgets are for members who accepted.');
  }
  const bs = await activeBudgets(ctx.tx, trip.id);
  const existing = bs.find(b => b.type === input.type && (input.type === 'pool' || b.memberUserId === input.memberUserId));
  if (existing && existing.amountPaise === input.amountPaise) return { b: existing, created: false, changed: false };
  let b: Budget;
  if (existing) {
    [b] = await ctx.tx.update(budgets).set({ amountPaise: input.amountPaise, setBy: ctx.actor.id!, updatedAt: ctx.now }).where(eq(budgets.id, existing.id)).returning();
  } else {
    [b] = await ctx.tx.insert(budgets).values({ tripId: trip.id, type: input.type, memberUserId: input.type === 'individual' ? input.memberUserId! : null, amountPaise: input.amountPaise, setBy: ctx.actor.id!, setAt: ctx.now, updatedAt: ctx.now }).returning();
  }
  await ctx.tx.insert(budgetChanges).values({ tripId: trip.id, budgetId: b.id, type: b.type, memberUserId: b.memberUserId, oldPaise: existing?.amountPaise ?? null, newPaise: b.amountPaise, note: input.note ?? null, changedBy: ctx.actor.id!, changedAt: ctx.now });
  await audit(ctx, { action: existing ? 'budget.change' : 'budget.set', entity: 'budget', entityId: b.id, tripId: trip.id, memberUserId: b.memberUserId, before: existing ? { amountPaise: existing.amountPaise } : undefined, after: { amountPaise: b.amountPaise, note: input.note ?? null } });
  const ms = await getMembers(ctx.tx, trip.id);
  const label = b.type === 'pool' ? 'Trip pool' : 'Your individual budget';
  const body = b.type === 'pool' ? `${trip.name}: ${inr(b.amountPaise)}${existing ? `, was ${inr(existing.amountPaise)}` : ''}.` : `${trip.name}: ${inr(b.amountPaise)}. Only you and finance see it.`;
  await notify(ctx, b.type === 'pool' ? acceptedIds(ms) : [b.memberUserId!], { type: 'budget.set', tripId: trip.id, title: `${label} ${existing ? 'changed' : 'set'}`, body, sensitive: b.type === 'individual', data: { tripId: trip.id, budgetType: b.type } });
  return { b, created: !existing, changed: true };
}

/** FR-BUD-05: a removed budget returns its expenses to Unbudgeted; nothing moves into another budget by itself. */
async function removeBudgetRow(ctx: Ctx, trip: Trip, type: 'pool' | 'individual', memberUserId: string | null | undefined, note?: string | null) {
  const bs = await activeBudgets(ctx.tx, trip.id);
  const b = bs.find(x => x.type === type && (type === 'pool' || x.memberUserId === memberUserId));
  if (!b) throw notFound('Budget');
  await ctx.tx.update(budgets).set({ removedAt: ctx.now, removedBy: ctx.actor.id, updatedAt: ctx.now }).where(eq(budgets.id, b.id));
  const locked = (await getMembers(ctx.tx, trip.id)).filter(claimLocked).map(m => m.userId);
  const cond = and(eq(expenses.tripId, trip.id), eq(expenses.budgetSource, type), notDeleted, type === 'individual' ? eq(expenses.userId, memberUserId!) : sql`true`,
    locked.length ? sql`${expenses.userId} not in (${sql.join(locked.map(l => sql`${l}`), sql`, `)})` : sql`true`);
  const moved = await ctx.tx.update(expenses).set({ budgetSource: 'unbudgeted', updatedAt: ctx.now, version: sql`${expenses.version} + 1` }).where(cond).returning({ id: expenses.id, userId: expenses.userId });
  // Nobody still holds both budgets for these members, so pending choices fall away.
  await ctx.tx.update(expenses).set({ needsBudgetChoice: false }).where(and(eq(expenses.tripId, trip.id), eq(expenses.needsBudgetChoice, true), type === 'individual' ? eq(expenses.userId, memberUserId!) : sql`true`));
  await ctx.tx.insert(budgetChanges).values({ tripId: trip.id, budgetId: b.id, type: b.type, memberUserId: b.memberUserId, oldPaise: b.amountPaise, newPaise: null, note: note ?? null, changedBy: ctx.actor.id!, changedAt: ctx.now });
  await audit(ctx, { action: 'budget.remove', entity: 'budget', entityId: b.id, tripId: trip.id, memberUserId: b.memberUserId, before: { amountPaise: b.amountPaise }, meta: { note, expensesToUnbudgeted: moved.length } });
  const ms = await getMembers(ctx.tx, trip.id);
  await notify(ctx, type === 'pool' ? acceptedIds(ms) : [memberUserId!], { type: 'budget.removed', tripId: trip.id, title: type === 'pool' ? 'Trip pool removed' : 'Your individual budget was removed', body: `${trip.name}: ${moved.length ? `${moved.length} expenses are now unbudgeted and private to their member.` : 'Expenses still save as usual.'}`, sensitive: type === 'individual', data: { tripId: trip.id } });
  return { moved: moved.map(m => m.id) };
}

/**
 * FR-BUD-03: earlier unbudgeted expenses of the given members are charged to the one budget they hold after the change,
 * or flagged for the member to choose when they hold both. `onlyIds` limits this to expenses that were unbudgeted before
 * the save, so expenses a removal just returned to Unbudgeted stay there (FR-BUD-05).
 */
async function resolveEarlierExpenses(ctx: Ctx, trip: Trip, memberIds: string[], onlyIds?: Set<string>) {
  const ms = (await getMembers(ctx.tx, trip.id)).filter(m => isAccepted(m) && !claimLocked(m) && memberIds.includes(m.userId));
  let charged = 0;
  const choose: string[] = [];
  for (const m of ms) {
    const held = await heldBudgets(ctx.tx, trip.id, m.userId);
    if (!held.pool && !held.individual) continue;
    const rows = await ctx.tx.select({ id: expenses.id }).from(expenses)
      .where(and(eq(expenses.tripId, trip.id), eq(expenses.userId, m.userId), eq(expenses.budgetSource, 'unbudgeted'), eq(expenses.paidBy, 'self'), notDeleted));
    const ids = rows.map(r => r.id).filter(id => !onlyIds || onlyIds.has(id));
    if (!ids.length) continue;
    if (held.pool && held.individual) {
      await ctx.tx.update(expenses).set({ needsBudgetChoice: true, updatedAt: ctx.now, version: sql`${expenses.version} + 1` }).where(inArray(expenses.id, ids));
      choose.push(m.userId);
    } else {
      const to = held.pool ? 'pool' as const : 'individual' as const;
      await ctx.tx.update(expenses).set({ budgetSource: to, needsBudgetChoice: false, updatedAt: ctx.now, version: sql`${expenses.version} + 1` }).where(inArray(expenses.id, ids));
      charged += ids.length;
      await audit(ctx, { action: 'budget.apply', entity: 'budget', entityId: (held.pool ?? held.individual)!.id, tripId: trip.id, memberUserId: to === 'pool' ? null : m.userId, meta: { expenses: ids.length, to, member: m.userId } });
    }
  }
  for (const uid of choose) {
    await notify(ctx, [uid], { type: 'budget.choose', tripId: trip.id, title: 'Choose a budget for earlier expenses', body: `${trip.name}: you now hold the trip pool and your own budget. Pick one for each earlier expense.`, sensitive: true, data: { tripId: trip.id } });
  }
  return { charged, choose };
}

/** FR-BUD-01/03/06: set or change one budget; earlier expenses are charged to it, or the member is asked to choose. */
export async function setBudget(ctx: Ctx, tripId: string, input: BudgetSet) {
  const trip = await getTrip(ctx.tx, tripId, true);
  if (trip.status === 'cancelled') throw conflict('trip_cancelled', 'The trip was cancelled.');
  await notOnTrip(ctx, tripId, 'set its budgets');
  const r = await upsertBudgetRow(ctx, trip, input);
  if (r.created) {
    const ms = (await getMembers(ctx.tx, tripId)).filter(isAccepted).map(m => m.userId);
    await resolveEarlierExpenses(ctx, trip, r.b.type === 'pool' ? ms : [r.b.memberUserId!]);
  }
  if (r.changed) {
    await checkBudgetAlerts(ctx, tripId);
    ctx.after.push(() => tripChanged(tripId, 'budget'));
  }
  return r.b;
}

/** FR-BUD-05: removing a budget returns its expenses to Unbudgeted; nothing moves into another budget by itself. */
export async function removeBudget(ctx: Ctx, tripId: string, type: 'pool' | 'individual', memberUserId?: string | null, note?: string | null) {
  const trip = await getTrip(ctx.tx, tripId, true);
  await notOnTrip(ctx, tripId, 'change its budgets');
  const r = await removeBudgetRow(ctx, trip, type, memberUserId, note);
  await checkBudgetAlerts(ctx, tripId);
  ctx.after.push(() => tripChanged(tripId, 'budget'));
  return { moved: r.moved.length };
}

export interface BudgetBatch {
  pool?: { amountPaise: number; note?: string | null } | null;
  individuals?: Record<string, { amountPaise: number; note?: string | null } | null>;
  note?: string | null;
}

/**
 * The whole W05 save in one transaction. Earlier expenses are resolved once, against the budgets each member holds
 * after the save, exactly as the preview promised: a member given both budgets at once is asked to choose (FR-BUD-03).
 */
export async function setBudgets(ctx: Ctx, tripId: string, batch: BudgetBatch) {
  const trip = await getTrip(ctx.tx, tripId, true);
  if (trip.status === 'cancelled') throw conflict('trip_cancelled', 'The trip was cancelled.');
  await notOnTrip(ctx, tripId, 'set its budgets');
  const members = (await getMembers(ctx.tx, tripId)).filter(isAccepted).map(m => m.userId);
  const before = await ctx.tx.select({ id: expenses.id }).from(expenses).where(and(eq(expenses.tripId, tripId), eq(expenses.budgetSource, 'unbudgeted'), eq(expenses.paidBy, 'self'), notDeleted));
  const unbudgetedBefore = new Set(before.map(r => r.id));
  const bs = await activeBudgets(ctx.tx, tripId);
  const affected = new Set<string>();
  let changes = 0;
  // Removals first, so a removed budget's expenses are back in Unbudgeted before anything new applies.
  if (batch.pool === null && bs.some(b => b.type === 'pool')) { await removeBudgetRow(ctx, trip, 'pool', null, batch.note); changes++; }
  for (const [uid, v] of Object.entries(batch.individuals ?? {})) {
    if (v === null && bs.some(b => b.type === 'individual' && b.memberUserId === uid)) { await removeBudgetRow(ctx, trip, 'individual', uid, batch.note); changes++; }
  }
  if (batch.pool) {
    const r = await upsertBudgetRow(ctx, trip, { type: 'pool', amountPaise: batch.pool.amountPaise, note: batch.pool.note ?? batch.note });
    if (r.changed) changes++;
    if (r.created) members.forEach(m => affected.add(m));
  }
  for (const [uid, v] of Object.entries(batch.individuals ?? {})) {
    if (!v) continue;
    const r = await upsertBudgetRow(ctx, trip, { type: 'individual', memberUserId: uid, amountPaise: v.amountPaise, note: v.note ?? batch.note });
    if (r.changed) changes++;
    if (r.created) affected.add(uid);
  }
  const resolved = affected.size ? await resolveEarlierExpenses(ctx, trip, [...affected], unbudgetedBefore) : { charged: 0, choose: [] as string[] };
  if (changes) {
    await checkBudgetAlerts(ctx, tripId);
    ctx.after.push(() => tripChanged(tripId, 'budget'));
  }
  return { changes, charged: resolved.charged, askedToChoose: resolved.choose };
}

/** The W05 impact panel: what each proposed change would do to earlier expenses, before saving. */
export async function previewBudgets(ctx: Ctx, tripId: string, pool: number | null | undefined, individuals: Record<string, number | null>) {
  const bs = await activeBudgets(ctx.tx, tripId);
  const ms = (await getMembers(ctx.tx, tripId)).filter(isAccepted);
  const names = await userNames(ctx.tx, ms.map(m => m.userId));
  const hasPool = (pool === undefined ? !!bs.find(b => b.type === 'pool') : pool !== null);
  const out = [];
  for (const m of ms) {
    const had = { pool: !!bs.find(b => b.type === 'pool'), ind: !!bs.find(b => b.type === 'individual' && b.memberUserId === m.userId) };
    const will = { pool: hasPool, ind: m.userId in individuals ? individuals[m.userId] !== null : had.ind };
    const rows = await ctx.tx.select({ src: expenses.budgetSource, c: sql<number>`count(*)`, s: sql<number>`coalesce(sum(${expenses.amountPaise}),0)` }).from(expenses)
      .where(and(eq(expenses.tripId, tripId), eq(expenses.userId, m.userId), eq(expenses.paidBy, 'self'), notDeleted)).groupBy(expenses.budgetSource);
    const get = (s: string) => rows.find(r => r.src === s) ?? { c: 0, s: 0 };
    const unb = get('unbudgeted');
    const effect: Record<string, { count: number; paise: number }> = {};
    if (Number(unb.c) > 0 && (will.pool || will.ind)) {
      if (will.pool && will.ind) effect.needChoice = { count: Number(unb.c), paise: Number(unb.s) };
      else effect[will.pool ? 'toPool' : 'toIndividual'] = { count: Number(unb.c), paise: Number(unb.s) };
    }
    if (had.pool && !will.pool && Number(get('pool').c) > 0) effect.poolToUnbudgeted = { count: Number(get('pool').c), paise: Number(get('pool').s) };
    if (had.ind && !will.ind && Number(get('individual').c) > 0) effect.individualToUnbudgeted = { count: Number(get('individual').c), paise: Number(get('individual').s) };
    out.push({ userId: m.userId, name: names.get(m.userId)?.name ?? '', effect });
  }
  return { members: out };
}

export async function budgetLog(ctx: Ctx, tripId: string) {
  const rows = await ctx.tx.select().from(budgetChanges).where(eq(budgetChanges.tripId, tripId)).orderBy(desc(budgetChanges.changedAt));
  const names = await userNames(ctx.tx, [...rows.map(r => r.changedBy), ...rows.map(r => r.memberUserId).filter((x): x is string => !!x)]);
  return rows.map(r => ({ id: r.id, at: r.changedAt, type: r.type, memberUserId: r.memberUserId, memberName: r.memberUserId ? names.get(r.memberUserId)?.name ?? '' : null, oldPaise: r.oldPaise, newPaise: r.newPaise, note: r.note, by: names.get(r.changedBy)?.name ?? '' }));
}

/* ================= verification ================= */

async function expenseForDecision(ctx: Ctx, expenseId: string, version: number) {
  const e = (await ctx.tx.select().from(expenses).where(and(eq(expenses.id, expenseId), notDeleted)).for('update'))[0];
  if (!e) throw notFound('Expense');
  if (e.userId === ctx.actor.id) throw forbidden('This is your own claim. Another finance user must verify it.', 'own_claim');
  const m = (await getMember(ctx.tx, e.tripId, e.userId))!;
  if (claimLocked(m)) throw conflict('claim_locked', 'The claim is reimbursed and locked. Reopen it with a reason to make a correction.');
  if (e.version !== version) {
    // W06·f: the member changed the expense while finance was looking at it.
    throw conflict('stale_version', 'The member changed this expense while you were reviewing it. Review the new version.', { currentVersion: e.version, updatedAt: e.updatedAt });
  }
  return { e, m };
}

async function afterDecision(ctx: Ctx, tripId: string, userId: string, expenseId: string) {
  await recomputeClaim(ctx, tripId, userId);
  await checkBudgetAlerts(ctx, tripId);
  ctx.after.push(() => tripChanged(tripId, 'verification', { expenseId, userId }));
}

/** FR-VER-01/02: verify, optionally at a lower amount with a reason. A receipt still on the phone blocks it (W06·i). */
export async function verifyExpense(ctx: Ctx, expenseId: string, version: number, approvedPaise?: number | null, reason?: string | null) {
  const { e } = await expenseForDecision(ctx, expenseId, version);
  const files = await ctx.tx.select().from(attachments).where(and(eq(attachments.expenseId, e.id), eq(attachments.kind, 'receipt'), isNull(attachments.deletedAt)));
  if (files.some(f => f.status !== 'uploaded')) throw conflict('receipt_pending', 'A receipt is still on the member’s phone. Remind them, or query or reject instead.');
  if (e.paidBy === 'self' && files.length === 0) throw conflict('receipt_missing', 'This self-paid expense has no receipt.');
  let approved: number | null = null;
  if (approvedPaise != null && approvedPaise !== e.amountPaise) {
    if (approvedPaise <= 0 || approvedPaise > e.amountPaise) throw badRequest('validation', 'The approved amount must be between ₹0.01 and the amount claimed.', [{ field: 'approvedPaise', message: 'Out of range.' }]);
    if (!reason?.trim()) throw badRequest('validation', 'Give a reason for the lower amount.', [{ field: 'reason', message: 'Required.' }]);
    approved = approvedPaise;
  }
  const [u] = await ctx.tx.update(expenses).set({ verification: 'verified', approvedPaise: approved, approvalReason: approved ? reason!.trim() : null, verifiedBy: ctx.actor.id, verifiedAt: ctx.now, updatedAt: ctx.now, version: sql`${expenses.version} + 1` }).where(eq(expenses.id, e.id)).returning();
  if (approved) await ctx.tx.insert(expenseMessages).values({ expenseId: e.id, tripId: e.tripId, authorId: ctx.actor.id!, side: 'finance', kind: 'note', body: `Approved at ${inr(approved)} of ${inr(e.amountPaise)}. ${reason!.trim()}`, createdAt: ctx.now });
  await audit(ctx, { action: 'expense.verify', entity: 'expense', entityId: e.id, tripId: e.tripId, memberUserId: e.userId, before: { verification: e.verification, approvedPaise: e.approvedPaise }, after: { verification: 'verified', approvedPaise: approved }, meta: { approvedPaise: approved, reason: reason ?? null } });
  if (approved) {
    await notify(ctx, [e.userId], { type: 'expense.lowered', tripId: e.tripId, title: 'Expense verified at a lower amount', body: `${e.description}: ${inr(approved)} of ${inr(e.amountPaise)} approved. ${reason!.trim()}`, data: { tripId: e.tripId, expenseId: e.id } });
  }
  await afterDecision(ctx, e.tripId, e.userId, e.id);
  return u;
}

/** FR-VER-01/03: a question for the member; the thread stays on the expense. */
export async function queryExpense(ctx: Ctx, expenseId: string, version: number, remark: string) {
  if (!remark?.trim()) throw badRequest('validation', 'Write the question for the member.', [{ field: 'remark', message: 'Required.' }]);
  const { e } = await expenseForDecision(ctx, expenseId, version);
  const [u] = await ctx.tx.update(expenses).set({ verification: 'query', financeRemark: remark.trim(), verifiedBy: ctx.actor.id, verifiedAt: ctx.now, updatedAt: ctx.now, version: sql`${expenses.version} + 1` }).where(eq(expenses.id, e.id)).returning();
  await ctx.tx.insert(expenseMessages).values({ expenseId: e.id, tripId: e.tripId, authorId: ctx.actor.id!, side: 'finance', kind: 'query', body: remark.trim(), createdAt: ctx.now });
  await audit(ctx, { action: 'expense.query', entity: 'expense', entityId: e.id, tripId: e.tripId, memberUserId: e.userId, before: { verification: e.verification }, after: { verification: 'query' }, meta: { remark: remark.trim() } });
  await notify(ctx, [e.userId], { type: 'expense.query', tripId: e.tripId, title: 'Finance has a question', body: `${e.description} · ${inr(e.amountPaise)}: ${remark.trim()}`, data: { tripId: e.tripId, expenseId: e.id } });
  await afterDecision(ctx, e.tripId, e.userId, e.id);
  return u;
}

/** FR-VER-01/04: rejected expenses stay on the claim, excluded from the total and the budget. */
export async function rejectExpense(ctx: Ctx, expenseId: string, version: number, remark: string) {
  if (!remark?.trim()) throw badRequest('validation', 'Give the reason for rejecting.', [{ field: 'remark', message: 'Required.' }]);
  const { e } = await expenseForDecision(ctx, expenseId, version);
  const [u] = await ctx.tx.update(expenses).set({ verification: 'rejected', approvedPaise: null, financeRemark: remark.trim(), verifiedBy: ctx.actor.id, verifiedAt: ctx.now, updatedAt: ctx.now, version: sql`${expenses.version} + 1` }).where(eq(expenses.id, e.id)).returning();
  await ctx.tx.insert(expenseMessages).values({ expenseId: e.id, tripId: e.tripId, authorId: ctx.actor.id!, side: 'finance', kind: 'reject', body: remark.trim(), createdAt: ctx.now });
  await audit(ctx, { action: 'expense.reject', entity: 'expense', entityId: e.id, tripId: e.tripId, memberUserId: e.userId, before: { verification: e.verification }, after: { verification: 'rejected' }, meta: { remark: remark.trim() } });
  await notify(ctx, [e.userId], { type: 'expense.rejected', tripId: e.tripId, title: 'Expense rejected', body: `${e.description} · ${inr(e.amountPaise)}: ${remark.trim()}`, data: { tripId: e.tripId, expenseId: e.id } });
  await afterDecision(ctx, e.tripId, e.userId, e.id);
  return u;
}

/** FR-VER-05: verify several at once; flagged, pending-receipt or changed items are reported, not forced. */
export async function bulkVerify(ctx: Ctx, items: Array<{ id: string; version: number }>, includeFlagged = false) {
  const results: Array<{ id: string; ok: boolean; code?: string; message?: string }> = [];
  for (const it of items) {
    try {
      const e = (await ctx.tx.select().from(expenses).where(eq(expenses.id, it.id)))[0];
      if (e && e.flags.length && !includeFlagged) { results.push({ id: it.id, ok: false, code: 'flagged', message: e.flags.join(', ') }); continue; }
      await ctx.tx.transaction(async sp => { await verifyExpense({ ...ctx, tx: sp }, it.id, it.version); });
      results.push({ id: it.id, ok: true });
    } catch (err) {
      const x = err as { code?: string; message?: string };
      results.push({ id: it.id, ok: false, code: x.code ?? 'error', message: x.message });
    }
  }
  return results;
}

export async function remindReceipt(ctx: Ctx, expenseId: string) {
  const e = (await ctx.tx.select().from(expenses).where(and(eq(expenses.id, expenseId), notDeleted)))[0];
  if (!e) throw notFound('Expense');
  const trip = await getTrip(ctx.tx, e.tripId);
  await notify(ctx, [e.userId], { type: 'receipt.reminder', tripId: e.tripId, title: 'Finance is waiting for a receipt', body: `${e.description} · ${inr(e.amountPaise)} on ${trip.name}: open Expenso with a connection so the receipt uploads.`, data: { tripId: e.tripId, expenseId: e.id } });
  await audit(ctx, { action: 'expense.remind', entity: 'expense', entityId: e.id, tripId: e.tripId, memberUserId: e.userId });
}

/* ================= reimbursement ================= */

export interface PaymentInput { amountPaise: number; paidOn: string; mode: 'bank_transfer' | 'upi' | 'cash'; reference?: string | null; proofAttachmentId?: string | null; note?: string | null }

/** FR-VER-07/08: record a payment against a verified claim; several instalments are allowed. */
export async function recordPayment(ctx: Ctx, tripId: string, userId: string, p: PaymentInput) {
  if (userId === ctx.actor.id) throw forbidden('This is your own claim. Another finance user must record it.', 'own_claim');
  const trip = await getTrip(ctx.tx, tripId, true);
  const m = await getMember(ctx.tx, tripId, userId, true);
  if (!m || !m.actualEnd) throw conflict('claim_not_ready', 'The member has not ended the trip yet.');
  const status = await recomputeClaim(ctx, tripId, userId);
  if (!(status === 'verified' || status === 'part_paid')) throw conflict('claim_not_verified', status === 'reimbursed' ? 'This claim is reimbursed and locked.' : 'Verify every expense before recording a payment.');
  const t = await claimTotals(ctx.tx, tripId, userId);
  if (p.amountPaise > t.balancePaise) throw badRequest('validation', `The balance due is ${inr(t.balancePaise)}.`, [{ field: 'amountPaise', message: `Up to ${inr(t.balancePaise)}.` }]);
  if (p.proofAttachmentId) {
    const a = (await ctx.tx.select().from(attachments).where(and(eq(attachments.id, p.proofAttachmentId), isNull(attachments.deletedAt))))[0];
    if (!a || a.tripId !== tripId || a.kind !== 'document') throw badRequest('validation', 'Upload the payment proof first.', [{ field: 'proofAttachmentId', message: 'Unknown file.' }]);
  }
  const [pay] = await ctx.tx.insert(payments).values({ tripId, memberUserId: userId, amountPaise: p.amountPaise, paidOn: p.paidOn, mode: p.mode, reference: p.reference?.trim() || null, proofAttachmentId: p.proofAttachmentId ?? null, note: p.note ?? null, recordedBy: ctx.actor.id!, recordedAt: ctx.now }).returning();
  await audit(ctx, { action: 'payment.record', entity: 'payment', entityId: pay.id, tripId, memberUserId: userId, after: pay });
  const newStatus = await recomputeClaim(ctx, tripId, userId);
  const left = t.balancePaise - p.amountPaise;
  const modeLabel = { bank_transfer: 'bank transfer', upi: 'UPI', cash: 'cash' }[p.mode];
  await notify(ctx, [userId], { type: 'claim.paid', tripId, title: newStatus === 'reimbursed' ? 'Your claim is reimbursed' : 'Part payment recorded', body: `${inr(p.amountPaise)} by ${modeLabel}${p.reference ? `, ref ${p.reference}` : ''} for ${trip.name}.${left > 0 ? ` Balance due ${inr(left)}.` : ''}`, data: { tripId } });
  ctx.after.push(() => tripChanged(tripId, 'payment', { userId }));
  return { payment: pay, claimStatus: newStatus, balancePaise: left };
}

/** FR-VER-09: a reimbursed claim reopens only with a reason, which is logged and printed on the next export. */
export async function reopenClaim(ctx: Ctx, tripId: string, userId: string, reason: string) {
  if (!reason?.trim()) throw badRequest('validation', 'Give the reason for reopening.', [{ field: 'reason', message: 'Required.' }]);
  if (userId === ctx.actor.id) throw forbidden('This is your own claim.', 'own_claim');
  const m = await getMember(ctx.tx, tripId, userId, true);
  if (!m || m.claimStatus !== 'reimbursed') throw conflict('not_reimbursed', 'Only a reimbursed claim can be reopened.');
  await ctx.tx.update(tripMembers).set({ reopenedAt: ctx.now, reopenReason: reason.trim(), reopenedBy: ctx.actor.id, updatedAt: ctx.now }).where(eq(tripMembers.id, m.id));
  const status = await recomputeClaim(ctx, tripId, userId);
  await audit(ctx, { action: 'claim.reopen', entity: 'claim', tripId, memberUserId: userId, before: { claimStatus: 'reimbursed' }, after: { claimStatus: status }, meta: { reason: reason.trim() } });
  const trip = await getTrip(ctx.tx, tripId);
  await notify(ctx, [userId], { type: 'claim.reopened', tripId, title: 'Finance reopened your claim', body: `${trip.name}: ${reason.trim()}`, data: { tripId } });
  ctx.after.push(() => tripChanged(tripId, 'claim', { userId }));
  return { claimStatus: status };
}

/** Close a reopened claim again once the correction needs no further payment. */
export async function closeClaim(ctx: Ctx, tripId: string, userId: string) {
  const m = await getMember(ctx.tx, tripId, userId, true);
  if (!m?.reopenedAt) throw conflict('not_reopened', 'Only a reopened claim can be closed again.');
  const t = await claimTotals(ctx.tx, tripId, userId);
  if (t.balancePaise > 0) throw conflict('balance_due', `Record the balance of ${inr(t.balancePaise)} first.`);
  await ctx.tx.update(tripMembers).set({ reopenedAt: null, updatedAt: ctx.now }).where(eq(tripMembers.id, m.id));
  const status = await recomputeClaim(ctx, tripId, userId);
  await audit(ctx, { action: 'claim.close', entity: 'claim', tripId, memberUserId: userId, after: { claimStatus: status } });
  ctx.after.push(() => tripChanged(tripId, 'claim', { userId }));
  return { claimStatus: status };
}

/* ================= finance documents ================= */

export interface DocumentInput { tripId: string; scope: 'trip' | 'claim' | 'expense'; memberUserId?: string | null; expenseId?: string | null; docType: 'payment_proof' | 'invoice' | 'approval_note' | 'bank_statement' | 'other'; name: string; mime: string; body: Buffer; note?: string | null }

const DOC_MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword'];

/** FR-WEB-06 and §3.7: PDF, image, Excel or Word up to 20 MB, on the trip, a claim or an expense. */
export async function uploadDocument(ctx: Ctx, d: DocumentInput) {
  const trip = await getTrip(ctx.tx, d.tripId);
  if (!DOC_MIMES.includes(d.mime)) throw unprocessable('bad_type', 'Use PDF, an image, Excel or Word.');
  let memberUserId = d.memberUserId ?? null;
  if (d.scope === 'expense') {
    const e = (await ctx.tx.select().from(expenses).where(and(eq(expenses.id, d.expenseId ?? ''), eq(expenses.tripId, trip.id), notDeleted)))[0];
    if (!e) throw badRequest('validation', 'Pick an expense of this trip.', [{ field: 'expenseId', message: 'Unknown expense.' }]);
    memberUserId = e.userId;
  } else if (d.scope === 'claim') {
    if (!memberUserId || !isAccepted(await getMember(ctx.tx, trip.id, memberUserId))) throw badRequest('validation', 'Pick a member of this trip.', [{ field: 'memberUserId', message: 'Unknown member.' }]);
  } else memberUserId = null;
  if (memberUserId) {
    const m = (await getMember(ctx.tx, trip.id, memberUserId))!;
    if (claimLocked(m)) throw conflict('claim_locked', 'The claim is reimbursed and locked.');
  }
  const id = crypto.randomUUID();
  const key = `documents/${trip.id}/${memberUserId ?? 'trip'}/${id}.${extFor(d.mime, d.name)}`;
  await storage.put(key, d.body, d.mime);
  const [a] = await ctx.tx.insert(attachments).values({
    id, kind: 'document', tripId: trip.id, expenseId: d.scope === 'expense' ? d.expenseId! : null, memberUserId, docType: d.docType, docScope: d.scope,
    visibleToMember: d.scope !== 'trip', storageKey: key, originalName: d.name, note: d.note?.trim() || null, mime: d.mime, sizeBytes: d.body.length, status: 'uploaded',
    sha256: crypto.createHash('sha256').update(d.body).digest('hex'), uploadedBy: ctx.actor.id!, createdAt: ctx.now, uploadedAt: ctx.now,
  }).returning();
  await audit(ctx, { action: 'document.upload', entity: 'attachment', entityId: a.id, tripId: trip.id, memberUserId, meta: { docType: d.docType, scope: d.scope, name: d.name } });
  ctx.after.push(() => tripChanged(trip.id, 'document'));
  return a;
}

export async function deleteDocument(ctx: Ctx, id: string) {
  const a = (await ctx.tx.select().from(attachments).where(and(eq(attachments.id, id), eq(attachments.kind, 'document'), isNull(attachments.deletedAt))))[0];
  if (!a) throw notFound('Document');
  if (a.uploadedBy !== ctx.actor.id) throw forbidden('You can delete only documents you uploaded.', 'not_uploader');
  if (a.memberUserId) {
    const m = await getMember(ctx.tx, a.tripId, a.memberUserId);
    if (m && claimLocked(m)) throw conflict('claim_locked', 'The claim is reimbursed and locked.');
  }
  const used = await ctx.tx.select({ id: payments.id }).from(payments).where(eq(payments.proofAttachmentId, a.id));
  if (used.length) throw conflict('document_in_use', 'This file is the proof of a recorded payment.');
  await ctx.tx.update(attachments).set({ deletedAt: ctx.now, deletedBy: ctx.actor.id }).where(eq(attachments.id, a.id));
  await audit(ctx, { action: 'document.delete', entity: 'attachment', entityId: a.id, tripId: a.tripId, memberUserId: a.memberUserId, before: { name: a.originalName } });
  ctx.after.push(() => tripChanged(a.tripId, 'document'));
}

/** Finance writes on an expense thread without changing the decision, for example to answer a member's question about it. */
export async function financeMessage(ctx: Ctx, expenseId: string, body: string) {
  if (!body?.trim()) throw badRequest('validation', 'Write the message.', [{ field: 'body', message: 'Required.' }]);
  const e = (await ctx.tx.select().from(expenses).where(and(eq(expenses.id, expenseId), notDeleted)))[0];
  if (!e) throw notFound('Expense');
  if (e.userId === ctx.actor.id) throw forbidden('This is your own claim. Another finance user must answer it.', 'own_claim');
  const [msg] = await ctx.tx.insert(expenseMessages).values({ expenseId, tripId: e.tripId, authorId: ctx.actor.id!, side: 'finance', kind: 'note', body: body.trim(), createdAt: ctx.now }).returning();
  await audit(ctx, { action: 'expense.message', entity: 'expense', entityId: e.id, tripId: e.tripId, memberUserId: e.userId, meta: { message: body.trim() } });
  await notify(ctx, [e.userId], { type: 'expense.message', tripId: e.tripId, title: 'Finance wrote about an expense', body: `${e.description} · ${inr(e.amountPaise)}: ${body.trim()}`, data: { tripId: e.tripId, expenseId: e.id } });
  ctx.after.push(() => tripChanged(e.tripId, 'reply', { expenseId: e.id, userId: e.userId }));
  return msg;
}

/* ================= hand-off between finance users (FR-VER-10) ================= */

/** A finance user who is on a trip asks another finance user to set its budgets or decide their own claim (W05·d). */
export async function handoff(ctx: Ctx, tripId: string, toUserId: string, topic: 'budgets' | 'claim', message?: string | null) {
  const trip = await getTrip(ctx.tx, tripId);
  if (toUserId === ctx.actor.id) throw badRequest('validation', 'Pick another finance user.', [{ field: 'toUserId', message: 'Not yourself.' }]);
  const to = (await ctx.tx.select().from(schema.users).where(eq(schema.users.id, toUserId)))[0];
  if (!to || !to.active || !to.isFinance) throw badRequest('validation', 'Pick an active finance user.', [{ field: 'toUserId', message: 'Not an active finance user.' }]);
  if (isAccepted(await getMember(ctx.tx, tripId, toUserId))) throw conflict('member_of_trip', `${to.name} is also on this trip, so they cannot take this over. Pick someone else.`);
  const what = topic === 'budgets' ? 'set the budgets' : 'verify and pay my claim';
  await notify(ctx, [toUserId], {
    type: 'finance.handoff', channel: 'web', tripId, title: `${firstName(ctx.actor.name)} asks you to ${what} on ${trip.ref}`,
    body: message?.trim() || `${trip.name}: ${ctx.actor.name} is a member of this trip, so another finance user must ${topic === 'budgets' ? 'set its budgets' : 'decide their claim'}.`,
    data: { tripId, topic, fromUserId: ctx.actor.id, ...(topic === 'claim' ? { userId: ctx.actor.id } : {}) },
  });
  await audit(ctx, { action: 'finance.handoff', entity: 'trip', entityId: tripId, tripId, meta: { to: toUserId, toName: to.name, topic, message: message ?? null } });
}

/** Finance ends a member's trip: re-exported here so finance routes find every finance action in one place. */
export { financeEndMember, handOver } from '../trips/service.js';
export { istDate, istLabel, firstName, asc, inArray };
