/**
 * Trip lifecycle (SRS §4): create, edit, cancel, invite, respond, start, end, resume, leave, hand over,
 * and the finance-side end and owner assignment. Every change is audited and notifies the right people.
 */
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { schema } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import type { Ctx } from '../../lib/context.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { notify, notifyFinance } from '../../lib/notify.js';
import { tripChanged } from '../../lib/realtime.js';
import { nextTripRef } from '../../lib/refs.js';
import { hours, humanDuration, istDate, istLabel, minutes } from '../../lib/time.js';
import {
  acceptedIds, claimTotals, firstName, getMember, getMembers, getTrip, isAccepted, isRunning, maybeCloseTrip,
  otherAccepted, recomputeClaim, tripIsLive, type Member, type Trip,
} from '../domain.js';

const { trips, tripMembers, locations, expenses, users } = schema;

export const PURPOSES = ['client_meeting', 'conference', 'training', 'audit', 'installation', 'other'] as const;
export const PURPOSE_LABEL: Record<string, string> = {
  client_meeting: 'Client meeting', conference: 'Conference / event', training: 'Training', audit: 'Audit', installation: 'Installation', other: 'Other',
};

export interface TripInput {
  clientId?: string | null;
  name: string;
  type: 'same_day' | 'multi_day';
  purpose: (typeof PURPOSES)[number];
  clientEvent?: string | null;
  scheduledStart: Date;
  tentativeEnd: Date;
  primaryCity: string;
  notes?: string | null;
  inviteeIds?: string[];
  createdOffline?: boolean;
}

/** FR-TRIP-01..03 and FR-TRIP-10: validate times, create the owner as a member, the first location, and invites. */
export async function createTrip(ctx: Ctx, input: TripInput) {
  const me = ctx.actor;
  if (!me.id || !me.departmentId) throw forbidden();
  if (input.clientId) {
    const existing = await ctx.tx.select().from(trips).where(and(eq(trips.ownerId, me.id), eq(trips.clientId, input.clientId)));
    if (existing[0]) return existing[0]; // offline retry: already created
  }
  const errors = validateTimes(input.scheduledStart, input.tentativeEnd, input.type, ctx.now, true);
  if (errors.length) throw badRequest('validation', 'Some fields need attention.', errors);
  const type = istDate(input.scheduledStart) === istDate(input.tentativeEnd) ? input.type : 'multi_day';

  const enteredAfterStart = input.scheduledStart.getTime() <= ctx.now.getTime();
  const ref = await nextTripRef(ctx);
  const [trip] = await ctx.tx.insert(trips).values({
    ref, clientId: input.clientId ?? null, name: input.name.trim(), type, purpose: input.purpose,
    clientEvent: input.clientEvent?.trim() || null, departmentId: me.departmentId, ownerId: me.id,
    scheduledStart: input.scheduledStart, tentativeEnd: input.tentativeEnd, primaryCity: input.primaryCity.trim(),
    notes: input.notes?.trim() || null, status: enteredAfterStart ? 'active' : 'scheduled', enteredAfterStart,
    createdOffline: !!input.createdOffline, firstStartAt: enteredAfterStart ? input.scheduledStart : null,
    createdAt: ctx.now, updatedAt: ctx.now,
  }).returning();
  await ctx.tx.insert(tripMembers).values({
    tripId: trip.id, userId: me.id, role: 'owner', joinStatus: 'accepted', invitedBy: me.id, invitedAt: ctx.now, respondedAt: ctx.now,
    // FR-TRIP-10: a trip entered after it began starts the owner at the scheduled start.
    ...(enteredAfterStart ? { actualStart: input.scheduledStart, startMethod: 'manual' as const, startReceivedAt: ctx.now } : {}),
  });
  await ctx.tx.insert(locations).values({
    tripId: trip.id, city: trip.primaryCity, arrivalDate: istDate(trip.scheduledStart), departureDate: istDate(trip.tentativeEnd),
    isPrimary: true, addedBy: me.id, createdAt: ctx.now, updatedAt: ctx.now,
  });
  await audit(ctx, { action: 'trip.create', entity: 'trip', entityId: trip.id, tripId: trip.id, after: trip, meta: { enteredAfterStart } });
  if (enteredAfterStart) await audit(ctx, { action: 'member.start', entity: 'member', tripId: trip.id, memberUserId: me.id, meta: { method: 'manual', enteredAfterStart: true, at: input.scheduledStart } });
  if (input.inviteeIds?.length) await invite(ctx, trip.id, input.inviteeIds);
  ctx.after.push(() => tripChanged(trip.id, 'created'));
  return trip;
}

