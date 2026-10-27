/** Dev helper: build one export of a seeded trip as Meera (finance). Usage: npx tsx scripts/export-once.ts <scope> <trip ref> [member key] */
import { eq } from 'drizzle-orm';
import { db, pool, schema } from '../src/db/client.js';
import { withTx } from '../src/lib/context.js';
import * as xs from '../src/modules/exports/service.js';

const [scope = 'trip_and_each', ref, who] = process.argv.slice(2);
const trip = (await db.select().from(schema.trips).where(eq(schema.trips.ref, ref)))[0];
if (!trip) throw new Error(`No trip ${ref}`);
const meera = (await db.select().from(schema.users).where(eq(schema.users.email, 'meera@xelements.test')))[0];
const member = who ? (await db.select().from(schema.users).where(eq(schema.users.email, `${who}@xelements.test`)))[0] : null;
const actor = { id: meera.id, name: meera.name, isFinance: true, isAdmin: false, departmentId: meera.departmentId, client: 'web' as const };
const x = await withTx(actor, ctx => xs.requestExport(ctx, trip.id, { scope: scope as xs.ExportRequest['scope'], memberUserId: member?.id, formats: ['pdf', 'xlsx', 'zip'] }, 'web'));
await xs.runQueuedExports();
const r = await xs.getExport(x.id);
console.log(r.status, r.error ?? '', JSON.stringify((r.files as Array<{ name: string; key: string; size: number }>).map(f => ({ name: f.name, key: f.key, size: f.size }))));
await pool.end();
