import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db, schema } from '../src/db/client.js';
import { DEMO_PASSWORD, emailOf, seed } from '../src/db/seed.js';
import { runScheduledWork } from '../src/jobs/scheduler.js';
import { outbox } from '../src/lib/mailer.js';
import { budgetLevel } from '../src/modules/domain.js';
import { api, as, login } from './helpers.js';

let S: Awaited<ReturnType<typeof seed>>;
beforeAll(async () => { S = await seed({ exports: false, quiet: true, tinyReceipts: true }); });

describe('claim totals and budget thresholds', () => {
  it('counts only self-paid expenses without an uploaded receipt as missing', async () => {
    const arjun = await as(await login('arjun')).get(`/trips/${S.T.mt}/claim`);
    expect(arjun.body.totals.missingReceipts).toBe(0);
    const karthik = await as(await login('karthik')).get(`/trips/${S.T.mt}/claim`);
    expect(karthik.body.totals.missingReceipts).toBe(1);
  });

  it('decides the 80 % and 100 % levels on exact amounts', () => {
    expect(budgetLevel(1990000, 2000000)).toBe(80);   // 99.5 % is not over
    expect(budgetLevel(2000000, 2000000)).toBe(100);  // reaching the budget counts (SRS §6.4, "100% and over")
    expect(budgetLevel(1599999, 2000000)).toBe(0);
    expect(budgetLevel(1600000, 2000000)).toBe(80);
  });
});

describe('budgets saved together (FR-BUD-03)', () => {
  it('asks a member who gets both budgets in one save to choose for earlier expenses', async () => {
    const meera = as(await login('meera', 'web'));
    const pre = await meera.post(`/finance/trips/${S.T.pune}/budgets/preview`, { pool: 3000000, individuals: { [S.U.arjun.id]: 1000000 } });
    const effect = pre.body.members.find((m: { userId: string }) => m.userId === S.U.arjun.id).effect;
    expect(effect.needChoice.count).toBe(1);
    const r = await meera.put(`/finance/trips/${S.T.pune}/budgets`, { pool: { amountPaise: 3000000 }, individuals: { [S.U.arjun.id]: { amountPaise: 1000000 } }, note: 'KOL budget' });
    expect(r.status).toBe(200);
    expect(r.body.askedToChoose).toEqual([S.U.arjun.id]);
    const flight = (await db.select().from(schema.expenses).where(eq(schema.expenses.id, S.E.pune1)))[0];
    expect(flight.budgetSource).toBe('unbudgeted');
    expect(flight.needsBudgetChoice).toBe(true);
    const notes = await as(await login('arjun')).get('/notifications');
    expect(notes.body.items.some((n: { type: string }) => n.type === 'budget.choose')).toBe(true);
    const log = await meera.get(`/finance/trips/${S.T.pune}/budgets/log`);
    expect(log.body).toHaveLength(2);
  });

  it('keeps a removed budget’s expenses unbudgeted even when another budget is set in the same save (FR-BUD-05)', async () => {
    const meera = as(await login('meera', 'web'));
    const r = await meera.put(`/finance/trips/${S.T.kochi}/budgets`, { pool: { amountPaise: 2000000 } });
    expect(r.body.charged).toBeGreaterThan(0);
    const swap = await meera.put(`/finance/trips/${S.T.kochi}/budgets`, { pool: null, individuals: { [S.U.farhan.id]: { amountPaise: 500000 } } });
    expect(swap.status).toBe(200);
    const rows = await db.select().from(schema.expenses).where(eq(schema.expenses.tripId, S.T.kochi));
    expect(rows.filter(e => e.userId === S.U.farhan.id && e.paidBy === 'self').every(e => e.budgetSource === 'unbudgeted')).toBe(true);
  });
});

