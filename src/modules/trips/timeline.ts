/** Trip timeline (M06·o, W04·d, FR-START-06): lifecycle events in plain words, filtered for the viewer. */
import { and, asc, eq } from 'drizzle-orm';
import { schema } from '../../db/client.js';
import type { Ctx } from '../../lib/context.js';
import { inr } from '../../lib/money.js';
import { humanDuration, istLabel } from '../../lib/time.js';
import { getTrip, userNames } from '../domain.js';

const { auditLog } = schema;

const PUBLIC = new Set([
  'trip.create', 'trip.update', 'trip.cancel', 'trip.close', 'trip.extended', 'trip.handover', 'trip.owner_assigned',
  'member.invite', 'member.accept', 'member.decline', 'member.withdraw', 'member.start', 'member.auto_start', 'member.end', 'member.resume',
  'member.leave', 'member.remove', 'location.add', 'location.update', 'location.delete',
]);
const OWN_ONLY = new Set([
  'expense.create', 'expense.update', 'expense.delete', 'expense.verify', 'expense.query', 'expense.reject', 'expense.reply', 'expense.dispute', 'expense.message',
  'expense.move', 'expense.budget_source', 'payment.record', 'claim.reopen', 'member.start_ignored', 'member.end_ignored', 'export.request', 'export.ready', 'export.device',
]);

export async function timeline(ctx: Ctx, tripId: string, finance: boolean) {
  const trip = await getTrip(ctx.tx, tripId);
  const rows = await ctx.tx.select().from(auditLog).where(and(eq(auditLog.tripId, tripId))).orderBy(asc(auditLog.at), asc(auditLog.id));
  const uid = ctx.actor.id;
  const visible = rows.filter(r => {
    if (finance) return r.action !== 'budget.alert';
    if (PUBLIC.has(r.action)) return true;
    if (r.action.startsWith('budget.')) return r.memberUserId === null ? r.action !== 'budget.alert' : r.memberUserId === uid && r.action !== 'budget.alert';
    return OWN_ONLY.has(r.action) && r.memberUserId === uid;
  });
  const names = await userNames(ctx.tx, visible.map(r => r.memberUserId).filter((x): x is string => !!x));
  return visible.map(r => {
    const who = r.memberUserId ? names.get(r.memberUserId)?.name ?? '' : '';
    const meta = (r.meta ?? {}) as Record<string, unknown>;
    return { id: r.id, at: r.at, action: r.action, actor: r.actorLabel, memberUserId: r.memberUserId, memberName: who, text: describe(r, who, meta, trip.scheduledStart), meta };
  });
}

