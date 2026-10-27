/**
 * What the mobile app receives. Everything here is filtered on the server by the viewer (FR-ROLE-01..04):
 * private budgets, private expenses and their totals never leave the server for anyone else.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Q } from '../../db/client.js';
import type { Ctx } from '../../lib/context.js';
import { forbidden } from '../../lib/errors.js';
import { calendarDays, humanDuration, istDate } from '../../lib/time.js';
import {
  activeBudgets, budgetView, claimTotals, getMember, getMembers, getTrip, isAccepted, isRunning, notDeleted, userNames, visibleTo,
  type Expense, type Member, type Trip,
} from '../domain.js';
import { overlappingTrips } from './service.js';
import { tripWindow } from '../locations/service.js';

const { trips, tripMembers, expenses, attachments, expenseMessages, locations, users, departments, auditLog, payments } = schema;

type AttachmentRow = typeof attachments.$inferSelect;
export function attachmentDto(a: AttachmentRow) {
  return {
    id: a.id, clientId: a.clientId, kind: a.kind, name: a.originalName, mime: a.mime, size: a.sizeBytes, width: a.width, height: a.height,
    status: a.status, capturedAt: a.capturedAt, uploadedAt: a.uploadedAt, docType: a.docType, docScope: a.docScope, messageId: a.messageId,
    url: a.status === 'uploaded' ? `/api/v1/attachments/${a.id}/content` : null,
  };
}

export async function attachmentsFor(q: Q, expenseIds: string[]) {
  const map = new Map<string, AttachmentRow[]>();
  if (!expenseIds.length) return map;
  const rows = await q.select().from(attachments).where(and(inArray(attachments.expenseId, expenseIds), isNull(attachments.deletedAt))).orderBy(asc(attachments.createdAt));
  for (const r of rows) {
    if (r.kind === 'document' && !r.visibleToMember) continue;
    const list = map.get(r.expenseId!) ?? [];
    list.push(r);
    map.set(r.expenseId!, list);
  }
  return map;
}

export function expenseDto(e: Expense, o: { viewerId: string | null; finance: boolean; names: Map<string, { name: string }>; files: AttachmentRow[]; messages?: number }) {
  const mine = e.userId === o.viewerId;
  const privileged = mine || o.finance;
  return {
    id: e.id, clientId: mine ? e.clientId : null, tripId: e.tripId, locationId: e.locationId, userId: e.userId, userName: o.names.get(e.userId)?.name ?? '',
    isMine: mine, spentAt: e.spentAt, category: e.category, description: e.description, amountPaise: e.amountPaise,
    paymentMode: e.paymentMode, paidBy: e.paidBy, budgetSource: e.budgetSource, needsBudgetChoice: mine ? e.needsBudgetChoice : false,
    remarks: privileged ? e.remarks : null, verification: e.verification, approvedPaise: e.approvedPaise,
    approvalReason: privileged ? e.approvalReason : null, financeRemark: privileged ? e.financeRemark : null,
    flags: privileged ? e.flags : [], messageCount: privileged ? o.messages ?? 0 : 0,
    attachments: o.files.filter(f => privileged || f.kind === 'receipt').map(attachmentDto),
    version: e.version, createdAt: e.createdAt, updatedAt: e.updatedAt, receivedAt: e.receivedAt, deviceTime: privileged ? e.deviceTime : null,
  };
}
export type ExpenseDto = ReturnType<typeof expenseDto>;

export async function messageCounts(q: Q, expenseIds: string[]) {
  if (!expenseIds.length) return new Map<string, number>();
  const rows = await q.select({ id: expenseMessages.expenseId, c: sql<number>`count(*)` }).from(expenseMessages).where(inArray(expenseMessages.expenseId, expenseIds)).groupBy(expenseMessages.expenseId);
  return new Map(rows.map(r => [r.id, Number(r.c)]));
}

function memberDto(m: Member, trip: Trip, names: Map<string, { name: string; employeeCode: string }>) {
  const early = m.actualStart && m.actualStart < trip.scheduledStart && m.startMethod === 'manual' && !m.startBackdated ? trip.scheduledStart.getTime() - m.actualStart.getTime() : 0;
  return {
    userId: m.userId, name: names.get(m.userId)?.name ?? '', employeeCode: names.get(m.userId)?.employeeCode ?? '', role: m.role, joinStatus: m.joinStatus,
    invitedAt: m.invitedAt, respondedAt: m.respondedAt, actualStart: m.actualStart, startMethod: m.startMethod, startBackdated: m.startBackdated,
    startEarlyMinutes: early ? Math.round(early / 60000) : 0, actualEnd: m.actualEnd, endMethod: m.endMethod, endReason: m.endMethod === 'finance' ? m.endReason : null,
    running: isRunning(m), ended: !!m.actualEnd,
  };
}

/** Day 2 of 4, or day 5 of a 4-day trip when extended (FR-END-02/08). */
export function dayOf(trip: Trip, now: Date) {
  const start = trip.firstStartAt ?? trip.scheduledStart;
  const of = calendarDays(trip.scheduledStart, trip.tentativeEnd);
  const day = calendarDays(start, now < start ? start : now);
  return { day, of, extendedMs: trip.status === 'extended' ? Math.max(0, now.getTime() - trip.tentativeEnd.getTime()) : 0 };
}