function validateTimes(start: Date, end: Date, type: string, now: Date, creating: boolean) {
  const errs: Array<{ field: string; message: string }> = [];
  if (!(end.getTime() > start.getTime())) errs.push({ field: 'tentativeEnd', message: 'The end must be later than the start.' });
  if (type === 'same_day' && istDate(start) !== istDate(end)) errs.push({ field: 'tentativeEnd', message: 'A same-day trip ends on its start date.' });
  if (creating && start.getTime() < now.getTime() - hours(24)) errs.push({ field: 'scheduledStart', message: 'A trip can start at most 24 hours before you save it.' });
  if (creating && end.getTime() <= now.getTime()) errs.push({ field: 'tentativeEnd', message: 'The end must be in the future.' });
  return errs;
}

export interface TripPatch {
  name?: string; purpose?: TripInput['purpose']; clientEvent?: string | null; notes?: string | null; primaryCity?: string;
  type?: 'same_day' | 'multi_day'; scheduledStart?: Date; tentativeEnd?: Date;
}

/** FR-TRIP-04: owner edits; start movable only before anyone starts; end not before now or a location's departure. */
export async function updateTrip(ctx: Ctx, tripId: string, patch: TripPatch) {
  const trip = await getTrip(ctx.tx, tripId, true);
  if (trip.ownerId !== ctx.actor.id) throw forbidden('Only the trip owner can edit the trip.', 'owner_only');
  if (!tripIsLive(trip)) throw conflict('trip_not_editable', 'This trip can no longer be edited.');
  const ms = await getMembers(ctx.tx, tripId);
  const start = patch.scheduledStart ?? trip.scheduledStart;
  const end = patch.tentativeEnd ?? trip.tentativeEnd;
  const errs: Array<{ field: string; message: string; locations?: string[] }> = [];
  const startMoved = patch.scheduledStart && patch.scheduledStart.getTime() !== trip.scheduledStart.getTime();
  const endMoved = patch.tentativeEnd && patch.tentativeEnd.getTime() !== trip.tentativeEnd.getTime();
  if (startMoved && ms.some(m => m.actualStart)) errs.push({ field: 'scheduledStart', message: 'The start is locked because a member has started.' });
  if (startMoved && start.getTime() < ctx.now.getTime() - minutes(1)) errs.push({ field: 'scheduledStart', message: 'The start cannot move into the past.' });
  if (!(end.getTime() > start.getTime())) errs.push({ field: 'tentativeEnd', message: 'The end must be later than the start.' });
  if (endMoved && end.getTime() < ctx.now.getTime()) errs.push({ field: 'tentativeEnd', message: 'The end cannot move earlier than now.' });
  if (endMoved) {
    const late = await ctx.tx.select({ city: locations.city, dep: locations.departureDate }).from(locations)
      .where(and(eq(locations.tripId, tripId), isNull(locations.deletedAt), sql`${locations.departureDate} > ${istDate(end)}`));
    if (late.length) errs.push({ field: 'tentativeEnd', message: `Ends before ${late.map(l => l.city).join(', ')} ${late.length > 1 ? 'end' : 'ends'}. Change those dates first.`, locations: late.map(l => l.city) });
  }
  let type = patch.type ?? trip.type;
  if (istDate(start) !== istDate(end)) type = 'multi_day'; // FR-TRIP-02
  if (type === 'same_day' && istDate(start) !== istDate(end)) errs.push({ field: 'tentativeEnd', message: 'A same-day trip ends on its start date.' });
  if (errs.length) throw badRequest('validation', 'Some fields need attention.', errs);

  const next: Partial<Trip> = {
    name: patch.name?.trim() ?? trip.name, purpose: patch.purpose ?? trip.purpose,
    clientEvent: patch.clientEvent === undefined ? trip.clientEvent : patch.clientEvent?.trim() || null,
    notes: patch.notes === undefined ? trip.notes : patch.notes?.trim() || null,
    primaryCity: patch.primaryCity?.trim() ?? trip.primaryCity, type, scheduledStart: start, tentativeEnd: end,
  };
  // Moving the end later than now returns an Extended trip to Active.
  if (trip.status === 'extended' && end.getTime() > ctx.now.getTime()) next.status = 'active';
  const [updated] = await ctx.tx.update(trips).set({ ...next, updatedAt: ctx.now, version: sql`${trips.version} + 1` }).where(eq(trips.id, tripId)).returning();
  await audit(ctx, { action: 'trip.update', entity: 'trip', entityId: tripId, tripId, before: pick(trip, Object.keys(next)), after: pick(updated, Object.keys(next)) });
  if (startMoved || endMoved) {
    const who = ms.filter(m => m.userId !== ctx.actor.id && (m.joinStatus === 'accepted' || m.joinStatus === 'invited')).map(m => m.userId);
    await notify(ctx, who, {
      type: 'trip.dates_changed', tripId, title: `${trip.name}: dates changed`,
      body: `Now ${istLabel(start)} to ${istLabel(end)}.`, data: { tripId },
    });
  }
  ctx.after.push(() => tripChanged(tripId, 'updated'));
  return updated;
}

