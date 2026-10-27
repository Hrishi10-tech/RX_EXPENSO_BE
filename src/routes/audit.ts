/**
 * Audit log (W11, NFR-11, FR-ADM-04). Finance reads every entry; an administrator without the Finance role reads the
 * administration entries only (users, roles and departments), so no expense data reaches them.
 */
import type { Request, Response } from 'express';
import { and, desc, eq, gte, ilike, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/client.js';
import { me } from '../lib/auth.js';
import { parse, zDate, zId } from '../lib/http.js';
import { inr } from '../lib/money.js';

const { auditLog, trips, users, expenses, departments } = schema;

const zQuery = z.object({
  tripId: zId.optional(), actorId: zId.optional(), memberId: zId.optional(), action: z.string().max(60).optional(), entity: z.string().max(30).optional(),
  client: z.enum(['web', 'mobile', 'system']).optional(), q: z.string().max(100).optional(), from: zDate.optional(), to: zDate.optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(500).default(100), format: z.enum(['json', 'csv']).default('json'),
});

export function auditHandler(scope: 'finance' | 'admin') {
  return async (req: Request, res: Response) => {
    const q = parse(zQuery, req.query);
    const u = me(req);
    const adminOnly = scope === 'admin' && !u.isFinance;
    const where: SQL[] = [
      q.tripId ? eq(auditLog.tripId, q.tripId) : sql`true`, q.actorId ? eq(auditLog.actorId, q.actorId) : sql`true`,
      q.memberId ? eq(auditLog.memberUserId, q.memberId) : sql`true`, q.action ? ilike(auditLog.action, `${q.action}%`) : sql`true`,
      q.entity ? eq(auditLog.entity, q.entity) : sql`true`, q.client ? sql`${auditLog.meta}->>'client' = ${q.client}` : sql`true`,
      q.from ? gte(auditLog.at, new Date(`${q.from}T00:00:00+05:30`)) : sql`true`, q.to ? lte(auditLog.at, new Date(`${q.to}T23:59:59.999+05:30`)) : sql`true`,
      adminOnly ? inArray(auditLog.entity, ['user', 'department']) : sql`true`,
    ];
    if (q.q?.trim()) {
      const like = `%${q.q.trim()}%`;
      where.push(sql`(${auditLog.actorLabel} ilike ${like} or ${auditLog.action} ilike ${like}
        or exists (select 1 from trips t where t.id = ${auditLog.tripId} and (t.name ilike ${like} or t.ref ilike ${like}))
        or exists (select 1 from users m where m.id = ${auditLog.memberUserId} and m.name ilike ${like}))`);
    }
    const cond = and(...where);
    const limit = q.format === 'csv' ? 50000 : q.pageSize;
    const rows = await db.select({ a: auditLog, ref: trips.ref, tripName: trips.name }).from(auditLog).leftJoin(trips, eq(trips.id, auditLog.tripId)).where(cond)
      .orderBy(desc(auditLog.at), desc(auditLog.id)).limit(limit).offset(q.format === 'csv' ? 0 : (q.page - 1) * limit);
    const total = q.format === 'csv' ? rows.length : Number((await db.select({ c: sql<number>`count(*)` }).from(auditLog).where(cond))[0].c);
    const labels = await itemLabels(rows.map(r => r.a));
    const nameOf = labels.people;
    const items = rows.map(({ a, ref, tripName }) => ({
      id: a.id, at: a.at, actor: a.actorLabel, actorId: a.actorId, action: a.action, entity: a.entity, entityId: a.entityId,
      client: (a.meta as Record<string, unknown>)?.client ?? null, item: labels.item(a),
      tripId: a.tripId, tripRef: ref, tripName, memberUserId: a.memberUserId, member: a.memberUserId ? nameOf.get(a.memberUserId) ?? '' : '',
      before: a.before, after: a.after, meta: a.meta,
    }));
    if (q.format === 'csv') {
      const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = ['time,actor,source,action,item,entity,trip,member,before,after,meta', ...items.map(i => [i.at.toISOString(), i.actor, i.client ?? '', i.action, i.item, i.entity, i.tripRef ?? '', i.member, JSON.stringify(i.before ?? ''), JSON.stringify(i.after ?? ''), JSON.stringify(i.meta ?? '')].map(esc).join(','))];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="expenso-audit.csv"');
      res.send(lines.join('\n'));
      return;
    }
    res.json({ items, page: q.page, pageSize: q.pageSize, total, scope: adminOnly ? 'administration' : 'all' });
  };
}

/** A short label for what each entry is about: the expense, the budget, the person or the department. */
async function itemLabels(rows: Array<typeof auditLog.$inferSelect>) {
  const expIds = [...new Set(rows.filter(r => r.entity === 'expense' && r.entityId).map(r => r.entityId!))];
  const userIds = [...new Set(rows.flatMap(r => [r.memberUserId, r.entity === 'user' ? r.entityId : null]).filter((x): x is string => !!x))];
  const deptIds = [...new Set(rows.filter(r => r.entity === 'department' && r.entityId).map(r => r.entityId!))];
  const exps = expIds.length ? await db.select({ id: expenses.id, d: expenses.description, a: expenses.amountPaise }).from(expenses).where(inArray(expenses.id, expIds)) : [];
  const people = userIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : [];
  const depts = deptIds.length ? await db.select({ id: departments.id, name: departments.name }).from(departments).where(inArray(departments.id, deptIds)) : [];
  const peopleMap = new Map(people.map(p => [p.id, p.name]));
  const str = (o: unknown, k: string) => (o && typeof o === 'object' && k in o ? String((o as Record<string, unknown>)[k] ?? '') : '');
  const item = (r: typeof auditLog.$inferSelect): string => {
    const who = r.memberUserId ? peopleMap.get(r.memberUserId) ?? '' : '';
    switch (r.entity) {
      case 'expense': { const e = exps.find(x => x.id === r.entityId); return e ? `${e.d} · ${inr(e.a)}` : str(r.after, 'description') || str(r.before, 'description') || `Expense${who ? ` · ${who}` : ''}`; }
      case 'budget': return r.memberUserId ? `Individual · ${who}` : 'Trip pool';
      case 'user': return (r.entityId && peopleMap.get(r.entityId)) || str(r.after, 'name') || 'User';
      case 'department': return depts.find(d => d.id === r.entityId)?.name ?? (str(r.after, 'name') || 'Department');
      case 'location': return str(r.after, 'city') || str(r.before, 'city') || 'Location';
      case 'attachment': return str(r.meta, 'name') || str(r.before, 'name') || 'File';
      case 'member': return who || 'Member';
      case 'payment': return `Payment${who ? ` · ${who}` : ''}`;
      case 'claim': return `Claim${who ? ` · ${who}` : ''}`;
      case 'export': return `Export${who ? ` · ${who}` : ''}`;
      case 'trip': return 'Trip';
      default: return r.entity;
    }
  };
  return { item, people: peopleMap };
}