/** Visible spend and totals for a viewer, computed only from what they may see (FR-ROLE-04). */
async function visibleTotals(q: Q, tripId: string, viewerId: string) {
  const r = await q.select({
    visible: sql<number>`coalesce(sum(${expenses.amountPaise}), 0)`,
    mine: sql<number>`coalesce(sum(case when ${expenses.userId} = ${viewerId} then ${expenses.amountPaise} else 0 end), 0)`,
    choose: sql<number>`count(*) filter (where ${expenses.userId} = ${viewerId} and ${expenses.needsBudgetChoice})`,
    queries: sql<number>`count(*) filter (where ${expenses.userId} = ${viewerId} and ${expenses.verification} = 'query')`,
  }).from(expenses).where(and(eq(expenses.tripId, tripId), notDeleted, visibleTo(viewerId)));
  return r[0];
}

async function visibleBudgets(q: Q, tripId: string, viewerId: string) {
  const bs = await activeBudgets(q, tripId);
  const pool = bs.find(b => b.type === 'pool');
  const ind = bs.find(b => b.type === 'individual' && b.memberUserId === viewerId);
  return { pool: pool ? await budgetView(q, pool) : null, individual: ind ? await budgetView(q, ind) : null };
}

/** FR-TRIP-05: the home screen groups. */
export async function myTrips(ctx: Ctx) {
  const uid = ctx.actor.id!;
  const rows = await ctx.tx.select({ t: trips, m: tripMembers }).from(tripMembers).innerJoin(trips, eq(trips.id, tripMembers.tripId))
    .where(and(eq(tripMembers.userId, uid), inArray(tripMembers.joinStatus, ['invited', 'accepted']))).orderBy(desc(trips.scheduledStart));
  const out = { invitations: [] as unknown[], scheduled: [] as unknown[], active: [] as unknown[], closed: [] as unknown[] };
  for (const { t, m } of rows) {
    if (m.joinStatus === 'invited' && !(t.status === 'scheduled' || t.status === 'active' || t.status === 'extended')) continue;
    const ms = await getMembers(ctx.tx, t.id);
    const names = await userNames(ctx.tx, [...ms.map(x => x.userId), t.ownerId]);
    const base = {
      id: t.id, ref: t.ref, name: t.name, type: t.type, purpose: t.purpose, primaryCity: t.primaryCity, clientEvent: t.clientEvent,
      status: t.status, scheduledStart: t.scheduledStart, tentativeEnd: t.tentativeEnd, owner: { id: t.ownerId, name: names.get(t.ownerId)?.name ?? '' },
    };
    if (m.joinStatus === 'invited') {
      out.invitations.push({ ...base, group: 'invitations', invitedAt: m.invitedAt, invitees: ms.filter(x => x.joinStatus === 'invited' || x.joinStatus === 'accepted').map(x => ({ userId: x.userId, name: names.get(x.userId)?.name ?? '', joinStatus: x.joinStatus })) });
      continue;
    }
    const tot = await visibleTotals(ctx.tx, t.id, uid);
    const bud = await visibleBudgets(ctx.tx, t.id, uid);
    const group = t.status === 'scheduled' ? 'scheduled' : t.status === 'active' || t.status === 'extended' ? 'active' : 'closed';
    const item = {
      ...base, group, firstStartAt: t.firstStartAt, closedAt: t.closedAt, cancelledAt: t.cancelledAt,
      me: { role: m.role, actualStart: m.actualStart, actualEnd: m.actualEnd, running: isRunning(m), claimStatus: m.claimStatus },
      members: ms.filter(x => x.joinStatus === 'accepted' || x.joinStatus === 'invited').map(x => ({ userId: x.userId, name: names.get(x.userId)?.name ?? '', joinStatus: x.joinStatus, running: isRunning(x), ended: !!x.actualEnd })),
      mySpendPaise: Number(tot.mine), visibleSpendPaise: Number(tot.visible), pool: bud.pool, individual: bud.individual,
      needsBudgetChoice: Number(tot.choose), openQueries: Number(tot.queries), progress: group === 'active' ? dayOf(t, ctx.now) : null,
    };
    (out[group] as unknown[]).push(item);
  }
  // Active and scheduled trips read best soonest-first.
  (out.scheduled as Array<{ scheduledStart: Date }>).sort((a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime());
  return out;
}

/** The invitee's limited view (FR-ROLE-01) with overlapping trips (FR-MEM-09). */
export async function invitationView(ctx: Ctx, trip: Trip, m: Member) {
  const ms = await getMembers(ctx.tx, trip.id);
  const names = await userNames(ctx.tx, [...ms.map(x => x.userId), trip.ownerId]);
  return {
    kind: 'invitation' as const,
    invitation: {
      tripId: trip.id, ref: trip.ref, name: trip.name, purpose: trip.purpose, primaryCity: trip.primaryCity, scheduledStart: trip.scheduledStart, tentativeEnd: trip.tentativeEnd,
      status: trip.status, owner: { id: trip.ownerId, name: names.get(trip.ownerId)?.name ?? '' }, invitedAt: m.invitedAt, joinStatus: m.joinStatus,
      invitees: ms.filter(x => x.userId !== trip.ownerId && (x.joinStatus === 'invited' || x.joinStatus === 'accepted')).map(x => ({ userId: x.userId, name: names.get(x.userId)?.name ?? '', joinStatus: x.joinStatus })),
      startedAlready: ctx.now >= trip.scheduledStart, runningCount: ms.filter(isRunning).length, firstStartAt: trip.firstStartAt,
    },
    overlaps: await overlappingTrips(ctx, m.userId, trip),
  };
}

/** FR-TRIP-06: the member's trip dashboard, everything filtered for this viewer. */
export async function tripSnapshot(ctx: Ctx, tripId: string) {
  const uid = ctx.actor.id!;
  const trip = await getTrip(ctx.tx, tripId);
  const me = await getMember(ctx.tx, tripId, uid);
  if (me && me.joinStatus === 'invited') return invitationView(ctx, trip, me);
  if (!isAccepted(me)) {
    if (me && ['withdrawn', 'expired', 'declined'].includes(me.joinStatus)) {
      return { kind: 'closed_request' as const, status: me.joinStatus, trip: { id: trip.id, name: trip.name, ref: trip.ref, status: trip.status, owner: trip.ownerId } };
    }
    throw forbidden('You are not a member of this trip.', 'not_member');
  }
  const ms = await getMembers(ctx.tx, tripId);
  const visibleMembers = ms.filter(m => m.joinStatus === 'accepted' || m.joinStatus === 'invited' || m.joinStatus === 'declined');
  const exps = await ctx.tx.select().from(expenses).where(and(eq(expenses.tripId, tripId), notDeleted, visibleTo(uid))).orderBy(desc(expenses.spentAt));
  const names = await userNames(ctx.tx, [...ms.map(m => m.userId), ...exps.map(e => e.userId), trip.ownerId]);
  const files = await attachmentsFor(ctx.tx, exps.map(e => e.id));
  const msgs = await messageCounts(ctx.tx, exps.filter(e => e.userId === uid).map(e => e.id));
  const locs = await ctx.tx.select().from(locations).where(and(eq(locations.tripId, tripId), isNull(locations.deletedAt))).orderBy(asc(locations.arrivalDate), asc(locations.createdAt));
  const visibleTotal = exps.reduce((s, e) => s + e.amountPaise, 0);
  const allCounts = await ctx.tx.select({ id: expenses.locationId, c: sql<number>`count(*)` }).from(expenses).where(and(eq(expenses.tripId, tripId), notDeleted)).groupBy(expenses.locationId);
  const inUse = new Set(allCounts.filter(r => Number(r.c) > 0).map(r => r.id));
  const locDtos = locs.map(l => {
    const le = exps.filter(e => e.locationId === l.id);
    const total = le.reduce((s, e) => s + e.amountPaise, 0);
    return {
      id: l.id, clientId: l.clientId, city: l.city, venue: l.venue, address: l.address, lat: l.lat, lng: l.lng, arrivalDate: l.arrivalDate, departureDate: l.departureDate,
      notes: l.notes, isPrimary: l.isPrimary, addedBy: l.addedBy, addedByName: names.get(l.addedBy)?.name ?? '', expenseCount: le.length, totalPaise: total,
      sharePct: visibleTotal ? Math.round((total / visibleTotal) * 100) : 0, canDelete: (l.addedBy === uid || trip.ownerId === uid) && !inUse.has(l.id) && locs.length > 1,
    };
  });
  const cats = new Map<string, number>();
  for (const e of exps) cats.set(e.category, (cats.get(e.category) ?? 0) + e.amountPaise);
  const categories = [...cats.entries()].sort((a, b) => b[1] - a[1]).map(([category, totalPaise]) => ({ category, totalPaise, pct: visibleTotal ? Math.round((totalPaise / visibleTotal) * 100) : 0 }));
  const bud = await visibleBudgets(ctx.tx, tripId, uid);
  const claim = await claimTotals(ctx.tx, tripId, uid);
  const live = trip.status === 'scheduled' || trip.status === 'active' || trip.status === 'extended';
  const isOwner = trip.ownerId === uid;
  const anyExpense = await ctx.tx.select({ c: sql<number>`count(*)` }).from(expenses).where(and(eq(expenses.tripId, tripId), notDeleted));
  const myExpenseCount = claim.count;
  const resumeUntil = me!.actualEnd && me!.endMethod === 'member' ? new Date(me!.actualEnd.getTime() + 30 * 60000) : null;
  return {
    kind: 'trip' as const,
    trip: {
      id: trip.id, ref: trip.ref, name: trip.name, type: trip.type, purpose: trip.purpose, clientEvent: trip.clientEvent, primaryCity: trip.primaryCity, notes: trip.notes,
      departmentId: trip.departmentId, status: trip.status, scheduledStart: trip.scheduledStart, tentativeEnd: trip.tentativeEnd, enteredAfterStart: trip.enteredAfterStart,
      firstStartAt: trip.firstStartAt, closedAt: trip.closedAt, cancelledAt: trip.cancelledAt, cancelReason: trip.cancelReason, ownerId: trip.ownerId,
      ownerName: names.get(trip.ownerId)?.name ?? '', version: trip.version, progress: trip.status === 'active' || trip.status === 'extended' ? dayOf(trip, ctx.now) : null,
      durationDays: calendarDays(trip.scheduledStart, trip.tentativeEnd), window: await tripWindow(ctx, trip),
    },
    me: {
      userId: uid, role: me!.role, actualStart: me!.actualStart, startMethod: me!.startMethod, actualEnd: me!.actualEnd, endMethod: me!.endMethod,
      endReason: me!.endMethod === 'finance' ? me!.endReason : null, running: isRunning(me), claimStatus: me!.claimStatus,
      resumeUntil: resumeUntil && resumeUntil > ctx.now ? resumeUntil : null,
      pastPlannedEnd: isRunning(me) && ctx.now > trip.tentativeEnd ? humanDuration(ctx.now.getTime() - trip.tentativeEnd.getTime()) : null,
    },
    members: visibleMembers.map(m => memberDto(m, trip, names)),
    locations: locDtos,
    budgets: bud,
    expenses: exps.map(e => expenseDto(e, { viewerId: uid, finance: false, names, files: files.get(e.id) ?? [], messages: msgs.get(e.id) })),
    categories,
    totals: { visibleSpendPaise: visibleTotal, mySpendPaise: claim.totalPaise, myExpenseCount },
    claim,
    permissions: {
      canEdit: isOwner && live,
      canInvite: isOwner && live,
      canCancel: isOwner && live && (trip.status === 'scheduled' || Number(anyExpense[0].c) === 0),
      canStart: live && !me!.actualStart,
      canEnd: isRunning(me),
      canResume: !!resumeUntil && resumeUntil > ctx.now,
      canAddExpense: me!.claimStatus !== 'reimbursed' && trip.status !== 'cancelled' && (!!me!.actualStart || trip.status === 'scheduled' || !me!.actualStart),
      canAddLocation: live,
      canLeave: !isOwner && myExpenseCount === 0 && trip.status !== 'cancelled',
      canHandOver: isOwner && live && ms.some(m => m.userId !== uid && isAccepted(m)),
      canExport: myExpenseCount > 0,
    },
    serverTime: ctx.now,
  };
}

/** One location and its visible expenses by date (FR-LOC-04). */
export async function locationView(ctx: Ctx, locationId: string) {
  const uid = ctx.actor.id!;
  const l = (await ctx.tx.select().from(locations).where(and(eq(locations.id, locationId), isNull(locations.deletedAt))))[0];
  if (!l) throw forbidden('Location not found.', 'not_found');
  const me = await getMember(ctx.tx, l.tripId, uid);
  if (!isAccepted(me)) throw forbidden('You are not a member of this trip.', 'not_member');
  const exps = await ctx.tx.select().from(expenses).where(and(eq(expenses.locationId, l.id), notDeleted, visibleTo(uid))).orderBy(desc(expenses.spentAt));
  const names = await userNames(ctx.tx, exps.map(e => e.userId));
  const files = await attachmentsFor(ctx.tx, exps.map(e => e.id));
  const days = new Map<string, ExpenseDto[]>();
  for (const e of exps) {
    const d = istDate(e.spentAt);
    const list = days.get(d) ?? [];
    list.push(expenseDto(e, { viewerId: uid, finance: false, names, files: files.get(e.id) ?? [] }));
    days.set(d, list);
  }
  return {
    location: { id: l.id, tripId: l.tripId, city: l.city, venue: l.venue, address: l.address, arrivalDate: l.arrivalDate, departureDate: l.departureDate, notes: l.notes, isPrimary: l.isPrimary, addedBy: l.addedBy },
    totalPaise: exps.reduce((s, e) => s + e.amountPaise, 0),
    days: [...days.entries()].map(([date, items]) => ({ date, totalPaise: items.reduce((s, e) => s + e.amountPaise, 0), expenses: items })),
  };
}

/** Expense detail with receipts, query thread and history for its member (FR-EXP, M10). Others see pool expenses without threads. */
export async function expenseView(ctx: Ctx, expenseId: string, finance = false) {
  const uid = ctx.actor.id!;
  const e = (await ctx.tx.select().from(expenses).where(and(eq(expenses.id, expenseId), notDeleted)))[0];
  if (!e) throw forbidden('Expense not found.', 'not_found');
  if (!finance) {
    const me = await getMember(ctx.tx, e.tripId, uid);
    if (!isAccepted(me) || (e.userId !== uid && e.budgetSource !== 'pool')) throw forbidden('Expense not found.', 'not_found');
  }
  const privileged = finance || e.userId === uid;
  const names = await userNames(ctx.tx, [e.userId]);
  const files = (await attachmentsFor(ctx.tx, [e.id])).get(e.id) ?? [];
  const thread = privileged ? await ctx.tx.select({ m: expenseMessages, name: users.name }).from(expenseMessages).innerJoin(users, eq(users.id, expenseMessages.authorId)).where(eq(expenseMessages.expenseId, e.id)).orderBy(asc(expenseMessages.createdAt)) : [];
  const history = privileged ? await ctx.tx.select().from(auditLog).where(eq(auditLog.entityId, e.id)).orderBy(desc(auditLog.at)) : [];
  const loc = (await ctx.tx.select().from(locations).where(eq(locations.id, e.locationId)))[0];
  const trip = await getTrip(ctx.tx, e.tripId);
  const member = await getMember(ctx.tx, e.tripId, e.userId);
  return {
    expense: expenseDto(e, { viewerId: finance ? null : uid, finance, names, files, messages: thread.length }),
    location: loc ? { id: loc.id, city: loc.city, venue: loc.venue } : null,
    trip: { id: trip.id, ref: trip.ref, name: trip.name, status: trip.status },
    thread: thread.map(({ m, name }) => ({ id: m.id, side: m.side, kind: m.kind, body: m.body, authorId: m.authorId, authorName: name, createdAt: m.createdAt, attachments: files.filter(f => f.messageId === m.id).map(attachmentDto) })),
    history: history.map(h => ({ at: h.at, action: h.action, actor: h.actorLabel, before: h.before, after: h.after })),
    canEdit: e.userId === uid && !['verified', 'rejected'].includes(e.verification) && member?.claimStatus !== 'reimbursed' && (!member?.actualEnd || e.verification === 'query'),
  };
}

/** My claim (M13): totals by budget source, verification progress and payments. */
export async function myClaim(ctx: Ctx, tripId: string) {
  const uid = ctx.actor.id!;
  const me = await getMember(ctx.tx, tripId, uid);
  if (!isAccepted(me)) throw forbidden('You are not a member of this trip.', 'not_member');
  const trip = await getTrip(ctx.tx, tripId);
  const totals = await claimTotals(ctx.tx, tripId, uid);
  const pays = await ctx.tx.select().from(payments).where(and(eq(payments.tripId, tripId), eq(payments.memberUserId, uid))).orderBy(asc(payments.paidOn));
  const proofIds = pays.map(p => p.proofAttachmentId).filter((x): x is string => !!x);
  const proofs = proofIds.length ? await ctx.tx.select().from(attachments).where(inArray(attachments.id, proofIds)) : [];
  const exps = await ctx.tx.select().from(expenses).where(and(eq(expenses.tripId, tripId), eq(expenses.userId, uid), notDeleted)).orderBy(desc(expenses.spentAt));
  const names = await userNames(ctx.tx, [uid]);
  const files = await attachmentsFor(ctx.tx, exps.map(e => e.id));
  const docs = await ctx.tx.select().from(attachments).where(and(eq(attachments.tripId, tripId), eq(attachments.kind, 'document'), eq(attachments.memberUserId, uid), eq(attachments.visibleToMember, true), isNull(attachments.deletedAt)));
  return {
    trip: { id: trip.id, ref: trip.ref, name: trip.name, status: trip.status },
    status: me!.claimStatus, statusAt: me!.claimStatusAt, reopenedAt: me!.reopenedAt, reopenReason: me!.reopenReason, totals,
    payments: pays.map(p => ({ id: p.id, amountPaise: p.amountPaise, paidOn: p.paidOn, mode: p.mode, reference: p.reference, proof: proofs.find(x => x.id === p.proofAttachmentId) ? attachmentDto(proofs.find(x => x.id === p.proofAttachmentId)!) : null, recordedAt: p.recordedAt })),
    expenses: exps.map(e => expenseDto(e, { viewerId: uid, finance: false, names, files: files.get(e.id) ?? [] })),
    documents: docs.map(attachmentDto),
  };
}

export async function departmentName(q: Q, id: string) {
  return (await q.select({ name: departments.name }).from(departments).where(eq(departments.id, id)))[0]?.name ?? '';
}
export { users };
