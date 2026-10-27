/** What the finance console reads (SRS §7.1): trips list, trip page, claims queue, claim review, dashboard. */
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { schema } from '../../db/client.js';
import type { Ctx } from '../../lib/context.js';
import { notFound } from '../../lib/errors.js';
import { istDate } from '../../lib/time.js';
import {
  activeBudgets, budgetView, claimTotals, getMember, getMembers, getTrip, isAccepted, isRunning, notDeleted, userNames,
} from '../domain.js';
import { attachmentDto, attachmentsFor, dayOf, expenseDto, messageCounts } from '../trips/views.js';
import { exportDto } from '../exports/service.js';
import { tripWindow } from '../locations/service.js';

const { trips, tripMembers, expenses, attachments, payments, locations, users, departments, exportsTable, auditLog, expenseMessages } = schema;

export interface TripListQuery {
  status?: string[]; departmentId?: string; ownerId?: string; memberId?: string; from?: string; to?: string;
  budget?: 'pool' | 'individual' | 'unbudgeted' | 'over'; claim?: string; q?: string; sort?: string; page?: number; pageSize?: number;
}

/** FR-WEB-02: every trip across departments with filters and search; one query, fine for thousands of trips (NFR-05). */
export async function tripList(ctx: Ctx, f: TripListQuery) {
  const where: SQL[] = [sql`true`];
  if (f.status?.length) where.push(sql`t.status = any(${sql.raw(`array[${f.status.map(s => `'${s.replace(/[^a-z_]/g, '')}'`).join(',')}]::trip_status[]`)})`);
  if (f.departmentId) where.push(sql`t.department_id = ${f.departmentId}`);
  if (f.ownerId) where.push(sql`t.owner_id = ${f.ownerId}`);
  if (f.memberId) where.push(sql`exists (select 1 from trip_members tm where tm.trip_id = t.id and tm.user_id = ${f.memberId} and tm.join_status = 'accepted')`);
  if (f.from) where.push(sql`t.tentative_end >= ${f.from}::date`);
  if (f.to) where.push(sql`t.scheduled_start < (${f.to}::date + 1)`);
  if (f.claim) where.push(sql`exists (select 1 from trip_members tm where tm.trip_id = t.id and tm.join_status = 'accepted' and tm.claim_status = ${f.claim}::claim_status)`);
  if (f.q?.trim()) { const q = `%${f.q.trim()}%`; where.push(sql`(t.name ilike ${q} or t.ref ilike ${q} or coalesce(t.client_event,'') ilike ${q} or t.primary_city ilike ${q})`); }
  if (f.budget === 'pool') where.push(sql`p.alloc is not null`);
  if (f.budget === 'individual') where.push(sql`coalesce(i.n, 0) > 0`);
  if (f.budget === 'unbudgeted') where.push(sql`p.alloc is null and coalesce(i.n, 0) = 0`);
  if (f.budget === 'over') where.push(sql`((p.alloc is not null and p.spent >= p.alloc) or coalesce(i.over_any, false))`);
  const order = { start_asc: sql`t.scheduled_start asc`, spend_desc: sql`coalesce(s.total,0) desc`, ref_desc: sql`t.ref desc` }[f.sort ?? ''] ?? sql`case when t.status in ('active','extended') then 0 when t.status = 'scheduled' then 1 else 2 end, t.scheduled_start desc`;
  const pageSize = Math.min(f.pageSize ?? 50, 200), page = Math.max(f.page ?? 1, 1);
  const draw = sql.raw(`case when e.paid_by = 'self' and e.verification <> 'rejected' then coalesce(e.approved_paise, e.amount_paise) else 0 end`);
  const r = await ctx.tx.execute(sql`
    with s as (select trip_id, sum(amount_paise) total, count(*) n,
                 count(*) filter (where verification in ('verified','rejected')) settled, count(*) filter (where verification = 'query') queries
               from expenses where deleted_at is null group by trip_id),
         p as (select b.trip_id, b.amount_paise alloc,
                 coalesce((select sum(${draw}) from expenses e where e.trip_id = b.trip_id and e.budget_source = 'pool' and e.deleted_at is null), 0) spent
               from budgets b where b.type = 'pool' and b.removed_at is null),
         i as (select b.trip_id, count(*) n,
                 bool_or(coalesce((select sum(${draw}) from expenses e where e.trip_id = b.trip_id and e.user_id = b.member_user_id and e.budget_source = 'individual' and e.deleted_at is null), 0) >= b.amount_paise) over_any
               from budgets b where b.type = 'individual' and b.removed_at is null group by b.trip_id),
         m as (select trip_id, count(*) filter (where join_status = 'accepted') accepted, count(*) filter (where join_status = 'invited') invited,
                 count(*) filter (where join_status = 'declined') declined,
                 count(*) filter (where join_status = 'accepted' and actual_start is not null and actual_end is null) running,
                 count(*) filter (where join_status = 'accepted' and claim_status = 'ready') ready,
                 count(*) filter (where join_status = 'accepted' and claim_status = 'verified') verified,
                 count(*) filter (where join_status = 'accepted' and claim_status in ('part_paid','reimbursed')) paid,
                 count(*) filter (where join_status = 'accepted' and start_method = 'manual' and actual_start < (select scheduled_start from trips x where x.id = trip_id)) early,
                 min(actual_start) first_start, max(actual_end) last_end
               from trip_members group by trip_id)
    select t.id, t.ref, t.name, t.status, t.purpose, t.client_event "clientEvent", t.primary_city "primaryCity", t.scheduled_start "scheduledStart", t.tentative_end "tentativeEnd",
           t.first_start_at "firstStartAt", t.closed_at "closedAt", t.cancelled_at "cancelledAt", t.entered_after_start "enteredAfterStart", t.department_id "departmentId", d.name "departmentName",
           (select coalesce(array_agg(tm.user_id), '{}') from trip_members tm join users fu on fu.id = tm.user_id where tm.trip_id = t.id and tm.join_status = 'accepted' and fu.is_finance) "financeMemberIds",
           t.owner_id "ownerId", u.name "ownerName", u.active "ownerActive",
           coalesce(s.total, 0) "spendPaise", coalesce(s.n, 0) "expenseCount", coalesce(s.settled, 0) "settledCount", coalesce(s.queries, 0) "queryCount",
           p.alloc "poolPaise", p.spent "poolSpentPaise", coalesce(i.n, 0) "individualCount", coalesce(i.over_any, false) "individualOver",
           coalesce(m.accepted, 0) "memberCount", coalesce(m.invited, 0) "invitedCount", coalesce(m.declined, 0) "declinedCount", coalesce(m.running, 0) "runningCount",
           coalesce(m.ready, 0) "claimsReady", coalesce(m.verified, 0) "claimsVerified", coalesce(m.paid, 0) "claimsPaid", coalesce(m.early, 0) "earlyStarts",
           m.last_end "lastEnd", count(*) over() "totalRows"
    from trips t join departments d on d.id = t.department_id join users u on u.id = t.owner_id
    left join s on s.trip_id = t.id left join p on p.trip_id = t.id left join i on i.trip_id = t.id left join m on m.trip_id = t.id
    where ${sql.join(where, sql` and `)}
    order by ${order}
    limit ${pageSize} offset ${(page - 1) * pageSize}`);
  const rows = r.rows as Array<Record<string, unknown>>;
  const total = rows.length ? Number(rows[0].totalRows) : 0;
  return {
    total, page, pageSize,
    items: rows.map(x => {
      const { totalRows: _t, ...rest } = x;
      const pool = x.poolPaise == null ? null : { allocatedPaise: Number(x.poolPaise), spentPaise: Number(x.poolSpentPaise), pct: Number(x.poolPaise) ? Math.floor(Number(x.poolSpentPaise) * 100 / Number(x.poolPaise)) : 0 };
      const t = { status: x.status as string, scheduledStart: new Date(String(x.scheduledStart)), tentativeEnd: new Date(String(x.tentativeEnd)), firstStartAt: x.firstStartAt ? new Date(String(x.firstStartAt)) : null };
      return { ...rest, pool, progress: t.status === 'active' || t.status === 'extended' ? dayOf(t as never, ctx.now) : null };
    }),
  };
}