function pick<T extends object>(o: T, keys: string[]) {
  return Object.fromEntries(keys.map(k => [k, (o as Record<string, unknown>)[k]]));
}

/** FR-TRIP-07: cancel while Scheduled, or once started only if nobody has logged an expense. */
export async function cancelTrip(ctx: Ctx, tripId: string, reason?: string | null) {
  const trip = await getTrip(ctx.tx, tripId, true);
  if (trip.ownerId !== ctx.actor.id) throw forbidden('Only the trip owner can cancel the trip.', 'owner_only');
  if (!tripIsLive(trip)) throw conflict('trip_not_live', 'This trip is already closed or cancelled.');
  if (trip.status !== 'scheduled') {
    const n = await ctx.tx.select({ c: sql<number>`count(*)` }).from(expenses).where(and(eq(expenses.tripId, tripId), isNull(expenses.deletedAt)));
    if (Number(n[0].c) > 0) throw conflict('has_expenses', 'The trip has expenses, so it can no longer be cancelled. End it instead.');
  }
  const ms = await getMembers(ctx.tx, tripId);
  await ctx.tx.update(trips).set({ status: 'cancelled', cancelledAt: ctx.now, cancelledBy: ctx.actor.id, cancelReason: reason ?? null, updatedAt: ctx.now, version: sql`${trips.version} + 1` }).where(eq(trips.id, tripId));
  await ctx.tx.update(tripMembers).set({ joinStatus: 'withdrawn', updatedAt: ctx.now }).where(and(eq(tripMembers.tripId, tripId), eq(tripMembers.joinStatus, 'invited')));
  // Anyone running stops now; claims holding pre-trip bookings go to finance.
  for (const m of ms.filter(isAccepted)) {
    if (m.actualStart && !m.actualEnd) {
      await ctx.tx.update(tripMembers).set({ actualEnd: ctx.now, endMethod: 'member', endReason: 'Trip cancelled', endedBy: ctx.actor.id, endReceivedAt: ctx.now, updatedAt: ctx.now }).where(eq(tripMembers.id, m.id));
    } else if (!m.actualStart) {
      await ctx.tx.update(tripMembers).set({ actualEnd: ctx.now, endReason: 'Trip cancelled', updatedAt: ctx.now }).where(eq(tripMembers.id, m.id));
    }
    await recomputeClaim(ctx, tripId, m.userId);
  }
  await audit(ctx, { action: 'trip.cancel', entity: 'trip', entityId: tripId, tripId, before: { status: trip.status }, after: { status: 'cancelled', reason } });
  await notify(ctx, ms.filter(m => m.userId !== ctx.actor.id && (m.joinStatus === 'accepted' || m.joinStatus === 'invited')).map(m => m.userId), {
    type: 'trip.cancelled', tripId, title: `${trip.name} was cancelled`, body: `${firstName(ctx.actor.name)} cancelled the trip.${reason ? ' ' + reason : ''}`, data: { tripId },
  });
  ctx.after.push(() => tripChanged(tripId, 'cancelled'));
}

/** FR-MEM-01: active colleagues of the trip's department who have signed in to the app at least once. */
export async function candidates(ctx: Ctx, tripId: string, q?: string) {
  const trip = await getTrip(ctx.tx, tripId);
  const ms = await getMembers(ctx.tx, tripId);
  const rows = await ctx.tx.select({ id: users.id, name: users.name, code: users.employeeCode, first: users.firstMobileLoginAt }).from(users)
    .where(and(eq(users.departmentId, trip.departmentId), eq(users.active, true)))
    .orderBy(users.name);
  const byUser = new Map(ms.map(m => [m.userId, m]));
  const needle = q?.trim().toLowerCase();
  return rows.filter(r => r.id !== trip.ownerId && (!needle || r.name.toLowerCase().includes(needle))).map(r => {
    const m = byUser.get(r.id);
    return { userId: r.id, name: r.name, employeeCode: r.code, signedIn: !!r.first, status: m ? m.joinStatus : null, selectable: !!r.first && (!m || ['declined', 'withdrawn', 'expired'].includes(m.joinStatus)) };
  });
}

