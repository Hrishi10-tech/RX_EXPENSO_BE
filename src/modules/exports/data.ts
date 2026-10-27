/**
 * Everything an export needs, loaded once in a read-only snapshot and already cut to the export's scope (SRS §8.2).
 * A member scope never loads another member's individual budget, individual-budget expenses or claim (FR-EXPT-04).
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema, type Q } from '../../db/client.js';
import { istDate } from '../../lib/time.js';
import {
  activeBudgets, budgetView, claimTotals, getMembers, getTrip, isAccepted, notDeleted,
  type BudgetView, type ClaimTotals, type Expense, type Member, type Trip,
} from '../domain.js';
import { CATEGORY_LABEL, extFor } from '../expenses/service.js';
import { PURPOSE_LABEL } from '../trips/service.js';

const { users, departments, locations, expenses, attachments, expenseMessages, payments, budgetChanges, auditLog } = schema;

export type Scope = 'trip' | 'member' | 'each' | 'trip_and_each';
export type Format = 'pdf' | 'xlsx' | 'zip';
export interface ExportLimit { locationId?: string | null; dateFrom?: string | null; dateTo?: string | null }

export type LocationRow = typeof locations.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;

export const SCOPE_LABEL: Record<Scope, string> = { trip: 'Whole trip', member: 'One member', each: 'Each member separately', trip_and_each: 'Whole trip and each member' };
export const DOC_LABEL: Record<string, string> = { payment_proof: 'Payment proof', invoice: 'Invoice', approval_note: 'Approval note', bank_statement: 'Bank statement', other: 'Document' };
export const MODE_LABEL: Record<string, string> = { upi: 'UPI', cash: 'Cash', card: 'Card', company: 'Company-paid' };
export const PAY_MODE_LABEL: Record<string, string> = { bank_transfer: 'Bank transfer', upi: 'UPI', cash: 'Cash' };
export const SOURCE_LABEL: Record<string, string> = { pool: 'Trip pool', individual: 'Individual', unbudgeted: 'Unbudgeted' };
export const VERIFY_LABEL: Record<string, string> = { pending: 'Pending', verified: 'Verified', query: 'Query', rejected: 'Rejected' };
export const CLAIM_LABEL: Record<string, string> = { open: 'Open', ready: 'Ready for verification', verified: 'Verified', part_paid: 'Part paid', reimbursed: 'Reimbursed' };
export const FLAG_LABEL: Record<string, string> = { pre_trip: 'Pre-trip', outside_times: 'Outside trip times', late_entry: 'Late entry', device_time_mismatch: 'Device time mismatch' };
export const STATUS_LABEL: Record<string, string> = { scheduled: 'Scheduled', active: 'Active', extended: 'Extended', closed: 'Closed', cancelled: 'Cancelled' };
export { CATEGORY_LABEL, PURPOSE_LABEL };

/** Claim states that count as verified for FR-EXPT-08. */
const FINAL_CLAIMS = new Set(['verified', 'part_paid', 'reimbursed']);

/** File-name safe slug: "MedTech India Expo 2026" -> "MedTech-India-Expo-2026". */
export function slug(s: string, max = 40): string {
  const out = s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (out.slice(0, max).replace(/-+$/, '') || 'x');
}
/** Rupees for file names: 12000, or 1640.50 when there are paise. */
export const amountForName = (paise: number) => (paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2));

export interface ExpenseItem {
  e: Expense;
  location: LocationRow | undefined;
  /** Receipts in capture order with their export names; pending ones are named but not in the ZIP. */
  files: Array<{ a: AttachmentRow; name: string; received: boolean }>;
  messages: Array<{ side: string; kind: string; body: string; authorName: string; at: Date }>;
}

export interface MemberData {
  userId: string; name: string; code: string; slug: string; role: string;
  member: Member;
  expenses: ExpenseItem[];
  /** Totals over the expenses in this export (the location or date limit applies). */
  scoped: { totalPaise: number; companyPaise: number; selfPaise: number; rejectedPaise: number; approvedPaise: number; count: number; unbudgetedPaise: number };
  /** Whole-claim totals from the ledger: payments are not tied to a location or a date. */
  claim: ClaimTotals;
  individual: BudgetView | null;
  payments: Array<PaymentRow & { recordedByName: string; proofName: string | null }>;
  documents: Array<{ a: AttachmentRow; name: string; uploadedByName: string }>;
  reopenings: Array<{ at: Date; by: string; reason: string }>;
  provisional: boolean;
}

