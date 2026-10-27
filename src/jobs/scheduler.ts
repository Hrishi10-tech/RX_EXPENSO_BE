/**
 * Server-side scheduler (NFR-14): automatic starts (FR-START-04), extension and 12-hourly reminders (FR-END-02/03),
 * invite reminders 24 hours before the start (FR-MEM-08). Runs on the server clock, so it works with every phone off.
 * An advisory lock makes sure only one server instance does the work on each tick.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { SYSTEM, withTx, type Ctx } from '../lib/context.js';
import { log } from '../lib/logger.js';
import { notify, notifyFinance } from '../lib/notify.js';
import { tripChanged } from '../lib/realtime.js';
import { config } from '../config.js';
import { sendMail, webUrl } from '../lib/mailer.js';
import { inr } from '../lib/money.js';
import { hours, humanDuration, istDate, istLabel, istTime } from '../lib/time.js';
import { getMembers } from '../modules/domain.js';
import { claimsQueue, tripList } from '../modules/finance/views.js';

const { trips, tripMembers, users, userSettings } = schema;

export async function autoStart(ctx: Ctx) {
  const due = await ctx.tx.select({ m: tripMembers, t: trips }).from(tripMembers).innerJoin(trips, eq(trips.id, tripMembers.tripId))
    .where(and(eq(tripMembers.joinStatus, 'accepted'), isNull(tripMembers.actualStart), sql`${trips.status} in ('scheduled','active','extended')`, sql`${trips.scheduledStart} <= ${ctx.now}`))
    .for('update', { of: tripMembers });
  const touched = new Set<string>();
  for (const { m, t } of due) {
    await ctx.tx.update(tripMembers).set({ actualStart: t.scheduledStart, startMethod: 'automatic', startReceivedAt: ctx.now, updatedAt: ctx.now }).where(eq(tripMembers.id, m.id));
    await audit(ctx, { action: 'member.auto_start', entity: 'member', tripId: t.id, memberUserId: m.userId, after: { actualStart: t.scheduledStart }, meta: { method: 'automatic' } });
    await notify(ctx, [m.userId], { type: 'member.auto_started', tripId: t.id, title: `${t.name} started automatically`, body: `Started at ${istLabel(t.scheduledStart)}, the scheduled start. Log expenses as you go.`, data: { tripId: t.id } });
    touched.add(t.id);
  }
  for (const tripId of touched) {
    const t = (await ctx.tx.select().from(trips).where(eq(trips.id, tripId)))[0];
    if (t.status === 'scheduled') await ctx.tx.update(trips).set({ status: 'active', firstStartAt: t.firstStartAt ?? t.scheduledStart, updatedAt: ctx.now, version: sql`${trips.version} + 1` }).where(eq(trips.id, tripId));
    ctx.after.push(() => tripChanged(tripId, 'auto_start'));
  }
  return due.length;
}

export async function markExtended(ctx: Ctx) {
  const due = await ctx.tx.select().from(trips).where(and(eq(trips.status, 'active'), sql`${trips.tentativeEnd} <= ${ctx.now}`)).for('update');
  let n = 0;
  for (const t of due) {
    const ms = await getMembers(ctx.tx, t.id);
    const running = ms.filter(m => m.joinStatus === 'accepted' && m.actualStart && !m.actualEnd);
    if (!running.length) continue;
    await ctx.tx.update(trips).set({ status: 'extended', extendedAt: ctx.now, updatedAt: ctx.now, version: sql`${trips.version} + 1` }).where(eq(trips.id, t.id));
    await audit(ctx, { action: 'trip.extended', entity: 'trip', entityId: t.id, tripId: t.id, meta: { running: running.length } });
    for (const m of running) {
      await ctx.tx.update(tripMembers).set({ extensionPromptedAt: ctx.now, lastReminderAt: ctx.now }).where(eq(tripMembers.id, m.id));
      await notify(ctx, [m.userId], { type: 'trip.planned_end', tripId: t.id, title: `${t.name}: planned end reached`, body: `The trip was planned to end ${istLabel(t.tentativeEnd)}. End it now, or keep going and we will remind you every 12 hours.`, data: { tripId: t.id } });
    }
    await notifyFinance(ctx, { type: 'trip.extended', tripId: t.id, title: `${t.ref} is extended`, body: `${t.name}: ${running.length} member${running.length > 1 ? 's' : ''} still running past the planned end.`, data: { tripId: t.id } });
    ctx.after.push(() => tripChanged(t.id, 'extended'));
    n++;
  }
  return n;
}

export async function extensionReminders(ctx: Ctx) {
  const due = await ctx.tx.select({ m: tripMembers, t: trips }).from(tripMembers).innerJoin(trips, eq(trips.id, tripMembers.tripId))
    .where(and(eq(trips.status, 'extended'), eq(tripMembers.joinStatus, 'accepted'), sql`${tripMembers.actualStart} is not null and ${tripMembers.actualEnd} is null`,
      sql`coalesce(${tripMembers.lastReminderAt}, ${trips.tentativeEnd}) <= ${new Date(ctx.now.getTime() - hours(12))}`));
  for (const { m, t } of due) {
    await ctx.tx.update(tripMembers).set({ lastReminderAt: ctx.now }).where(eq(tripMembers.id, m.id));
    await notify(ctx, [m.userId], { type: 'trip.extension_reminder', tripId: t.id, title: `Still on ${t.name}?`, body: `${humanDuration(ctx.now.getTime() - t.tentativeEnd.getTime())} past the planned end. End the trip when you are back.`, data: { tripId: t.id } });
    await audit(ctx, { action: 'member.reminded', entity: 'member', tripId: t.id, memberUserId: m.userId });
  }
  return due.length;
}

export async function inviteReminders(ctx: Ctx) {
  const due = await ctx.tx.select({ m: tripMembers, t: trips }).from(tripMembers).innerJoin(trips, eq(trips.id, tripMembers.tripId))
    .where(and(eq(tripMembers.joinStatus, 'invited'), isNull(tripMembers.inviteRemindedAt), eq(trips.status, 'scheduled'),
      sql`${trips.scheduledStart} > ${ctx.now}`, sql`${trips.scheduledStart} <= ${new Date(ctx.now.getTime() + hours(24))}`));
  for (const { m, t } of due) {
    await ctx.tx.update(tripMembers).set({ inviteRemindedAt: ctx.now }).where(eq(tripMembers.id, m.id));
    const owner = (await ctx.tx.select({ name: users.name }).from(users).where(eq(users.id, t.ownerId)))[0];
    await notify(ctx, [m.userId], { type: 'join.reminder', tripId: t.id, title: `Answer ${owner?.name ?? 'the'}'s request`, body: `${t.name} starts ${istLabel(t.scheduledStart)}.`, data: { tripId: t.id } });
  }
  return due.length;
}

/**
 * FR-NOT-05: once a day, from DIGEST_HOUR_IST, finance users who opted in get an email with the claims ready for
 * verification, the Extended trips and (unless they turned it off) the trips over budget.
 */