/** FR-MEM-02/04: invite colleagues until the trip closes; declined colleagues may be invited again. */
export async function invite(ctx: Ctx, tripId: string, userIds: string[]) {
  const trip = await getTrip(ctx.tx, tripId, true);
  if (trip.ownerId !== ctx.actor.id) throw forbidden('Only the trip owner can invite.', 'owner_only');
  if (!tripIsLive(trip)) throw conflict('trip_not_live', 'Invitations close when the trip closes.');
  const ids = [...new Set(userIds)].filter(id => id !== ctx.actor.id);
  if (!ids.length) return [];
  const people = await ctx.tx.select().from(users).where(inArray(users.id, ids));
  const bad = ids.filter(id => {
    const u = people.find(p => p.id === id);
    return !u || !u.active || u.departmentId !== trip.departmentId || !u.firstMobileLoginAt;
  });
  if (bad.length) throw unprocessable('not_invitable', 'Only active colleagues from the trip’s department who have signed in can be invited.', { userIds: bad });
  const existing = await getMembers(ctx.tx, tripId);
  const invited: string[] = [];
  for (const id of ids) {
    const m = existing.find(x => x.userId === id);
    if (m && (m.joinStatus === 'accepted' || m.joinStatus === 'invited')) continue;
    if (m) {
      await ctx.tx.update(tripMembers).set({ joinStatus: 'invited', invitedBy: ctx.actor.id, invitedAt: ctx.now, respondedAt: null, inviteRemindedAt: null, actualStart: null, startMethod: null, actualEnd: null, endMethod: null, leftAt: null, claimStatus: 'open', updatedAt: ctx.now }).where(eq(tripMembers.id, m.id));
    } else {
      await ctx.tx.insert(tripMembers).values({ tripId, userId: id, role: 'member', joinStatus: 'invited', invitedBy: ctx.actor.id, invitedAt: ctx.now });
    }
    invited.push(id);
    await audit(ctx, { action: 'member.invite', entity: 'member', tripId, memberUserId: id, meta: { reinvite: !!m } });
  }
  await notify(ctx, invited, {
    type: 'join.request', tripId, title: `${firstName(ctx.actor.name)} invited you to ${trip.name}`,
    body: `${istLabel(trip.scheduledStart)} to ${istLabel(trip.tentativeEnd)} · ${trip.primaryCity}`, data: { tripId },
  });
  ctx.after.push(() => tripChanged(tripId, 'members'));
  return invited;
}

export async function withdrawInvite(ctx: Ctx, tripId: string, userId: string) {
  const trip = await getTrip(ctx.tx, tripId, true);
  if (trip.ownerId !== ctx.actor.id) throw forbidden('Only the trip owner can withdraw a request.', 'owner_only');
  const m = await getMember(ctx.tx, tripId, userId, true);
  if (!m || m.joinStatus !== 'invited') throw conflict('not_pending', 'There is no pending request to withdraw.');
  await ctx.tx.update(tripMembers).set({ joinStatus: 'withdrawn', respondedAt: ctx.now, updatedAt: ctx.now }).where(eq(tripMembers.id, m.id));
  await audit(ctx, { action: 'member.withdraw', entity: 'member', tripId, memberUserId: userId });
  ctx.after.push(() => tripChanged(tripId, 'members'));
}

/** Trips of this employee that overlap the given window (FR-MEM-09 warning). */
export async function overlappingTrips(ctx: Ctx, userId: string, trip: Trip) {
  const rows = await ctx.tx.select({ id: trips.id, ref: trips.ref, name: trips.name, scheduledStart: trips.scheduledStart, tentativeEnd: trips.tentativeEnd, status: trips.status })
    .from(trips).innerJoin(tripMembers, eq(tripMembers.tripId, trips.id))
    .where(and(eq(tripMembers.userId, userId), eq(tripMembers.joinStatus, 'accepted'), inArray(trips.status, ['scheduled', 'active', 'extended']),
      sql`${trips.id} <> ${trip.id}`, sql`${trips.scheduledStart} < ${trip.tentativeEnd}`, sql`${trips.tentativeEnd} > ${trip.scheduledStart}`));
  return rows;
}