export interface ExportData {
  trip: Trip; ref: string; tripSlug: string; departmentName: string; ownerName: string; ownerCode: string;
  purposeLabel: string; statusLabel: string;
  scope: Scope; limit: ExportLimit; limitLabel: string | null; limitSuffix: string; limitLocation: LocationRow | null;
  locations: LocationRow[];
  /** Members covered by this export, in the order they were invited. */
  members: MemberData[];
  /** Every accepted member, for the header list of a whole-trip export. */
  allMembers: Array<{ userId: string; name: string; code: string; role: string; member: Member }>;
  pool: BudgetView | null;
  budgetLog: Array<{ at: Date; type: string; memberName: string | null; oldPaise: number | null; newPaise: number | null; note: string | null; by: string }>;
  tripDocuments: Array<{ a: AttachmentRow; name: string; uploadedByName: string }>;
  generatedAt: Date; generatedBy: string; via: string;
  provisional: boolean; provisionalReasons: string[];
  missingReceipts: Array<{ expenseId: string; userId: string; memberName: string; description: string; spentAt: Date; amountPaise: number; category: string }>;
}

function limitDescribe(limit: ExportLimit, loc: LocationRow | null) {
  const parts: string[] = [], suffix: string[] = [];
  if (loc) { parts.push(`${loc.city}${loc.venue ? ` · ${loc.venue}` : ''}`); suffix.push(slug(loc.city, 24)); }
  if (limit.dateFrom && limit.dateTo) { parts.push(`${limit.dateFrom} to ${limit.dateTo}`); suffix.push(`${limit.dateFrom}-to-${limit.dateTo.slice(5)}`); }
  else if (limit.dateFrom) { parts.push(`from ${limit.dateFrom}`); suffix.push(`from-${limit.dateFrom}`); }
  else if (limit.dateTo) { parts.push(`up to ${limit.dateTo}`); suffix.push(`to-${limit.dateTo}`); }
  return { label: parts.length ? parts.join(', ') : null, suffix: suffix.length ? '_' + suffix.join('_') : '' };
}

/** A name for each finance document, unique within its folder: <ref>_<member or Trip>_<type>_<date>.<ext> (§8.3). */
function nameDocuments(ref: string, docs: AttachmentRow[], slugOf: (userId: string | null) => string, names: Map<string, string>) {
  const used = new Map<string, number>();
  return docs.map(a => {
    const base = `${ref}_${slugOf(a.memberUserId)}_${slug(DOC_LABEL[a.docType ?? 'other'] ?? 'Document')}_${istDate(a.uploadedAt ?? a.createdAt)}`;
    const ext = extFor(a.mime, a.originalName);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return { a, name: `${base}${n > 1 ? `_${n}` : ''}.${ext}`, uploadedByName: names.get(a.uploadedBy) ?? '' };
  });
}

export interface LoadOptions { scope: Scope; memberUserId?: string | null; limit: ExportLimit; generatedBy: string; via: string; now?: Date }

