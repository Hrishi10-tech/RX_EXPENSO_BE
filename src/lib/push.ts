import { eq, inArray } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/client.js';
import { log } from './logger.js';

type NotificationRow = typeof schema.notifications.$inferSelect;

/**
 * Push through FCM (Android and, via APNs, iOS) when a Firebase service account is configured (FR-NOT-01).
 * Individual-budget notifications never show amounts on the lock screen (FR-NOT-03).
 */
let messagingP: Promise<{ sendEachForMulticast: (m: unknown) => Promise<unknown> } | null> | null = null;
function messaging() {
  if (!config.FCM_SERVICE_ACCOUNT) return Promise.resolve(null);
  messagingP ??= (async () => {
    try {
      const mod = 'firebase-admin';
      const admin = (await import(mod)).default;
      const fs = await import('node:fs/promises');
      const cred = JSON.parse(await fs.readFile(config.FCM_SERVICE_ACCOUNT!, 'utf8'));
      const app = admin.initializeApp({ credential: admin.credential.cert(cred) });
      return admin.messaging(app);
    } catch (e) {
      log.warn({ err: e }, 'push disabled: install firebase-admin and set FCM_SERVICE_ACCOUNT');
      return null;
    }
  })();
  return messagingP;
}

export async function sendPush(rows: NotificationRow[]) {
  const m = await messaging();
  if (!m || !rows.length) return;
  const userIds = [...new Set(rows.map(r => r.userId))];
  const tokens = await db.select().from(schema.deviceTokens).where(inArray(schema.deviceTokens.userId, userIds));
  for (const r of rows) {
    const t = tokens.filter(x => x.userId === r.userId && x.platform !== 'web').map(x => x.token);
    if (!t.length || r.channel === 'web') continue;
    await m.sendEachForMulticast({
      tokens: t,
      notification: { title: r.title, body: r.sensitive ? 'Open Expenso to see the details.' : r.body },
      data: { notificationId: r.id, type: r.type, tripId: r.tripId ?? '', ...Object.fromEntries(Object.entries(r.data as Record<string, unknown>).map(([k, v]) => [k, String(v)])) },
    }).catch(e => log.warn({ err: e }, 'push failed'));
    await db.update(schema.notifications).set({ pushedAt: new Date() }).where(eq(schema.notifications.id, r.id));
  }
}