function memberRow(m: typeof tripMembers.$inferSelect, trip: typeof trips.$inferSelect, names: Map<string, { name: string; employeeCode: string }>) {
  const early = m.actualStart && m.startMethod === 'manual' && !m.startBackdated && m.actualStart < trip.scheduledStart ? trip.scheduledStart.getTime() - m.actualStart.getTime() : 0;
  return {
    userId: m.userId, name: names.get(m.userId)?.name ?? '', employeeCode: names.get(m.userId)?.employeeCode ?? '', role: m.role, joinStatus: m.joinStatus,
    invitedAt: m.invitedAt, respondedAt: m.respondedAt, actualStart: m.actualStart, startMethod: m.startMethod, startBackdated: m.startBackdated,
    startEarlyMinutes: early ? Math.round(early / 60000) : 0, startDeviceTime: m.startDeviceTime, startReceivedAt: m.startReceivedAt,
    actualEnd: m.actualEnd, endMethod: m.endMethod, endReason: m.endReason, endReceivedAt: m.endReceivedAt, running: isRunning(m),
    pastEndMs: isRunning(m) && trip.status === 'extended' ? Math.max(0, Date.now() - trip.tentativeEnd.getTime()) : 0,
    remindersSent: m.lastReminderAt ? 1 : 0, claimStatus: m.claimStatus, claimStatusAt: m.claimStatusAt, reopenedAt: m.reopenedAt, reopenReason: m.reopenReason,
  };
}