export async function loadExportData(tripId: string, o: LoadOptions): Promise<ExportData> {
  return db.transaction(async tx => loadWith(tx, tripId, o), { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

export async function loadWith(q: Q, tripId: string, o: LoadOptions): Promise<ExportData> {
  const now = o.now ?? new Date();
  const trip = await getTrip(q, tripId);
  const people = await q.select({ id: users.id, name: users.name, code: users.employeeCode }).from(users);
  const nameOf = new Map(people.map(p => [p.id, p.name]));
  // The owner first, then members in the order they were invited, then by name: stable across exports.
  const ms = (await getMembers(q, tripId)).filter(isAccepted).sort((a, b) =>
    Number(b.role === 'owner') - Number(a.role === 'owner') || a.invitedAt.getTime() - b.invitedAt.getTime() || (nameOf.get(a.userId) ?? '').localeCompare(nameOf.get(b.userId) ?? ''));
  const codeOf = new Map(people.map(p => [p.id, p.code]));
  const dept = (await q.select().from(departments).where(eq(departments.id, trip.departmentId)))[0];
  const locs = await q.select().from(locations).where(eq(locations.tripId, tripId)).orderBy(asc(locations.arrivalDate), asc(locations.createdAt));
  const liveLocs = locs.filter(l => !l.deletedAt);
  const limitLocation = o.limit.locationId ? locs.find(l => l.id === o.limit.locationId) ?? null : null;
  const lim = limitDescribe(o.limit, limitLocation);

  // Member slugs are unique within the export; a repeated name gets the employee ID.
  const slugCount = new Map<string, number>();
  for (const m of ms) { const s = slug(nameOf.get(m.userId) ?? 'Member'); slugCount.set(s, (slugCount.get(s) ?? 0) + 1); }
  const memberSlug = new Map(ms.map(m => {
    const s = slug(nameOf.get(m.userId) ?? 'Member');
    return [m.userId, (slugCount.get(s) ?? 0) > 1 ? `${s}-${slug(codeOf.get(m.userId) ?? '', 12)}` : s];
  }));
  const slugOf = (uid: string | null) => (uid ? memberSlug.get(uid) ?? slug(nameOf.get(uid) ?? 'Member') : 'Trip');

  const covered = o.scope === 'member' ? ms.filter(m => m.userId === o.memberUserId) : ms;
  const coveredIds = covered.map(m => m.userId);

  // Expenses in scope, with the location and date limit (FR-EXPT-11). Dates are IST calendar dates.
  const conds = [eq(expenses.tripId, tripId), notDeleted];
  if (coveredIds.length) conds.push(inArray(expenses.userId, coveredIds)); else conds.push(sql`false`);
  if (o.limit.locationId) conds.push(eq(expenses.locationId, o.limit.locationId));
  if (o.limit.dateFrom) conds.push(sql`(${expenses.spentAt} at time zone 'Asia/Kolkata')::date >= ${o.limit.dateFrom}::date`);
  if (o.limit.dateTo) conds.push(sql`(${expenses.spentAt} at time zone 'Asia/Kolkata')::date <= ${o.limit.dateTo}::date`);
  const exps = await q.select().from(expenses).where(and(...conds)).orderBy(asc(expenses.spentAt), asc(expenses.createdAt));
  const expIds = exps.map(e => e.id);

  const receipts = expIds.length
    ? await q.select().from(attachments).where(and(inArray(attachments.expenseId, expIds), eq(attachments.kind, 'receipt'), isNull(attachments.deletedAt))).orderBy(asc(attachments.createdAt))
    : [];
  const msgs = expIds.length
    ? await q.select({ m: expenseMessages, name: users.name }).from(expenseMessages).innerJoin(users, eq(users.id, expenseMessages.authorId)).where(inArray(expenseMessages.expenseId, expIds)).orderBy(asc(expenseMessages.createdAt))
    : [];

  const items = new Map<string, ExpenseItem[]>();
  for (const e of exps) {
    const loc = locs.find(l => l.id === e.locationId);
    const mine = receipts.filter(r => r.expenseId === e.id);
    const base = `${trip.ref}_${slugOf(e.userId)}_${slug(loc?.city ?? 'Location', 24)}_${istDate(e.spentAt)}_${slug(CATEGORY_LABEL[e.category] ?? e.category, 24)}_${amountForName(e.amountPaise)}`;
    const item: ExpenseItem = {
      e, location: loc,
      files: mine.map((a, i) => ({ a, name: `${base}_${i + 1}.${extFor(a.mime, a.originalName)}`, received: a.status === 'uploaded' && !!a.storageKey })),
      messages: msgs.filter(x => x.m.expenseId === e.id).map(x => ({ side: x.m.side, kind: x.m.kind, body: x.m.body, authorName: x.name, at: x.m.createdAt })),
    };
    const list = items.get(e.userId) ?? [];
    list.push(item);
    items.set(e.userId, list);
  }

  const budgets = await activeBudgets(q, tripId);
  const poolB = budgets.find(b => b.type === 'pool');
  const pool = poolB ? await budgetView(q, poolB) : null;

  const docsAll = await q.select().from(attachments)
    .where(and(eq(attachments.tripId, tripId), eq(attachments.kind, 'document'), isNull(attachments.deletedAt), eq(attachments.status, 'uploaded')))
    .orderBy(asc(attachments.createdAt));
  // A location or date limit keeps expense documents only for expenses in the export; claim and trip documents stay.
  const docsInScope = docsAll.filter(d => d.docScope !== 'expense' || (d.expenseId && expIds.includes(d.expenseId)));
  const namedDocs = nameDocuments(trip.ref, docsInScope, slugOf, nameOf);

  const pays = coveredIds.length
    ? await q.select().from(payments).where(and(eq(payments.tripId, tripId), inArray(payments.memberUserId, coveredIds))).orderBy(asc(payments.paidOn), asc(payments.recordedAt))
    : [];
  const reopen = coveredIds.length
    ? await q.select().from(auditLog).where(and(eq(auditLog.tripId, tripId), eq(auditLog.action, 'claim.reopen'), inArray(auditLog.memberUserId, coveredIds))).orderBy(asc(auditLog.at))
    : [];

  const members: MemberData[] = [];
  for (const m of covered) {
    const list = items.get(m.userId) ?? [];
    const sum = (f: (x: Expense) => number) => list.reduce((s, it) => s + f(it.e), 0);
    const indB = budgets.find(b => b.type === 'individual' && b.memberUserId === m.userId);
    members.push({
      userId: m.userId, name: nameOf.get(m.userId) ?? 'Member', code: codeOf.get(m.userId) ?? '', slug: slugOf(m.userId), role: m.role, member: m,
      expenses: list,
      scoped: {
        totalPaise: sum(e => e.amountPaise),
        companyPaise: sum(e => (e.paidBy === 'company' ? e.amountPaise : 0)),
        selfPaise: sum(e => (e.paidBy === 'self' ? e.amountPaise : 0)),
        rejectedPaise: sum(e => (e.verification === 'rejected' ? e.amountPaise : 0)),
        approvedPaise: sum(e => (e.paidBy === 'self' && e.verification === 'verified' ? e.approvedPaise ?? e.amountPaise : 0)),
        unbudgetedPaise: sum(e => (e.budgetSource === 'unbudgeted' ? e.amountPaise : 0)),
        count: list.length,
      },
      claim: await claimTotals(q, tripId, m.userId),
      individual: indB ? await budgetView(q, indB) : null,
      payments: pays.filter(p => p.memberUserId === m.userId).map(p => ({
        ...p, recordedByName: nameOf.get(p.recordedBy) ?? '', proofName: namedDocs.find(d => d.a.id === p.proofAttachmentId)?.name ?? null,
      })),
      documents: namedDocs.filter(d => d.a.memberUserId === m.userId),
      reopenings: reopen.filter(r => r.memberUserId === m.userId).map(r => ({ at: r.at, by: r.actorLabel, reason: String((r.meta as Record<string, unknown>)?.reason ?? '') })),
      provisional: !(trip.status === 'closed' || trip.status === 'cancelled') || !FINAL_CLAIMS.has(m.claimStatus),
    });
  }

  // Budget change log: every change for a whole-trip export; the pool and the member's own for a member export.
  const changes = await q.select().from(budgetChanges).where(eq(budgetChanges.tripId, tripId)).orderBy(asc(budgetChanges.changedAt));
  const budgetLog = changes
    .filter(c => o.scope !== 'member' || c.type === 'pool' || c.memberUserId === o.memberUserId)
    .map(c => ({ at: c.changedAt, type: c.type, memberName: c.memberUserId ? nameOf.get(c.memberUserId) ?? '' : null, oldPaise: c.oldPaise, newPaise: c.newPaise, note: c.note, by: nameOf.get(c.changedBy) ?? '' }));

  const tripOpen = !(trip.status === 'closed' || trip.status === 'cancelled');
  const reasons: string[] = [];
  if (tripOpen) reasons.push(trip.status === 'scheduled' ? 'The trip has not started yet.' : 'The trip is still running.');
  const unverified = members.filter(m => !FINAL_CLAIMS.has(m.member.claimStatus));
  if (unverified.length === 1) reasons.push(`${unverified[0].name}’s claim isn’t verified yet.`);
  else if (unverified.length > 1) reasons.push(`${unverified.length} claims aren’t verified yet: ${unverified.map(u => u.name).join(', ')}.`);

  const missing = members.flatMap(m => m.expenses
    .filter(it => it.e.paidBy === 'self' && !it.files.some(f => f.received))
    .map(it => ({ expenseId: it.e.id, userId: m.userId, memberName: m.name, description: it.e.description, spentAt: it.e.spentAt, amountPaise: it.e.amountPaise, category: it.e.category })));

  return {
    trip, ref: trip.ref, tripSlug: slug(trip.name), departmentName: dept?.name ?? '', ownerName: nameOf.get(trip.ownerId) ?? '', ownerCode: codeOf.get(trip.ownerId) ?? '',
    purposeLabel: PURPOSE_LABEL[trip.purpose] ?? trip.purpose, statusLabel: STATUS_LABEL[trip.status] ?? trip.status,
    scope: o.scope, limit: o.limit, limitLabel: lim.label, limitSuffix: lim.suffix, limitLocation,
    locations: liveLocs.length ? liveLocs : locs,
    members,
    allMembers: ms.map(m => ({ userId: m.userId, name: nameOf.get(m.userId) ?? '', code: codeOf.get(m.userId) ?? '', role: m.role, member: m })),
    pool, budgetLog,
    tripDocuments: o.scope === 'member' ? [] : namedDocs.filter(d => !d.a.memberUserId),
    generatedAt: now, generatedBy: o.generatedBy, via: o.via,
    provisional: reasons.length > 0, provisionalReasons: reasons,
    missingReceipts: missing,
  };
}

/** Individual budgets a statement may state: the member's own in a member statement, all in a trip statement (FR-EXPT-04). */
export function statedIndividuals(d: ExportData, only?: MemberData): Array<{ name: string; view: BudgetView }> {
  const src = only ? [only] : d.members;
  return src.filter(m => m.individual).map(m => ({ name: m.name, view: m.individual! }));
}

export const PROV = '_PROVISIONAL';
export function statementName(d: ExportData, who: MemberData | null, ext: 'pdf' | 'xlsx', provisional: boolean) {
  return `${d.ref}_${who ? `${who.slug}_statement` : 'Trip-statement'}${d.limitSuffix}${provisional ? PROV : ''}.${ext}`;
}
