import { sql } from 'drizzle-orm';
import type { Ctx } from './context.js';
import { istDate } from './time.js';

/** Trip reference, unique and printed on every export: EXP-2026-00123 (FR-TRIP-03). */
export async function nextTripRef(ctx: Ctx): Promise<string> {
  const year = Number(istDate(ctx.now).slice(0, 4));
  const r = await ctx.tx.execute(sql`insert into ref_counters (year, last) values (${year}, 1)
    on conflict (year) do update set last = ref_counters.last + 1 returning last`);
  const n = Number((r.rows[0] as { last: number }).last);
  return `EXP-${year}-${String(n).padStart(5, '0')}`;
}