function describe(r: typeof auditLog.$inferSelect, who: string, meta: Record<string, unknown>, scheduledStart: Date): string {
  const after = (r.after ?? {}) as Record<string, unknown>;
  const before = (r.before ?? {}) as Record<string, unknown>;
  switch (r.action) {
    case 'trip.create': return `${r.actorLabel} created the trip${meta.enteredAfterStart ? ', entered after it began' : ''}`;
    case 'trip.update': return after.tentativeEnd && before.tentativeEnd && String(after.tentativeEnd) !== String(before.tentativeEnd)
      ? `${r.actorLabel} moved the tentative end to ${istLabel(new Date(String(after.tentativeEnd)))}` : `${r.actorLabel} edited the trip details`;
    case 'trip.cancel': return `${r.actorLabel} cancelled the trip`;
    case 'trip.close': return 'Every member has ended: trip closed';
    case 'trip.extended': return 'Tentative end passed with members still running: trip Extended';
    case 'trip.handover': return `${r.actorLabel} handed the trip to a new owner`;
    case 'trip.owner_assigned': return `${r.actorLabel} (finance) assigned a new owner`;
    case 'member.invite': return `${who} was invited${meta.reinvite ? ' again' : ''}`;
    case 'member.accept': return `${who} accepted`;
    case 'member.decline': return `${who} declined`;
    case 'member.withdraw': return `Request to ${who} withdrawn`;
    case 'member.start': {
      if (meta.keptEarlier) return `${who}'s offline start kept over the automatic start`;
      if (meta.lateJoin) return meta.backdated ? `${who} joined late and recorded starting at the scheduled time (flagged)` : `${who} joined late and started`;
      const early = Number(meta.earlyMinutes ?? 0);
      return early > 0 ? `${who} started ${humanDuration(early * 60000)} early` : `${who} started${meta.offline ? ' (recorded offline)' : ''}`;
    }
    case 'member.auto_start': return `${who} started automatically at ${istLabel(scheduledStart)}`;
    case 'member.end': return meta.method === 'finance' ? `${r.actorLabel} (finance) ended ${who}'s trip: ${meta.reason ?? ''}` : `${who} ended the trip${meta.offline ? ' (recorded offline)' : ''}`;
    case 'member.resume': return `${who} resumed the trip`;
    case 'member.leave': return `${who} left the trip`;
    case 'member.remove': return `${who} was removed from the trip`;
    case 'member.start_ignored': return `${who}'s later offline start ignored; the earlier start stands`;
    case 'member.end_ignored': return `${who}'s End from the phone arrived after finance ended the trip; finance's end stands`;
    case 'location.add': return `${r.actorLabel} added ${String(after.city ?? 'a location')}`;
    case 'location.update': return `${r.actorLabel} changed ${String(after.city ?? 'a location')}`;
    case 'location.delete': return `${r.actorLabel} deleted ${String(before.city ?? 'a location')}`;
    case 'budget.set': return `${r.actorLabel} set the ${r.memberUserId ? 'individual budget' : 'trip pool'} to ${inr(Number(after.amountPaise ?? 0))}`;
    case 'budget.change': return `${r.actorLabel} changed the ${r.memberUserId ? 'individual budget' : 'trip pool'} to ${inr(Number(after.amountPaise ?? 0))}`;
    case 'budget.remove': return `${r.actorLabel} removed the ${r.memberUserId ? 'individual budget' : 'trip pool'}`;
    case 'expense.create': return `${r.actorLabel} logged ${String(after.description ?? 'an expense')}`;
    case 'expense.update': return `${r.actorLabel} edited an expense`;
    case 'expense.delete': return `${r.actorLabel} deleted ${String(before.description ?? 'an expense')}`;
    case 'expense.verify': return `Finance verified an expense${meta.approvedPaise ? ` at ${inr(Number(meta.approvedPaise))}` : ''}`;
    case 'expense.query': return 'Finance asked a question about an expense';
    case 'expense.reject': return 'Finance rejected an expense';
    case 'expense.reply': return `${r.actorLabel} replied to finance`;
    case 'payment.record': return `Finance recorded a payment of ${inr(Number(after.amountPaise ?? 0))}`;
    case 'claim.reopen': return `Finance reopened the claim: ${meta.reason ?? ''}`;
    case 'claim.close': return 'Finance closed the reopened claim';
    case 'expense.dispute': return `${r.actorLabel} asked finance about a decision`;
    case 'expense.message': return `${r.actorLabel} (finance) wrote about an expense`;
    case 'expense.move': return `${r.actorLabel} moved an expense ${before.tripId && after.tripId && r.tripId === before.tripId ? 'to another trip' : 'here from another trip'}`;
    case 'expense.budget_source': return `${r.actorLabel} chose ${after.budgetSource === 'individual' ? 'My budget' : 'the trip pool'} for an expense`;
    case 'expense.remind': return 'Finance asked for a receipt still on the phone';
    case 'budget.apply': return `Earlier expenses were charged to the ${meta.to === 'individual' ? 'individual budget' : 'trip pool'}`;
    case 'document.upload': return `${r.actorLabel} uploaded ${String(meta.name ?? 'a document')}`;
    case 'document.delete': return `${r.actorLabel} deleted a document`;
    case 'attachment.add': return `${r.actorLabel} added ${String(meta.name ?? 'a receipt')}`;
    case 'attachment.delete': return `${r.actorLabel} removed a receipt`;
    case 'finance.handoff': return `${r.actorLabel} asked ${String(meta.toName ?? 'another finance user')} to ${meta.topic === 'claim' ? 'decide their claim' : 'set the budgets'}`;
    case 'export.request': return `${r.actorLabel} asked for an export`;
    case 'export.ready': return 'An export is ready to download';
    case 'export.failed': return `An export failed: ${String(meta.error ?? '')}`;
    case 'export.device': return `${r.actorLabel} exported their claim on the phone`;
    case 'export.retry': return `${r.actorLabel} retried an export`;
    default: return r.action.replace('.', ' ');
  }
}
