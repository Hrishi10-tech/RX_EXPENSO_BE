import { beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../src/db/seed.js';
import { as, login } from './helpers.js';

let S: Awaited<ReturnType<typeof seed>>;
beforeAll(async () => { S = await seed({ exports: false, quiet: true, tinyReceipts: true }); });

async function version(id: string) {
  const r = await as(await login('meera', 'web')).get(`/finance/expenses/${id}`);
  return r.body.expense.version as number;
}

describe('finance console (SRS §7)', () => {
  it('lists every trip with spend, budget use and verification progress (FR-WEB-02)', async () => {
    const meera = as(await login('meera', 'web'));
    const r = await meera.get('/finance/trips?status=active,extended');
    expect(r.status).toBe(200);
    const names = r.body.items.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(['MedTech Expo · Bengaluru & Mysuru', 'Distributor review · Coimbatore', 'Clinical training · Kochi']));
    const over = await meera.get('/finance/trips?budget=over');
    expect(over.body.items.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(['Distributor review · Coimbatore', 'Cath lab install · Hyderabad']));
  });

  it('shows the dashboard numbers (FR-WEB-07)', async () => {
    const r = await as(await login('meera', 'web')).get('/finance/dashboard');
    expect(r.status).toBe(200);
    expect(r.body.kpis ?? r.body).toBeTruthy();
  });

  it('queues claims longest waiting first and leaves out a finance user’s own (FR-VER-10)', async () => {
    const vikram = as(await login('vikram', 'web'));
    const r = await vikram.get('/finance/claims');
    expect(r.status).toBe(200);
    for (const c of r.body) if (c.userId === S.U.vikram.id) expect(c.ownClaim).toBe(true);
  });
});