/** FR-WEB-04: the whole trip for finance. */
export async function financeTrip(ctx: Ctx, tripId: string) {
  const trip = await getTrip(ctx.tx, tripId);
  const ms = await getMembers(ctx.tx, tripId);
  const exps = await ctx.tx.select().from(expenses).where(and(eq(expenses.tripId, tripId), notDeleted)).orderBy(desc(expenses.spentAt));
  const owner = (await ctx.tx.select().from(users).where(eq(users.id, trip.ownerId)))[0];
  const names = await userNames(ctx.tx, [...ms.map(m => m.userId), ...exps.map(e => e.userId), trip.ownerId]);
  const files = await attachmentsFor(ctx.tx, exps.map(e => e.id));
  const msgs = await messageCounts(ctx.tx, exps.map(e => e.id));
  const locs = await ctx.tx.select().from(locations).where(and(eq(locations.tripId, tripId), isNull(locations.deletedAt))).orderBy(asc(locations.arrivalDate));
  const bs = await activeBudgets(ctx.tx, tripId);
  const budgetsV = await Promise.all(bs.map(b => budgetView(ctx.tx, b)));
  const docs = await ctx.tx.select().from(attachments).where(and(eq(attachments.tripId, tripId), eq(attachments.kind, 'document'), isNull(attachments.deletedAt))).orderBy(desc(attachments.createdAt));
  const receipts = await ctx.tx.select().from(attachments).where(and(eq(attachments.tripId, tripId), eq(attachments.kind, 'receipt'), isNull(attachments.deletedAt)));
  const pays = await ctx.tx.select().from(payments).where(eq(payments.tripId, tripId)).orderBy(asc(payments.recordedAt));
  const exportRows = await ctx.tx.select().from(exportsTable).where(eq(exportsTable.tripId, tripId)).orderBy(desc(exportsTable.createdAt));
  const dept = (await ctx.tx.select().from(departments).where(eq(departments.id, trip.departmentId)))[0];
  const claims = [];
  for (const m of ms.filter(isAccepted)) claims.push({ userId: m.userId, name: names.get(m.userId)?.name ?? '', status: m.claimStatus, ...(await claimTotals(ctx.tx, tripId, m.userId)) });
  const me = ctx.actor.id ? await getMember(ctx.tx, tripId, ctx.actor.id) : undefined;
  const uploaderNames = await userNames(ctx.tx, [...docs.map(d => d.uploadedBy), ...pays.map(p => p.recordedBy), ...exportRows.map(x => x.requestedBy)]);
  const totalSpend = exps.reduce((s, e) => s + e.amountPaise, 0);
  const cats = new Map<string, number>();
  for (const e of exps) cats.set(e.category, (cats.get(e.category) ?? 0) + e.amountPaise);
  return {
    trip: {
      ...trip, departmentName: dept?.name ?? '', ownerName: owner?.name ?? '', ownerActive: owner?.active ?? false,
      progress: trip.status === 'active' || trip.status === 'extended' ? dayOf(trip, ctx.now) : null, window: await tripWindow(ctx, trip),
    },
    members: ms.map(m => memberRow(m, trip, names)),
    budgets: { pool: budgetsV.find(b => b.type === 'pool') ?? null, individuals: budgetsV.filter(b => b.type === 'individual').map(b => ({ ...b, memberName: names.get(b.memberUserId!)?.name ?? '' })) },
    locations: locs.map(l => ({ ...l, expenseCount: exps.filter(e => e.locationId === l.id).length, totalPaise: exps.filter(e => e.locationId === l.id).reduce((s, e) => s + e.amountPaise, 0) })),
    expenses: exps.map(e => expenseDto(e, { viewerId: null, finance: true, names, files: files.get(e.id) ?? [], messages: msgs.get(e.id) })),
    claims,
    totals: { spendPaise: totalSpend, expenseCount: exps.length, receiptCount: receipts.length, pendingUploads: receipts.filter(r => r.status !== 'uploaded').length, documentCount: docs.length },
    categories: [...cats.entries()].sort((a, b) => b[1] - a[1]).map(([category, totalPaise]) => ({ category, totalPaise, pct: totalSpend ? Math.round(totalPaise / totalSpend * 100) : 0 })),
    documents: docs.map(d => ({ ...attachmentDto(d), note: d.note, memberUserId: d.memberUserId, expenseId: d.expenseId, uploadedBy: d.uploadedBy, uploadedByName: uploaderNames.get(d.uploadedBy)?.name ?? '', visibleToMember: d.visibleToMember, canDelete: d.uploadedBy === ctx.actor.id })),
    payments: pays.map(p => ({ ...p, recordedByName: uploaderNames.get(p.recordedBy)?.name ?? '' })),
    exports: exportRows.map(x => exportDto(x, { tripRef: trip.ref, tripName: trip.name, requestedByName: uploaderNames.get(x.requestedBy)?.name ?? '', memberName: x.memberUserId ? names.get(x.memberUserId)?.name ?? null : null })),
    viewer: { isMember: isAccepted(me), canSetBudgets: !isAccepted(me) && trip.status !== 'cancelled' },
    financeUsers: await financeUsersFor(ctx, tripId),
  };
}