/** FR-MEM-03, FR-START-05: accept or decline; accepting after the scheduled start asks when the member started. */
export async function respond(ctx: Ctx, tripId: string, accept: boolean, startChoice?: 'scheduled' | 'now', deviceTime?: Date) {
  const trip = await getTrip(ctx.tx, tripId, true);
  const m = await getMember(ctx.tx, tripId, ctx.actor.id!, true);
  if (!m || m.joinStatus !== 'invited') {
    throw conflict('request_closed', m?.joinStatus === 'withdrawn' ? 'The owner withdrew this request.' : m?.joinStatus === 'expired' ? 'This request expired when the trip closed.' : 'This request is no longer open.', { status: m?.joinStatus ?? null, tripStatus: trip.status });
  }
  if (!tripIsLive(trip)) throw conflict('request_closed', trip.status === 'cancelled' ? 'The trip was cancelled.' : 'The trip has closed.', { tripStatus: trip.status });
  const owner = trip.ownerId;
  if (!accept) {
    await ctx.tx.update(tripMembers).set({ joinStatus: 'declined', respondedAt: ctx.now, updatedAt: ctx.now }).where(eq(tripMembers.id, m.id));
    await audit(ctx, { action: 'member.decline', entity: 'member', tripId, memberUserId: m.userId });
    await notify(ctx, [owner], { type: 'join.declined', tripId, title: `${firstName(ctx.actor.name)} declined ${trip.name}`, body: 'You can invite them again from the trip.', data: { tripId } });
    ctx.after.push(() => tripChanged(tripId, 'members'));
    return { status: 'declined' as const };
  }
  const started = ctx.now.getTime() >= trip.scheduledStart.getTime();
  if (started && !startChoice) throw badRequest('start_choice_required', 'The trip is already running. Say whether you started at the scheduled time or are starting now.', { scheduledStart: trip.scheduledStart });
  const patch: Partial<Member> = { joinStatus: 'accepted', respondedAt: ctx.now, updatedAt: ctx.now };
  if (started) {
    const at = startChoice === 'scheduled' ? trip.scheduledStart : (deviceTime ?? ctx.now);
    Object.assign(patch, { actualStart: at, startMethod: 'manual', startDeviceTime: deviceTime ?? null, startReceivedAt: ctx.now, startBackdated: startChoice === 'scheduled' });
  }
  await ctx.tx.update(tripMembers).set(patch).where(eq(tripMembers.id, m.id));
  if (started && trip.status === 'scheduled') await ctx.tx.update(trips).set({ status: 'active', firstStartAt: trip.firstStartAt ?? patch.actualStart!, updatedAt: ctx.now }).where(eq(trips.id, tripId));
  await audit(ctx, { action: 'member.accept', entity: 'member', tripId, memberUserId: m.userId, meta: { startChoice: startChoice ?? null } });
  if (started) await audit(ctx, { action: 'member.start', entity: 'member', tripId, memberUserId: m.userId, meta: { method: 'manual', lateJoin: true, backdated: startChoice === 'scheduled', at: patch.actualStart } });
  const ms = await getMembers(ctx.tx, tripId);
  await notify(ctx, [owner], { type: 'join.accepted', tripId, title: `${firstName(ctx.actor.name)} joined ${trip.name}`, body: started ? `Started ${startChoice === 'scheduled' ? 'at the scheduled time' : 'now'}.` : 'They will start with the trip.', data: { tripId } });
  if (started) await notify(ctx, otherAccepted(ms, m.userId).filter(id => id !== owner), { type: 'member.joined', tripId, title: `${firstName(ctx.actor.name)} joined ${trip.name}`, body: 'Joined part-way through the trip.', data: { tripId } });
  ctx.after.push(() => tripChanged(tripId, 'members'));
  return { status: 'accepted' as const, started };
}

