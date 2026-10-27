/**
 * Shared domain queries and rules used by every module: loading trips and members with locks,
 * the visibility rule for expenses (FR-ROLE-03/04), budget draw-down (FR-BUD-02) and claim status (FR-VER-06).
 */
import { and, asc, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { schema, type Q } from '../db/client.js';
import type { Ctx } from '../lib/context.js';
import { forbidden, notFound } from '../lib/errors.js';

const { trips, tripMembers, expenses, budgets, payments, users } = schema;
export type Trip = typeof trips.$inferSelect;
export type Member = typeof tripMembers.$inferSelect;
export type Expense = typeof expenses.$inferSelect;
export type Budget = typeof budgets.$inferSelect;

export async function getTrip(q: Q, tripId: string, lock = false): Promise<Trip> {
  const base = q.select().from(trips).where(eq(trips.id, tripId));
  const rows = lock ? await base.for('update') : await base;
  if (!rows[0]) throw notFound('Trip');
  return rows[0];
}

export async function getMembers(q: Q, tripId: string): Promise<Member[]> {
  return q.select().from(tripMembers).where(eq(tripMembers.tripId, tripId))
    .orderBy(sql`(${tripMembers.role} = 'owner') desc`, asc(tripMembers.invitedAt), asc(tripMembers.id));
}

export async function getMember(q: Q, tripId: string, userId: string, lock = false): Promise<Member | undefined> {
  const base = q.select().from(tripMembers).where(and(eq(tripMembers.tripId, tripId), eq(tripMembers.userId, userId)));
  const rows = lock ? await base.for('update') : await base;
  return rows[0];
}

export const isAccepted = (m?: Member) => !!m && m.joinStatus === 'accepted';
export const isRunning = (m?: Member) => isAccepted(m) && !!m!.actualStart && !m!.actualEnd;
export const tripIsLive = (t: Trip) => t.status === 'scheduled' || t.status === 'active' || t.status === 'extended';

/** An accepted member (or finance) may see the trip's content; everyone else is refused (FR-ROLE-01/02). */
export async function requireMemberAccess(ctx: Ctx, tripId: string, lock = false) {
  const trip = await getTrip(ctx.tx, tripId, lock);
  const m = ctx.actor.id ? await getMember(ctx.tx, tripId, ctx.actor.id, lock) : undefined;
  if (!isAccepted(m)) throw forbidden('You are not a member of this trip.', 'not_member');
  return { trip, member: m! };
}

/** Expenses the viewer may see: everything on the trip pool, plus their own (FR-ROLE-03). */
export function visibleTo(viewerId: string): SQL {
  return or(eq(expenses.budgetSource, 'pool'), eq(expenses.userId, viewerId))!;
}
export const notDeleted = isNull(expenses.deletedAt);

/** Amount an expense draws from its budget: approved amount if set, never for rejected or company-paid (FR-BUD-02). */
export const drawSql = sql<number>`case when ${expenses.paidBy} = 'self' and ${expenses.verification} <> 'rejected' then coalesce(${expenses.approvedPaise}, ${expenses.amountPaise}) else 0 end`;

export async function activeBudgets(q: Q, tripId: string): Promise<Budget[]> {
  return q.select().from(budgets).where(and(eq(budgets.tripId, tripId), isNull(budgets.removedAt)));
}

export interface BudgetView {
  id: string;
  type: 'pool' | 'individual';
  memberUserId: string | null;
  allocatedPaise: number;
  spentPaise: number;
  remainingPaise: number;
  pct: number;
  state: 'ok' | 'warn' | 'over';
  setAt: Date;
}

export async function budgetSpent(q: Q, b: Budget): Promise<number> {
  const cond = b.type === 'pool'
    ? and(eq(expenses.tripId, b.tripId), eq(expenses.budgetSource, 'pool'), notDeleted)
    : and(eq(expenses.tripId, b.tripId), eq(expenses.budgetSource, 'individual'), eq(expenses.userId, b.memberUserId!), notDeleted);
  const r = await q.select({ s: sql<number>`coalesce(sum(${drawSql}), 0)` }).from(expenses).where(cond);
  return Number(r[0]?.s ?? 0);
}

/**
 * Budget state on exact amounts (FR-BUD-07): warn from 80 % used, over once spending passes the allocation.
 * The percentage is floored so 99.6 % never reads as 100 %.
 */
export function budgetLevel(spent: number, allocated: number): 0 | 80 | 100 {
  if (allocated <= 0) return spent > 0 ? 100 : 0;
  if (spent >= allocated) return 100;
  return spent * 100 >= allocated * 80 ? 80 : 0;
}
export async function budgetView(q: Q, b: Budget): Promise<BudgetView> {
  const spent = await budgetSpent(q, b);
  const p = b.amountPaise > 0 ? Math.floor((spent * 100) / b.amountPaise) : 0;
  return {
    id: b.id, type: b.type, memberUserId: b.memberUserId, allocatedPaise: b.amountPaise, spentPaise: spent,
    remainingPaise: b.amountPaise - spent, pct: p, state: spent > b.amountPaise ? 'over' : budgetLevel(spent, b.amountPaise) >= 80 ? 'warn' : 'ok', setAt: b.setAt,
  };
}

/** Which budgets a member holds on a trip, deciding the budget source rule of §6.2. */
export async function heldBudgets(q: Q, tripId: string, userId: string) {
  const bs = await activeBudgets(q, tripId);
  return { pool: bs.find(b => b.type === 'pool'), individual: bs.find(b => b.type === 'individual' && b.memberUserId === userId) };
}

export interface ClaimTotals {
  totalPaise: number; companyPaise: number; selfPaise: number; rejectedPaise: number;
  reimbursablePaise: number; paidPaise: number; balancePaise: number;
  count: number; verified: number; query: number; rejected: number; pending: number;
  poolPaise: number; individualPaise: number; unbudgetedPaise: number; missingReceipts: number;
}

export async function claimTotals(q: Q, tripId: string, userId: string): Promise<ClaimTotals> {
  const r = await q.select({
    total: sql<number>`coalesce(sum(${expenses.amountPaise}), 0)`,
    company: sql<number>`coalesce(sum(case when ${expenses.paidBy} = 'company' then ${expenses.amountPaise} else 0 end), 0)`,
    self: sql<number>`coalesce(sum(case when ${expenses.paidBy} = 'self' then ${expenses.amountPaise} else 0 end), 0)`,
    rejected: sql<number>`coalesce(sum(case when ${expenses.verification} = 'rejected' then ${expenses.amountPaise} else 0 end), 0)`,
    reimbursable: sql<number>`coalesce(sum(case when ${expenses.paidBy} = 'self' and ${expenses.verification} = 'verified' then coalesce(${expenses.approvedPaise}, ${expenses.amountPaise}) else 0 end), 0)`,
    pool: sql<number>`coalesce(sum(case when ${expenses.budgetSource} = 'pool' then ${expenses.amountPaise} else 0 end), 0)`,
    individual: sql<number>`coalesce(sum(case when ${expenses.budgetSource} = 'individual' then ${expenses.amountPaise} else 0 end), 0)`,
    unbudgeted: sql<number>`coalesce(sum(case when ${expenses.budgetSource} = 'unbudgeted' then ${expenses.amountPaise} else 0 end), 0)`,
    count: sql<number>`count(*)`,
    verified: sql<number>`count(*) filter (where ${expenses.verification} = 'verified')`,
    query: sql<number>`count(*) filter (where ${expenses.verification} = 'query')`,
    rejectedN: sql<number>`count(*) filter (where ${expenses.verification} = 'rejected')`,
    pending: sql<number>`count(*) filter (where ${expenses.verification} = 'pending')`,
    // The outer column is written out in full: inside the subquery a bare "id" would resolve to the attachment's own id.
    missing: sql<number>`count(*) filter (where ${expenses.paidBy} = 'self' and not exists (select 1 from attachments a where a.expense_id = "expenses"."id" and a.kind = 'receipt' and a.deleted_at is null and a.status = 'uploaded'))`,
  }).from(expenses).where(and(eq(expenses.tripId, tripId), eq(expenses.userId, userId), notDeleted));
  const x = r[0]!;
  const paid = await q.select({ s: sql<number>`coalesce(sum(${payments.amountPaise}), 0)` }).from(payments)
    .where(and(eq(payments.tripId, tripId), eq(payments.memberUserId, userId)));
  const paidPaise = Number(paid[0]?.s ?? 0);
  return {
    totalPaise: x.total, companyPaise: x.company, selfPaise: x.self, rejectedPaise: x.rejected,
    reimbursablePaise: x.reimbursable, paidPaise, balancePaise: x.reimbursable - paidPaise,
    count: x.count, verified: x.verified, query: x.query, rejected: x.rejectedN, pending: x.pending,
    poolPaise: x.pool, individualPaise: x.individual, unbudgetedPaise: x.unbudgeted, missingReceipts: x.missing,
  };
}

/**
 * Claim status (FR-VER-06, FR-END-07): Open while running; Ready once ended; Verified when every expense is
 * Verified or Rejected with no open query; Part paid after a payment leaving a balance; Reimbursed when paid in full.
 * A claim reopened after payment (FR-VER-09) waits at Verified until finance pays or closes it again.
 */
export async function recomputeClaim(ctx: Ctx, tripId: string, userId: string): Promise<Member['claimStatus']> {
  const m = await getMember(ctx.tx, tripId, userId, true);
  if (!m) return 'open';
  const t = await claimTotals(ctx.tx, tripId, userId);
  let status: Member['claimStatus'];
  if (!m.actualEnd) status = t.paidPaise > 0 ? 'part_paid' : 'open';
  else {
    const settled = t.pending === 0 && t.query === 0;
    const lastPay = await ctx.tx.select({ at: sql<Date>`max(${payments.recordedAt})` }).from(payments)
      .where(and(eq(payments.tripId, tripId), eq(payments.memberUserId, userId)));
    const reopenedSincePay = !!m.reopenedAt && (!lastPay[0]?.at || new Date(lastPay[0].at) < m.reopenedAt);
    if (settled && t.paidPaise > 0 && t.balancePaise <= 0 && !reopenedSincePay) status = 'reimbursed';
    else if (t.paidPaise > 0 && t.balancePaise > 0) status = 'part_paid';
    else if (settled) status = 'verified';
    else status = 'ready';
  }
  if (status !== m.claimStatus) {
    await ctx.tx.update(tripMembers).set({ claimStatus: status, claimStatusAt: ctx.now, updatedAt: ctx.now }).where(eq(tripMembers.id, m.id));
  }
  return status;
}

export const claimLocked = (m: Member) => m.claimStatus === 'reimbursed';

/** Close the trip when every accepted member has ended (FR-END-04); expire unanswered requests (FR-MEM-05). */
export async function maybeCloseTrip(ctx: Ctx, tripId: string): Promise<boolean> {
  const trip = await getTrip(ctx.tx, tripId, true);
  if (!(trip.status === 'active' || trip.status === 'extended')) return false;
  const ms = await getMembers(ctx.tx, tripId);
  const accepted = ms.filter(isAccepted);
  if (!accepted.length || accepted.some(m => !m.actualEnd)) return false;
  await ctx.tx.update(trips).set({ status: 'closed', closedAt: ctx.now, updatedAt: ctx.now, version: sql`${trips.version} + 1` }).where(eq(trips.id, tripId));
  await ctx.tx.update(tripMembers).set({ joinStatus: 'expired', updatedAt: ctx.now })
    .where(and(eq(tripMembers.tripId, tripId), eq(tripMembers.joinStatus, 'invited')));
  return true;
}

export async function userNames(q: Q, ids: string[]): Promise<Map<string, { name: string; employeeCode: string }>> {
  const uniq = [...new Set(ids)].filter(Boolean);
  if (!uniq.length) return new Map();
  const rows = await q.select({ id: users.id, name: users.name, code: users.employeeCode }).from(users).where(inArray(users.id, uniq));
  return new Map(rows.map(r => [r.id, { name: r.name, employeeCode: r.code }]));
}

export const firstName = (n: string) => n.split(' ')[0];

/** Members other than the given one who should hear about trip events. */
export function otherAccepted(ms: Member[], exceptUserId?: string | null) {
  return ms.filter(m => isAccepted(m) && m.userId !== exceptUserId).map(m => m.userId);
}
export const acceptedIds = (ms: Member[]) => ms.filter(isAccepted).map(m => m.userId);
export { and, eq, ne, or, sql, inArray, isNull };