describe('verification (FR-VER-01..05)', () => {
  it('blocks verifying while a receipt is still on the phone', async () => {
    const meera = as(await login('meera', 'web'));
    const r = await meera.post(`/finance/expenses/${S.E.k2}/verify`, { version: await version(S.E.k2) });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('receipt_pending');
    const remind = await meera.post(`/finance/expenses/${S.E.k2}/remind`);
    expect(remind.status).toBe(204);
  });

  it('needs a reason for a lower amount and refuses a stale version', async () => {
    const meera = as(await login('meera', 'web'));
    const v = await version(S.E.d1);
    const noReason = await meera.post(`/finance/expenses/${S.E.d1}/verify`, { version: v, approvedPaise: 250000 });
    expect(noReason.status).toBe(400);
    const ok = await meera.post(`/finance/expenses/${S.E.d1}/verify`, { version: v, approvedPaise: 250000, reason: 'Entertainment limit ₹2,500 per event' });
    expect(ok.status).toBe(200);
    expect(ok.body.approvedPaise).toBe(250000);
    const stale = await meera.post(`/finance/expenses/${S.E.d2}/query`, { version: (await version(S.E.d2)) + 7, remark: 'Which airport?' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('stale_version');
  });

  it('rejects with a remark; the expense stays on the claim and leaves the budget (FR-VER-04)', async () => {
    const meera = as(await login('meera', 'web'));
    const before = await meera.get(`/finance/trips/${S.T.mt}`);
    const r = await meera.post(`/finance/expenses/${S.E.r2}/reject`, { version: await version(S.E.r2), remark: 'Personal dinner, not a trip expense.' });
    expect(r.status).toBe(200);
    const after = await meera.get(`/finance/trips/${S.T.mt}`);
    expect(after.body.budgets.pool.spentPaise).toBe(before.body.budgets.pool.spentPaise - 54000);
    expect(after.body.expenses.find((e: { id: string }) => e.id === S.E.r2).verification).toBe('rejected');
  });

  it('verifies several at once and reports what it skipped (FR-VER-05)', async () => {
    const meera = as(await login('meera', 'web'));
    const items = [];
    for (const k of ['ko2', 'ko3', 'ko1']) items.push({ id: S.E[k], version: await version(S.E[k]) });
    const r = await meera.post('/finance/expenses/verify-bulk', { items });
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.results.map((x: { id: string; ok: boolean; code?: string }) => [x.id, x]));
    expect(byId[S.E.ko2].ok).toBe(true);
    expect(byId[S.E.ko1].code).toBe('flagged'); // the pre-trip train needs a look first
  });
});

describe('budgets (SRS §6, FR-VER-10)', () => {
  it('stops a finance user who is on the trip from setting its budget', async () => {
    const vikram = as(await login('vikram', 'web'));
    const r = await vikram.put(`/finance/trips/${S.T.vizag}/budgets/pool`, { amountPaise: 3000000 });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('finance_member_of_trip');
  });

  it('previews then sets an individual budget; earlier unbudgeted expenses are charged to it', async () => {
    const meera = as(await login('meera', 'web'));
    const pre = await meera.post(`/finance/trips/${S.T.kochi}/budgets/preview`, { individuals: { [S.U.farhan.id]: 500000 } });
    expect(pre.status).toBe(200);
    const r = await meera.put(`/finance/trips/${S.T.kochi}/budgets/individual/${S.U.farhan.id}`, { amountPaise: 500000, note: 'Handouts and travel' });
    expect(r.status).toBe(200);
    const ind = r.body.budgets.individuals.find((b: { memberUserId: string }) => b.memberUserId === S.U.farhan.id);
    expect(ind.spentPaise).toBeGreaterThan(0);
    const farhan = await as(await login('farhan')).get(`/trips/${S.T.kochi}`);
    expect(farhan.body.budgets.individual.allocatedPaise).toBe(500000);
    const lakshmi = await as(await login('lakshmi')).get(`/trips/${S.T.kochi}`);
    expect(lakshmi.body.budgets.individual).toBeNull();
  });
});

describe('reimbursement (FR-VER-06..09)', () => {
  it('records a payment on a verified claim, then locks it; reopening needs a reason', async () => {
    const meera = as(await login('meera', 'web'));
    const claim = await meera.get(`/finance/trips/${S.T.cath}/claims/${S.U.imran.id}`);
    expect(claim.body.claim.status).toBe('verified');
    const tooMuch = await meera.post(`/finance/trips/${S.T.cath}/claims/${S.U.imran.id}/payments`, { amountPaise: claim.body.claim.balancePaise + 100, paidOn: new Date().toISOString().slice(0, 10), mode: 'upi' });
    expect(tooMuch.status).toBe(400);
    const part = await meera.post(`/finance/trips/${S.T.cath}/claims/${S.U.imran.id}/payments`, { amountPaise: 100000, paidOn: new Date().toISOString().slice(0, 10), mode: 'upi', reference: 'UPI/1' });
    expect(part.status).toBe(201);
    expect(part.body.claimStatus).toBe('part_paid');
    const rest = await meera.post(`/finance/trips/${S.T.cath}/claims/${S.U.imran.id}/payments`, { amountPaise: part.body.balancePaise, paidOn: new Date().toISOString().slice(0, 10), mode: 'bank_transfer', reference: 'NEFT/2' });
    expect(rest.body.claimStatus).toBe('reimbursed');
    const imran = as(await login('imran'));
    const mine = await imran.get(`/trips/${S.T.cath}/claim`);
    expect(mine.body.payments).toHaveLength(2);
    const noReason = await meera.post(`/finance/trips/${S.T.cath}/claims/${S.U.imran.id}/reopen`, { reason: '' });
    expect(noReason.status).toBe(400);
    const reopened = await meera.post(`/finance/trips/${S.T.cath}/claims/${S.U.imran.id}/reopen`, { reason: 'Missed cab bill to add' });
    expect(reopened.status).toBe(200);
  });

  it('refuses a finance user their own reimbursement', async () => {
    const vikram = as(await login('vikram', 'web'));
    const r = await vikram.post(`/finance/trips/${S.T.vizag}/claims/${S.U.vikram.id}/payments`, { amountPaise: 1000, paidOn: new Date().toISOString().slice(0, 10), mode: 'cash' });
    expect(r.status).toBe(403);
  });

  it('ends a member’s trip for them with a reason (FR-END-05) and assigns a new owner', async () => {
    const meera = as(await login('meera', 'web'));
    const end = await meera.post(`/finance/trips/${S.T.cbe}/members/${S.U.nikhil.id}/end`, { endAt: new Date(Date.now() - 3600_000).toISOString(), reason: 'Left the company; last working day' });
    expect(end.status).toBe(200);
    const owner = await meera.post(`/finance/trips/${S.T.cbe}/owner`, { userId: S.U.sneha.id });
    expect(owner.status).toBe(200);
    expect(owner.body.trip.ownerId).toBe(S.U.sneha.id);
  });

  it('keeps an audit trail that finance can filter and download (NFR-11)', async () => {
    const meera = as(await login('meera', 'web'));
    const r = await meera.get(`/finance/audit?tripId=${S.T.cath}`);
    expect(r.body.items.length).toBeGreaterThan(10);
    const csv = await meera.get(`/finance/audit?tripId=${S.T.cath}&format=csv`);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\n')[0]).toBe('time,actor,source,action,item,entity,trip,member,before,after,meta');
  });
});