/** FR-START-01..03, FR-START-07: manual start (possibly offline, with device time); early starts tell the others. */
export async function startTrip(ctx: Ctx, tripId: string, deviceTime?: Date) {
  const trip = await getTrip(ctx.tx, tripId, true);
  const m = await getMember(ctx.tx, tripId, ctx.actor.id!, true);
  if (!isAccepted(m)) throw forbidden('You are not a member of this trip.', 'not_member');
  if (!tripIsLive(trip)) throw conflict('trip_not_live', 'This trip is closed or cancelled.');
  const at = deviceTime && deviceTime.getTime() <= ctx.now.getTime() + minutes(2) ? deviceTime : ctx.now;
  if (m!.actualStart) {
    // An offline start that reaches the server after the automatic start keeps the earlier time (FR-START-07).
    if (m!.startMethod === 'automatic' && deviceTime && at.getTime() < m!.actualStart.getTime()) {
      await ctx.tx.update(tripMembers).set({ actualStart: at, startMethod: 'manual', startDeviceTime: deviceTime, startReceivedAt: ctx.now, updatedAt: ctx.now }).where(eq(tripMembers.id, m!.id));
      await audit(ctx, { action: 'member.start', entity: 'member', tripId, memberUserId: m!.userId, before: { actualStart: m!.actualStart, method: 'automatic' }, after: { actualStart: at, method: 'manual' }, meta: { offline: true, keptEarlier: true } });
      ctx.after.push(() => tripChanged(tripId, 'members'));
      return { alreadyStarted: true, actualStart: at };
    }
    if (deviceTime) await audit(ctx, { action: 'member.start_ignored', entity: 'member', tripId, memberUserId: m!.userId, meta: { deviceTime, kept: m!.actualStart } });
    return { alreadyStarted: true, actualStart: m!.actualStart };
  }
  await ctx.tx.update(tripMembers).set({ actualStart: at, startMethod: 'manual', startDeviceTime: deviceTime ?? null, startReceivedAt: ctx.now, updatedAt: ctx.now }).where(eq(tripMembers.id, m!.id));
  if (trip.status === 'scheduled') await ctx.tx.update(trips).set({ status: 'active', firstStartAt: at, updatedAt: ctx.now, version: sql`${trips.version} + 1` }).where(eq(trips.id, tripId));
  else if (!trip.firstStartAt || at < trip.firstStartAt) await ctx.tx.update(trips).set({ firstStartAt: at, updatedAt: ctx.now }).where(eq(trips.id, tripId));
  const earlyMs = trip.scheduledStart.getTime() - at.getTime();
  await audit(ctx, { action: 'member.start', entity: 'member', tripId, memberUserId: m!.userId, after: { actualStart: at }, meta: { method: 'manual', earlyMinutes: earlyMs > 0 ? Math.round(earlyMs / 60000) : 0, offline: !!deviceTime } });
  if (earlyMs > 0) {
    const ms = await getMembers(ctx.tx, tripId);
    await notify(ctx, otherAccepted(ms, m!.userId), {
      type: 'member.started_early', tripId, title: `${firstName(ctx.actor.name)} has started ${trip.name}`,
      body: `${ctx.actor.name} has started ${trip.name} at ${istLabel(at)}, ${humanDuration(earlyMs)} before the scheduled start.`, data: { tripId },
    });
  }
  ctx.after.push(() => tripChanged(tripId, 'started', { userId: m!.userId }));
  return { alreadyStarted: false, actualStart: at, earlyMinutes: earlyMs > 0 ? Math.round(earlyMs / 60000) : 0 };
}

async function finishEnd(ctx: Ctx, trip: Trip, m: Member, byFinance: boolean) {
  const claim = await recomputeClaim(ctx, trip.id, m.userId);
  const closed = await maybeCloseTrip(ctx, trip.id);
  const totals = await claimTotals(ctx.tx, trip.id, m.userId);
  const who = (await ctx.tx.select({ name: users.name }).from(users).where(eq(users.id, m.userId)))[0]?.name ?? 'A member';
  if (!byFinance && m.userId !== trip.ownerId) {
    await notify(ctx, [trip.ownerId], { type: 'member.ended', tripId: trip.id, title: `${firstName(who)} ended ${trip.name}`, body: closed ? 'Everyone has ended; the trip is closed.' : 'Their claim went to finance.', data: { tripId: trip.id } });
  }
  if (totals.count > 0) {
    await notifyFinance(ctx, { type: 'claim.ready', tripId: trip.id, title: `${who}'s claim is ready`, body: `${trip.ref} · ${trip.name} · ${totals.count} expenses`, data: { tripId: trip.id, userId: m.userId } }, [m.userId]);
  }
  if (closed) {
    const ms = await getMembers(ctx.tx, trip.id);
    await notify(ctx, acceptedIds(ms), { type: 'trip.closed', tripId: trip.id, title: `${trip.name} is closed`, body: 'Everyone has ended the trip. Finance is verifying the claims.', data: { tripId: trip.id } });
    await audit(ctx, { action: 'trip.close', entity: 'trip', entityId: trip.id, tripId: trip.id });
  }
  ctx.after.push(() => tripChanged(trip.id, closed ? 'closed' : 'ended', { userId: m.userId }));
  return { claim, closed };
}

/** FR-END-01/07: a member ends their own trip; a device End arriving after finance ended it is kept only in the audit log. */
export async function endTrip(ctx: Ctx, tripId: string, deviceTime?: Date) {
  const trip = await getTrip(ctx.tx, tripId, true);
  const m = await getMember(ctx.tx, tripId, ctx.actor.id!, true);
  if (!isAccepted(m)) throw forbidden('You are not a member of this trip.', 'not_member');
  if (!m!.actualStart) throw conflict('not_started', 'Start the trip before ending it.');
  if (m!.actualEnd) {
    if (m!.endMethod === 'finance') {
      await audit(ctx, { action: 'member.end_ignored', entity: 'member', tripId, memberUserId: m!.userId, meta: { deviceTime: deviceTime ?? ctx.now, keptFinanceEnd: m!.actualEnd } });
      return { alreadyEnded: true, endedByFinance: true, actualEnd: m!.actualEnd };
    }
    return { alreadyEnded: true, endedByFinance: false, actualEnd: m!.actualEnd };
  }
  let at = deviceTime && deviceTime.getTime() <= ctx.now.getTime() + minutes(2) ? deviceTime : ctx.now;
  if (at < m!.actualStart) at = m!.actualStart;
  await ctx.tx.update(tripMembers).set({ actualEnd: at, endMethod: 'member', endedBy: m!.userId, endDeviceTime: deviceTime ?? null, endReceivedAt: ctx.now, updatedAt: ctx.now }).where(eq(tripMembers.id, m!.id));
  await audit(ctx, { action: 'member.end', entity: 'member', tripId, memberUserId: m!.userId, after: { actualEnd: at }, meta: { method: 'member', offline: !!deviceTime } });
  const r = await finishEnd(ctx, trip, { ...m!, actualEnd: at }, false);
  return { alreadyEnded: false, endedByFinance: false, actualEnd: at, resumeUntil: new Date(at.getTime() + minutes(30)), ...r };
}