/** Active finance users and whether each is on the trip, for "Ask another finance user" (FR-VER-10). */
async function financeUsersFor(ctx: Ctx, tripId: string) {
  const fu = await ctx.tx.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.isFinance, true), eq(users.active, true))).orderBy(asc(users.name));
  const ms = await getMembers(ctx.tx, tripId);
  return fu.map(u => ({ userId: u.id, name: u.name, onTrip: ms.some(m => m.userId === u.id && isAccepted(m)), isMe: u.id === ctx.actor.id }));
}

/** W12: every member claim waiting on finance, longest waiting first. */
export async function claimsQueue(ctx: Ctx, f: { status?: string; q?: string; departmentId?: string }) {
  const statuses = f.status ? [f.status] : ['ready', 'verified', 'part_paid'];
  const rows = await ctx.tx.select({ m: tripMembers, t: trips, u: users, d: departments }).from(tripMembers)
    .innerJoin(trips, eq(trips.id, tripMembers.tripId)).innerJoin(users, eq(users.id, tripMembers.userId)).innerJoin(departments, eq(departments.id, trips.departmentId))
    .where(and(eq(tripMembers.joinStatus, 'accepted'), inArray(tripMembers.claimStatus, statuses as Array<'ready'>), f.departmentId ? eq(trips.departmentId, f.departmentId) : sql`true`,
      f.q?.trim() ? sql`(${trips.name} ilike ${'%' + f.q.trim() + '%'} or ${trips.ref} ilike ${'%' + f.q.trim() + '%'} or ${users.name} ilike ${'%' + f.q.trim() + '%'})` : sql`true`))
    .orderBy(asc(tripMembers.claimStatusAt));
  const out = [];
  for (const { m, t, u, d } of rows) {
    const tot = await claimTotals(ctx.tx, t.id, m.userId);
    if (tot.count === 0) continue;
    const flagged = await ctx.tx.select({ c: sql<number>`count(*)` }).from(expenses).where(and(eq(expenses.tripId, t.id), eq(expenses.userId, m.userId), notDeleted, sql`cardinality(${expenses.flags}) > 0`));
    out.push({
      tripId: t.id, ref: t.ref, tripName: t.name, tripStatus: t.status, departmentName: d.name, userId: u.id, name: u.name, employeeCode: u.employeeCode,
      status: m.claimStatus, since: m.claimStatusAt, waitingMs: ctx.now.getTime() - m.claimStatusAt.getTime(), totals: tot, flagged: Number(flagged[0].c),
      actualStart: m.actualStart, actualEnd: m.actualEnd, endMethod: m.endMethod,
      ownClaim: u.id === ctx.actor.id,
    });
  }
  return out;
}

