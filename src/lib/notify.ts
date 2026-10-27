import { and, eq } from 'drizzle-orm';
import { schema } from '../db/client.js';
import type { Ctx } from './context.js';
import { sendPush } from './push.js';
import { emitToUserClient } from './realtime.js';

export interface NotifyInput {
  type: string;
  title: string;
  body: string;
  tripId?: string | null;
  data?: Record<string, unknown>;
  sensitive?: boolean;
  channel?: 'app' | 'web' | 'both';
}

/** Every notification is kept in the in-app list (FR-NOT-01); push and the web socket fire after commit. */
export async function notify(ctx: Ctx, userIds: Array<string | null | undefined>, n: NotifyInput) {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))];
  if (!ids.length) return;
  const rows = await ctx.tx.insert(schema.notifications).values(ids.map(userId => ({
    userId, type: n.type, title: n.title, body: n.body, tripId: n.tripId ?? null, data: n.data ?? {},
    sensitive: n.sensitive ?? false, channel: n.channel ?? 'app', createdAt: ctx.now,
  }))).returning();
  ctx.after.push(async () => {
    for (const r of rows) {
      const dto = notificationDto(r);
      if (r.channel === 'app' || r.channel === 'both') emitToUserClient(r.userId, 'mobile', 'notification', dto);
      if (r.channel === 'web' || r.channel === 'both') emitToUserClient(r.userId, 'web', 'notification', dto);
    }
    await sendPush(rows);
  });
}

/** Finance users see these on the web (claims ready, replies, budget alerts, exports). */
export async function notifyFinance(ctx: Ctx, n: NotifyInput, exceptUserIds: string[] = []) {
  const fin = await ctx.tx.select({ id: schema.users.id }).from(schema.users)
    .where(and(eq(schema.users.isFinance, true), eq(schema.users.active, true)));
  await notify(ctx, fin.map(f => f.id).filter(id => !exceptUserIds.includes(id)), { channel: 'web', ...n });
}

export function notificationDto(r: typeof schema.notifications.$inferSelect) {
  return { id: r.id, type: r.type, title: r.title, body: r.body, tripId: r.tripId, data: r.data, createdAt: r.createdAt, readAt: r.readAt, channel: r.channel };
}