describe('administration (W10, W11, FR-ADM-04)', () => {
  it('shows administrators only the administration entries of the audit log', async () => {
    const farah = as(await login('farah', 'web'));
    const r = await farah.get('/admin/audit');
    expect(r.status).toBe(200);
    expect(r.body.scope).toBe('administration');
    expect(r.body.items.every((i: { entity: string }) => ['user', 'department'].includes(i.entity))).toBe(true);
    const fin = await as(await login('meera', 'web')).get(`/finance/audit?tripId=${S.T.mt}&pageSize=5`);
    expect(fin.body.total).toBeGreaterThan(5);
    expect(fin.body.items[0].item).toBeTruthy();
  });

  it('keeps at least two people with Finance', async () => {
    const farah = as(await login('farah', 'web'));
    const r = await farah.post(`/admin/users/${S.U.meera.id}/deactivate`, { reason: 'Test' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('finance_minimum');
    const role = await farah.patch(`/admin/users/${S.U.vikram.id}`, { isFinance: false });
    expect(role.body.error.code).toBe('finance_minimum');
  });

  it('keeps the deactivation reason and tells the person whom to contact', async () => {
    const farah = as(await login('farah', 'web'));
    const r = await farah.post(`/admin/users/${S.U.priya.id}/deactivate`, { reason: 'Left the company on 30 Sep' });
    expect(r.status).toBe(200);
    const audit = await farah.get(`/admin/audit?action=user.deactivate`);
    expect(audit.body.items.some((i: { meta: { reason?: string } }) => i.meta.reason === 'Left the company on 30 Sep')).toBe(true);
    const signIn = await api().post('/api/v1/auth/login').send({ email: emailOf('priya'), password: DEMO_PASSWORD, client: 'mobile' });
    expect(signIn.status).toBe(401);
    expect(signIn.body.error.details.contact.name).toBe('Farah Siddiqui');
    expect((await farah.post(`/admin/users/${S.U.priya.id}/reactivate`)).status).toBe(200);
  });

  it('emails the app link to someone who has not signed in', async () => {
    const farah = as(await login('farah', 'web'));
    const r = await farah.post(`/admin/users/${S.U.aditi.id}/app-link`);
    expect(r.status).toBe(204);
    expect(outbox.some(m => m.to === emailOf('aditi') && m.subject === 'Get the Expenso app')).toBe(true);
    const again = await farah.post(`/admin/users/${S.U.arjun.id}/app-link`);
    expect(again.body.error.code).toBe('already_signed_in');
    const depts = await farah.get('/admin/departments');
    expect(depts.body.find((d: { name: string }) => d.name === 'Sales').tripsThisYear).toBeGreaterThan(0);
  });
});

describe('finance hand-off and console data', () => {
  it('lets a finance user on a trip ask another finance user (FR-VER-10)', async () => {
    const vikram = as(await login('vikram', 'web'));
    const r = await vikram.post(`/finance/trips/${S.T.vizag}/handoff`, { toUserId: S.U.meera.id, topic: 'budgets' });
    expect(r.status).toBe(204);
    const self = await vikram.post(`/finance/trips/${S.T.vizag}/handoff`, { toUserId: S.U.vikram.id, topic: 'claim' });
    expect(self.status).toBe(400);
    const n = await as(await login('meera', 'web')).get('/notifications');
    expect(n.body.items.some((x: { type: string }) => x.type === 'finance.handoff')).toBe(true);
  });

  it('adds the fields the console asked for', async () => {
    const meera = as(await login('meera', 'web'));
    const trips = await meera.get('/finance/trips?q=Supplier');
    expect(trips.body.items[0].financeMemberIds).toEqual([S.U.vikram.id]);
    const claims = await meera.get('/finance/claims?status=verified');
    const imran = claims.body.find((c: { userId: string }) => c.userId === S.U.imran.id);
    expect(imran.actualEnd).toBeTruthy();
    const review = await meera.get(`/finance/trips/${S.T.cath}/claims/${S.U.deepa.id}`);
    expect(review.body.payments[0].recordedByName).toBe('Meera Krishnan');
    const month = await meera.get('/finance/dashboard?month=2026-08');
    expect(month.body.month).toBe('2026-08');
  });
});

describe('finance answers on a thread (round 3)', () => {
  it('lets finance write on an expense without changing the decision, and lists finance users for hand-off', async () => {
    const meera = as(await login('meera', 'web'));
    const r = await meera.post(`/finance/expenses/${S.E.d2}/messages`, { body: 'Kept at the pool rate; see the cab policy.' });
    expect(r.status).toBe(201);
    const e = await meera.get(`/finance/expenses/${S.E.d2}`);
    expect(e.body.expense.verification).toBe('pending');
    expect(e.body.thread.at(-1).kind).toBe('note');
    const divya = await as(await login('divya')).get('/notifications');
    expect(divya.body.items.some((n: { type: string }) => n.type === 'expense.message')).toBe(true);
    const review = await as(await login('vikram', 'web')).get(`/finance/trips/${S.T.vizag}/claims/${S.U.vikram.id}`);
    expect(review.body.financeUsers.find((f: { userId: string }) => f.userId === S.U.vikram.id)).toMatchObject({ onTrip: true, isMe: true });
    expect(review.body.financeUsers.find((f: { userId: string }) => f.userId === S.U.meera.id)).toMatchObject({ onTrip: false });
  });
});

describe('member additions', () => {
  it('lists colleagues before a trip exists (M03 to M04)', async () => {
    const r = await as(await login('arjun')).get('/me/colleagues');
    const names = r.body.map((c: { name: string }) => c.name);
    expect(names).toContain('Divya Raman');
    expect(names).not.toContain('Arjun Mehta');
    expect(names).not.toContain('Suresh Babu');
    expect(r.body.find((c: { name: string }) => c.name === 'Aditi Rao').selectable).toBe(false);
  });

  it('makes replies idempotent and lets a member ask about a decision', async () => {
    const arjun = as(await login('arjun'));
    const a = await arjun.post(`/expenses/${S.E.a1}/replies`, { clientId: 'reply-1', body: 'Bill attached now.' });
    const b = await arjun.post(`/expenses/${S.E.a1}/replies`, { clientId: 'reply-1', body: 'Bill attached now.' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.message.id).toBe(a.body.message.id);
    const meera = as(await login('meera', 'web'));
    const v = (await meera.get(`/finance/expenses/${S.E.r2}`)).body.expense.version;
    await meera.post(`/finance/expenses/${S.E.r2}/reject`, { version: v, remark: 'Not a trip expense.' });
    const rohan = as(await login('rohan'));
    const d = await rohan.post(`/expenses/${S.E.r2}/replies`, { body: 'It was the stall team dinner.' });
    expect(d.status).toBe(201);
    expect(d.body.message.kind).toBe('dispute');
    const n = await meera.get('/notifications');
    expect(n.body.items.some((x: { type: string }) => x.type === 'expense.disputed')).toBe(true);
  });

  it('moves an expense to another of the member’s trips, deciding its budget there', async () => {
    const arjun = as(await login('arjun'));
    const need = await arjun.post(`/expenses/${S.E.a4}/move`, { tripId: S.T.pune });
    expect(need.status).toBe(422); // Arjun holds both budgets on the Pune trip now
    const r = await arjun.post(`/expenses/${S.E.a4}/move`, { tripId: S.T.pune, budgetSource: 'pool' });
    expect(r.status).toBe(200);
    expect(r.body.tripId).toBe(S.T.pune);
    expect(r.body.flags).toContain('pre_trip');
    const mt = await arjun.get(`/trips/${S.T.mt}`);
    expect(mt.body.expenses.some((e: { id: string }) => e.id === S.E.a4)).toBe(false);
  });

  it('logs a phone-built export once per clientId', async () => {
    const arjun = as(await login('arjun'));
    const body = { clientId: 'exp-log-1', formats: ['pdf'], provisional: true, builtAt: new Date().toISOString(), files: [{ format: 'pdf', name: 'x.pdf', size: 10 }] };
    const a = await arjun.post(`/trips/${S.T.mt}/exports/log`, body);
    const b = await arjun.post(`/trips/${S.T.mt}/exports/log`, body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
  });
});

describe('daily digest (FR-NOT-05)', () => {
  it('emails finance users who opted in, once a day', async () => {
    const meera = as(await login('meera', 'web'));
    await meera.patch('/me/settings', { dailyDigest: true });
    const at = new Date(`${new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10)}T10:00:00+05:30`);
    const before = outbox.length;
    const r1 = await runScheduledWork(at);
    expect(r1).toMatchObject({ digests: 1 });
    expect(outbox.length).toBe(before + 1);
    expect(outbox[outbox.length - 1].subject).toContain('Expenso daily digest');
    const r2 = await runScheduledWork(new Date(at.getTime() + 3600_000));
    expect(r2).toMatchObject({ digests: 0 });
  });
});