/** W06: one member's claim, receipt by receipt. */
export async function claimReview(ctx: Ctx, tripId: string, userId: string) {
  const trip = await getTrip(ctx.tx, tripId);
  const m = await getMember(ctx.tx, tripId, userId);
  if (!isAccepted(m)) throw notFound('Claim');
  const u = (await ctx.tx.select().from(users).where(eq(users.id, userId)))[0];
  const exps = await ctx.tx.select().from(expenses).where(and(eq(expenses.tripId, tripId), eq(expenses.userId, userId), notDeleted)).orderBy(asc(expenses.spentAt));
  const names = await userNames(ctx.tx, [userId, trip.ownerId]);
  const files = await attachmentsFor(ctx.tx, exps.map(e => e.id));
  const thread = exps.length ? await ctx.tx.select({ m: expenseMessages, name: users.name }).from(expenseMessages).innerJoin(users, eq(users.id, expenseMessages.authorId)).where(inArray(expenseMessages.expenseId, exps.map(e => e.id))).orderBy(asc(expenseMessages.createdAt)) : [];
  const locs = await ctx.tx.select().from(locations).where(eq(locations.tripId, tripId));
  const bs = await activeBudgets(ctx.tx, tripId);
  const pool = bs.find(b => b.type === 'pool'), ind = bs.find(b => b.type === 'individual' && b.memberUserId === userId);
  const pays = await ctx.tx.select().from(payments).where(and(eq(payments.tripId, tripId), eq(payments.memberUserId, userId))).orderBy(asc(payments.recordedAt));
  const docs = await ctx.tx.select().from(attachments).where(and(eq(attachments.tripId, tripId), eq(attachments.kind, 'document'), eq(attachments.memberUserId, userId), isNull(attachments.deletedAt)));
  const dept = (await ctx.tx.select().from(departments).where(eq(departments.id, trip.departmentId)))[0];
  const payNames = await userNames(ctx.tx, [...pays.map(p => p.recordedBy), ...docs.map(d => d.uploadedBy)]);
  return {
    trip: { id: trip.id, ref: trip.ref, name: trip.name, status: trip.status, scheduledStart: trip.scheduledStart, tentativeEnd: trip.tentativeEnd, departmentName: dept?.name ?? '', ownerId: trip.ownerId },
    member: { userId, name: u.name, employeeCode: u.employeeCode, actualStart: m!.actualStart, startMethod: m!.startMethod, actualEnd: m!.actualEnd, endMethod: m!.endMethod, endReason: m!.endReason, running: isRunning(m) },
    claim: { status: m!.claimStatus, since: m!.claimStatusAt, reopenedAt: m!.reopenedAt, reopenReason: m!.reopenReason, ...(await claimTotals(ctx.tx, tripId, userId)) },
    budgets: { pool: pool ? await budgetView(ctx.tx, pool) : null, individual: ind ? await budgetView(ctx.tx, ind) : null },
    expenses: exps.map(e => ({
      ...expenseDto(e, { viewerId: null, finance: true, names, files: files.get(e.id) ?? [] }),
      locationCity: locs.find(l => l.id === e.locationId)?.city ?? '',
      thread: thread.filter(t => t.m.expenseId === e.id).map(({ m: x, name }) => ({ id: x.id, side: x.side, kind: x.kind, body: x.body, authorName: name, createdAt: x.createdAt, attachments: (files.get(e.id) ?? []).filter(f => f.messageId === x.id).map(attachmentDto) })),
    })),
    payments: pays.map(p => ({ ...p, recordedByName: payNames.get(p.recordedBy)?.name ?? '', proof: docs.find(d => d.id === p.proofAttachmentId) ? attachmentDto(docs.find(d => d.id === p.proofAttachmentId)!) : null })),
    documents: docs.map(d => ({ ...attachmentDto(d), note: d.note, uploadedBy: d.uploadedBy, uploadedByName: payNames.get(d.uploadedBy)?.name ?? '', canDelete: d.uploadedBy === ctx.actor.id && m!.claimStatus !== 'reimbursed' })),
    viewer: { ownClaim: userId === ctx.actor.id, locked: m!.claimStatus === 'reimbursed' },
    financeUsers: await financeUsersFor(ctx, tripId),
  };
}