/** FR-END-09: resume within 30 minutes if finance has not acted on the claim since the end. */
export async function resumeTrip(ctx: Ctx, tripId: string) {
  const trip = await getTrip(ctx.tx, tripId, true);
  const m = await getMember(ctx.tx, tripId, ctx.actor.id!, true);
  if (!isAccepted(m) || !m!.actualEnd) throw conflict('not_ended', 'You have not ended this trip.');
  if (m!.endMethod === 'finance') throw conflict('ended_by_finance', 'Finance ended this trip for you. Ask finance to change it.');
  if (ctx.now.getTime() - m!.actualEnd.getTime() > minutes(30)) throw conflict('resume_window_passed', 'Resuming is possible only within 30 minutes of ending.');
  if (trip.status === 'cancelled') throw conflict('trip_not_live', 'This trip was cancelled.');
  const acted = await ctx.tx.select({ c: sql<number>`count(*)` }).from(expenses).where(and(eq(expenses.tripId, tripId), eq(expenses.userId, m!.userId), isNotNull(expenses.verifiedAt), sql`${expenses.verifiedAt} > ${m!.actualEnd}`));
  if (Number(acted[0].c) > 0) throw conflict('finance_acted', 'Finance has already started on your claim, so the trip cannot be resumed.');
  await ctx.tx.update(tripMembers).set({ actualEnd: null, endMethod: null, endedBy: null, endDeviceTime: null, endReceivedAt: null, updatedAt: ctx.now }).where(eq(tripMembers.id, m!.id));
  if (trip.status === 'closed') {
    await ctx.tx.update(trips).set({ status: trip.tentativeEnd.getTime() > ctx.now.getTime() ? 'active' : 'extended', closedAt: null, updatedAt: ctx.now, version: sql`${trips.version} + 1` }).where(eq(trips.id, tripId));
  }
  await recomputeClaim(ctx, tripId, m!.userId);
  await audit(ctx, { action: 'member.resume', entity: 'member', tripId, memberUserId: m!.userId, before: { actualEnd: m!.actualEnd }, meta: { reopenedTrip: trip.status === 'closed' } });
  ctx.after.push(() => tripChanged(tripId, 'resumed', { userId: m!.userId }));
}

/** FR-MEM-06: a member without expenses may leave; the owner cannot leave. */
export async function leaveTrip(ctx: Ctx, tripId: string) {
  return removeMemberInternal(ctx, tripId, ctx.actor.id!, true);
}
export async function removeMember(ctx: Ctx, tripId: string, userId: string) {
  const trip = await getTrip(ctx.tx, tripId, true);
  if (trip.ownerId !== ctx.actor.id) throw forbidden('Only the trip owner can remove a member.', 'owner_only');
  return removeMemberInternal(ctx, tripId, userId, false);
}
async function removeMemberInternal(ctx: Ctx, tripId: string, userId: string, self: boolean) {
  const trip = await getTrip(ctx.tx, tripId, true);
  if (trip.ownerId === userId) throw conflict('owner_cannot_leave', 'The owner cannot leave. Hand the trip to another member first.');
  const m = await getMember(ctx.tx, tripId, userId, true);
  if (!isAccepted(m)) throw notFound('Member');
  const n = await ctx.tx.select({ c: sql<number>`count(*)` }).from(expenses).where(and(eq(expenses.tripId, tripId), eq(expenses.userId, userId), isNull(expenses.deletedAt)));
  if (Number(n[0].c) > 0) throw conflict('has_expenses', 'Members with expenses stay on the trip so their claim stays with it.');
  await ctx.tx.update(tripMembers).set({ joinStatus: 'withdrawn', leftAt: ctx.now, updatedAt: ctx.now }).where(eq(tripMembers.id, m!.id));
  await audit(ctx, { action: self ? 'member.leave' : 'member.remove', entity: 'member', tripId, memberUserId: userId });
  if (self) await notify(ctx, [trip.ownerId], { type: 'member.left', tripId, title: `${firstName(ctx.actor.name)} left ${trip.name}`, body: 'They had no expenses on the trip.', data: { tripId } });
  else await notify(ctx, [userId], { type: 'member.removed', tripId, title: `You were removed from ${trip.name}`, body: `${firstName(ctx.actor.name)} removed you. You had no expenses on it.`, data: { tripId } });
  await maybeCloseTrip(ctx, tripId);
  ctx.after.push(() => tripChanged(tripId, 'members'));
}

