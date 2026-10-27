import { schema } from '../db/client.js';
import type { Ctx } from './context.js';

export interface AuditEntry {
  action: string;           // e.g. trip.create, member.start, expense.verify
  entity: string;           // trip | member | location | expense | attachment | budget | payment | export | user | department | claim
  entityId?: string | null;
  tripId?: string | null;
  memberUserId?: string | null; // whose data this is (private items are only shown to that member and finance)
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>;
}

/** NFR-11: every create, edit and delete, lifecycle change, budget change, verification, payment, export and role change. */
export async function audit(ctx: Ctx, e: AuditEntry) {
  await ctx.tx.insert(schema.auditLog).values({
    at: ctx.now,
    actorId: ctx.actor.id,
    actorLabel: ctx.actor.name,
    action: e.action,
    entity: e.entity,
    entityId: e.entityId ?? null,
    tripId: e.tripId ?? null,
    memberUserId: e.memberUserId ?? null,
    before: e.before === undefined ? null : clean(e.before),
    after: e.after === undefined ? null : clean(e.after),
    meta: { client: ctx.actor.client, ...(e.meta ?? {}) },
  });
}

function clean(v: unknown) {
  return JSON.parse(JSON.stringify(v, (k, val) => (k === 'passwordHash' || k === 'tokenHash' ? undefined : val)));
}