/** FR-WEB-07: dashboard numbers and lists. */
export async function dashboard(ctx: Ctx, month?: string) {
  // Spend is for one IST calendar month: this month by default, or the month asked for (W02 month switch).
  const monthStart = `${month ?? istDate(ctx.now).slice(0, 7)}-01`;
  const [yy, mm] = monthStart.split('-').map(Number);
  const monthEnd = `${mm === 12 ? yy + 1 : yy}-${String(mm === 12 ? 1 : mm + 1).padStart(2, '0')}-01`;
  const k = await ctx.tx.execute(sql`
    select
      (select count(*) from trips where status in ('active','extended')) running,
      (select count(*) from trips where status = 'extended') extended,
      (select count(distinct department_id) from trips where status in ('active','extended')) departments,
      (select count(*) from trip_members tm where tm.join_status = 'accepted' and tm.claim_status = 'ready' and exists (select 1 from expenses e where e.trip_id = tm.trip_id and e.user_id = tm.user_id and e.deleted_at is null)) ready,
      (select min(claim_status_at) from trip_members tm where tm.join_status = 'accepted' and tm.claim_status = 'ready' and exists (select 1 from expenses e where e.trip_id = tm.trip_id and e.user_id = tm.user_id and e.deleted_at is null)) oldest_ready,
      (select count(*) from trip_members where join_status = 'accepted' and claim_status in ('verified','part_paid') ) verified_unpaid,
      (select count(*) from expenses where verification = 'query' and deleted_at is null) queries,
      (select coalesce(sum(amount_paise),0) from expenses where deleted_at is null and (spent_at at time zone 'Asia/Kolkata')::date >= ${monthStart}::date and (spent_at at time zone 'Asia/Kolkata')::date < ${monthEnd}::date) month_spend`);
  const kr = k.rows[0] as Record<string, unknown>;
  const byDept = await ctx.tx.execute(sql`select d.id, d.name, coalesce(sum(e.amount_paise),0) total, count(distinct t.id) trips
    from expenses e join trips t on t.id = e.trip_id join departments d on d.id = t.department_id
    where e.deleted_at is null and (e.spent_at at time zone 'Asia/Kolkata')::date >= ${monthStart}::date and (e.spent_at at time zone 'Asia/Kolkata')::date < ${monthEnd}::date
    group by d.id, d.name order by total desc`);
  const running = await tripList(ctx, { status: ['active', 'extended'], pageSize: 8 });
  const attention = await ctx.tx.execute(sql`
    select 'extended' kind, t.id "tripId", t.ref, t.name, null::uuid "userId", u.name "who", t.tentative_end at
      from trips t join trip_members tm on tm.trip_id = t.id and tm.join_status = 'accepted' and tm.actual_start is not null and tm.actual_end is null
      join users u on u.id = tm.user_id where t.status = 'extended'
    union all
    select 'owner_inactive', t.id, t.ref, t.name, t.owner_id, u.name, t.updated_at from trips t join users u on u.id = t.owner_id
      where u.active = false and t.status in ('scheduled','active','extended')
    union all
    select 'receipt_pending', t.id, t.ref, t.name, a.member_user_id, u.name, a.created_at from attachments a join trips t on t.id = a.trip_id join users u on u.id = a.member_user_id
      where a.status = 'pending' and a.deleted_at is null and a.created_at < now() - interval '2 hours'
    order by at asc limit 12`);
  const readyClaims = (await claimsQueue(ctx, { status: 'ready' })).slice(0, 6);
  const activity = await ctx.tx.select().from(auditLog).where(inArray(auditLog.action, ['trip.create', 'member.start', 'member.end', 'expense.create', 'expense.reply', 'trip.extended', 'trip.close', 'member.accept', 'member.decline'])).orderBy(desc(auditLog.at)).limit(12);
  const tripNames = await ctx.tx.select({ id: trips.id, ref: trips.ref, name: trips.name }).from(trips).where(inArray(trips.id, [...new Set(activity.map(a => a.tripId).filter((x): x is string => !!x))].length ? [...new Set(activity.map(a => a.tripId).filter((x): x is string => !!x))] : ['00000000-0000-0000-0000-000000000000']));
  return {
    kpis: {
      runningTrips: Number(kr.running), extendedTrips: Number(kr.extended), runningDepartments: Number(kr.departments),
      claimsReady: Number(kr.ready), oldestReadyAt: kr.oldest_ready, claimsVerifiedUnpaid: Number(kr.verified_unpaid), openQueries: Number(kr.queries), monthSpendPaise: Number(kr.month_spend),
    },
    month: monthStart.slice(0, 7),
    spendByDepartment: byDept.rows,
    running: running.items,
    needsAttention: attention.rows,
    claimsReady: readyClaims,
    activity: activity.map(a => ({ at: a.at, action: a.action, actor: a.actorLabel, tripId: a.tripId, trip: tripNames.find(t => t.id === a.tripId) ?? null, meta: a.meta })),
  };
}