/** FR-MEM-10: the owner hands the trip to another accepted member. */
export async function handOver(ctx: Ctx, tripId: string, newOwnerId: string, byFinance = false) {
  const trip = await getTrip(ctx.tx, tripId, true);
  if (!byFinance && trip.ownerId !== ctx.actor.id) throw forbidden('Only the trip owner can hand over the trip.', 'owner_only');
  if (!tripIsLive(trip)) throw conflict('trip_not_live', 'This trip is closed or cancelled.');
  const nm = await getMember(ctx.tx, tripId, newOwnerId, true);
  if (!isAccepted(nm)) throw unprocessable('not_member', 'Only a member who accepted can own the trip.');
  const newOwner = (await ctx.tx.select().from(users).where(eq(users.id, newOwnerId)))[0];
  if (!newOwner?.active) throw unprocessable('inactive', 'That person’s account is not active.');
  await ctx.tx.update(tripMembers).set({ role: 'member', updatedAt: ctx.now }).where(and(eq(tripMembers.tripId, tripId), eq(tripMembers.userId, trip.ownerId)));
  await ctx.tx.update(tripMembers).set({ role: 'owner', updatedAt: ctx.now }).where(eq(tripMembers.id, nm!.id));
  await ctx.tx.update(trips).set({ ownerId: newOwnerId, updatedAt: ctx.now, version: sql`${trips.version} + 1` }).where(eq(trips.id, tripId));
  await audit(ctx, { action: byFinance ? 'trip.owner_assigned' : 'trip.handover', entity: 'trip', entityId: tripId, tripId, before: { ownerId: trip.ownerId }, after: { ownerId: newOwnerId } });
  await notify(ctx, [newOwnerId], { type: 'trip.owner', tripId, title: `You now own ${trip.name}`, body: byFinance ? 'Finance made you the owner because the previous owner’s account was deactivated.' : `${firstName(ctx.actor.name)} handed the trip to you.`, data: { tripId } });
  ctx.after.push(() => tripChanged(tripId, 'owner'));
}

/** FR-END-05: finance ends a running member's trip with the real end time and a reason. */
export async function financeEndMember(ctx: Ctx, tripId: string, userId: string, endAt: Date, reason: string) {
  const trip = await getTrip(ctx.tx, tripId, true);
  const m = await getMember(ctx.tx, tripId, userId, true);
  if (!isRunning(m)) throw conflict('not_running', 'This member is not running the trip.');
  if (endAt.getTime() > ctx.now.getTime() + minutes(1)) throw badRequest('validation', 'The end cannot be in the future.', [{ field: 'endAt', message: 'The end cannot be in the future.' }]);
  if (endAt.getTime() < m!.actualStart!.getTime()) throw badRequest('validation', 'The end cannot be before their start.', [{ field: 'endAt', message: `Their start was ${istLabel(m!.actualStart!)}.` }]);
  await ctx.tx.update(tripMembers).set({ actualEnd: endAt, endMethod: 'finance', endReason: reason, endedBy: ctx.actor.id, endReceivedAt: ctx.now, updatedAt: ctx.now }).where(eq(tripMembers.id, m!.id));
  await audit(ctx, { action: 'member.end', entity: 'member', tripId, memberUserId: userId, after: { actualEnd: endAt }, meta: { method: 'finance', reason } });
  await notify(ctx, [userId, trip.ownerId], {
    type: 'member.ended_by_finance', tripId, title: `Finance ended ${userId === trip.ownerId ? 'your' : 'a member’s'} trip on ${trip.name}`,
    body: `${firstName(ctx.actor.name)} ended it at ${istLabel(endAt)}: ${reason}`, data: { tripId, userId },
  });
  return finishEnd(ctx, trip, { ...m!, actualEnd: endAt }, true);
}

export async function tripOwnerCheck(ctx: Ctx, tripId: string) {
  const trip = await getTrip(ctx.tx, tripId);
  if (trip.ownerId !== ctx.actor.id) throw forbidden('Only the trip owner can do this.', 'owner_only');
  return trip;
}

export { isRunning };