export async function dailyDigests(ctx: Ctx) {
  if (Number(istTime(ctx.now).slice(0, 2)) < config.DIGEST_HOUR_IST) return 0;
  const today = istDate(ctx.now);
  const due = await ctx.tx.select({ u: users, s: userSettings }).from(userSettings).innerJoin(users, eq(users.id, userSettings.userId))
    .where(and(eq(userSettings.dailyDigest, true), eq(users.isFinance, true), eq(users.active, true),
      sql`(${userSettings.lastDigestOn} is null or ${userSettings.lastDigestOn} < ${today}::date)`))
    .for('update', { of: userSettings });
  if (!due.length) return 0;
  const ready = await claimsQueue(ctx, { status: 'ready' });
  const extended = await tripList(ctx, { status: ['extended'], pageSize: 50 });
  const over = await tripList(ctx, { status: ['active', 'extended', 'closed'], budget: 'over', pageSize: 50 });
  const base = webUrl();
  for (const { u, s } of due) {
    const mine = ready.filter(c => c.userId !== u.id);
    const prefs = (s.notificationPrefs ?? {}) as Record<string, unknown>;
    const lines = [`Good morning ${u.name.split(' ')[0]},`, '', `Expenso for ${istLabel(ctx.now, false)}:`, ''];
    lines.push(`Claims ready for verification: ${mine.length}`);
    for (const c of mine.slice(0, 10)) lines.push(`  · ${c.name}, ${c.tripName} (${c.ref}): ${inr(c.totals.totalPaise)}, waiting ${humanDuration(c.waitingMs)}`);
    lines.push('', `Extended trips: ${extended.items.length}`);
    const f = (t: object, k: string) => String((t as Record<string, unknown>)[k] ?? '');
    for (const t of extended.items.slice(0, 10)) lines.push(`  · ${f(t, 'name')} (${f(t, 'ref')}), owner ${f(t, 'ownerName')}`);
    if (prefs.digestOverBudget !== false) {
      lines.push('', `Trips over budget: ${over.items.length}`);
      for (const t of over.items.slice(0, 10)) {
        const p = t.pool as { allocatedPaise: number; spentPaise: number } | null;
        lines.push(`  · ${f(t, 'name')} (${f(t, 'ref')})${p ? `: ${inr(p.spentPaise)} of ${inr(p.allocatedPaise)}` : ''}`);
      }
    }
    lines.push('', `Open the console: ${base}`, '', 'You get this email because the daily digest is on in your Expenso settings.');
    await ctx.tx.update(userSettings).set({ lastDigestOn: today }).where(eq(userSettings.userId, u.id));
    ctx.after.push(() => sendMail({ to: u.email, subject: `Expenso daily digest: ${mine.length} claim${mine.length === 1 ? '' : 's'} ready, ${extended.items.length} extended`, text: lines.join('\n') }));
  }
  return due.length;
}

export async function runScheduledWork(now = new Date()) {
  return withTx(SYSTEM, async ctx => {
    const lock = await ctx.tx.execute(sql`select pg_try_advisory_xact_lock(724501) as ok`);
    if (!(lock.rows[0] as { ok: boolean }).ok) return { skipped: true };
    const autoStarted = await autoStart(ctx);
    const extended = await markExtended(ctx);
    const reminded = await extensionReminders(ctx);
    const invitesReminded = await inviteReminders(ctx);
    const digests = await dailyDigests(ctx);
    return { autoStarted, extended, reminded, invitesReminded, digests };
  }, now);
}

let timer: NodeJS.Timeout | null = null;
export function startScheduler(intervalSeconds: number) {
  const tick = async () => {
    try {
      const r = await runScheduledWork();
      if ('autoStarted' in r && (r.autoStarted || r.extended || r.reminded || r.invitesReminded || r.digests)) log.info(r, 'scheduler tick');
    } catch (e) { log.error({ err: e }, 'scheduler tick failed'); }
  };
  void tick();
  timer = setInterval(tick, intervalSeconds * 1000);
}
export function stopScheduler() { if (timer) clearInterval(timer); }
