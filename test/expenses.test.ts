import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../src/db/seed.js';
import { as, login } from './helpers.js';

let S: Awaited<ReturnType<typeof seed>>;
let jpeg: Buffer;
beforeAll(async () => {
  S = await seed({ exports: false, quiet: true, tinyReceipts: true });
  jpeg = await sharp({ create: { width: 120, height: 160, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
});
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const receipt = (name = 'IMG_1.jpg') => ({ name, mime: 'image/jpeg', size: 2048, capturedAt: minutesAgo(1) });

describe('logging an expense (SRS §5, §6.2)', () => {
  it('asks a member who holds both budgets to choose a source (FR-BUD-04)', async () => {
    const divya = as(await login('divya'));
    const r = await divya.post(`/trips/${S.T.mt}/expenses`, { spentAt: minutesAgo(30), category: 'cab', description: 'Cab to the hotel', amountPaise: 42000, paymentMode: 'upi', paidBy: 'self', attachments: [receipt()] });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('budget_source_required');
    const ok = await divya.post(`/trips/${S.T.mt}/expenses`, { spentAt: minutesAgo(30), category: 'cab', description: 'Cab to the hotel', amountPaise: 42000, paymentMode: 'upi', paidBy: 'self', budgetSource: 'individual', attachments: [receipt()] });
    expect(ok.status).toBe(201);
    expect(ok.body.expense.budgetSource).toBe('individual');
  });

  it('requires a receipt for self-paid expenses and reports every problem at once', async () => {
    const karthik = as(await login('karthik'));
    const r = await karthik.post(`/trips/${S.T.mt}/expenses`, { spentAt: minutesAgo(5), category: 'meals', description: ' ', amountPaise: 15000, paymentMode: 'company', paidBy: 'self', attachments: [] });
    expect(r.status).toBe(400);
    const fields = r.body.error.details.map((d: { field: string }) => d.field).sort();
    expect(fields).toEqual(['attachments', 'description', 'paidBy'].sort());
  });

  it('warns about a possible duplicate and saves when confirmed (FR-EXP-09)', async () => {
    const rohan = as(await login('rohan'));
    const snap = await rohan.get(`/trips/${S.T.mt}`);
    const mine = snap.body.expenses.find((e: { description: string }) => e.description === 'Dinner');
    const body = { spentAt: mine.spentAt, category: 'meals', description: 'Dinner again', amountPaise: mine.amountPaise, paymentMode: 'upi', paidBy: 'self', attachments: [receipt()] };
    const dup = await rohan.post(`/trips/${S.T.mt}/expenses`, body);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('possible_duplicate');
    const ok = await rohan.post(`/trips/${S.T.mt}/expenses`, { ...body, confirmDuplicate: true });
    expect(ok.status).toBe(201);
  });

  it('is idempotent on the client id, so an offline retry never double-logs (NFR-02)', async () => {
    const arjun = as(await login('arjun'));
    const body = { clientId: 'offline-7f1c', spentAt: minutesAgo(12), category: 'cab', description: 'Auto to BIEC', amountPaise: 18000, paymentMode: 'cash', paidBy: 'self', attachments: [{ ...receipt(), clientId: 'att-7f1c' }] };
    const a = await arjun.post(`/trips/${S.T.mt}/expenses`, body);
    const b = await arjun.post(`/trips/${S.T.mt}/expenses`, body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.idempotent).toBe(true);
    expect(b.body.expense.id).toBe(a.body.expense.id);

    // The receipt bytes follow; re-sending them is harmless.
    const up = await arjun.raw('put', a.body.uploads[0].uploadPath.replace('/api/v1', '')).set('Content-Type', 'image/jpeg').send(jpeg);
    expect(up.status).toBe(200);
    expect(up.body.status).toBe('uploaded');
    const again = await arjun.raw('put', a.body.uploads[0].uploadPath.replace('/api/v1', '')).set('Content-Type', 'image/jpeg').send(jpeg);
    expect(again.status).toBe(200);
    const img = await arjun.get(`/attachments/${up.body.id}/content?w=64`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
  });

  it('flags advance bookings before the trip starts (FR-EXP-11)', async () => {
    const rohan = as(await login('rohan'));
    const home = await rohan.get('/trips/mine');
    const cme = home.body.scheduled.find((t: { name: string }) => t.name.startsWith('Cardiology CME'));
    const r = await rohan.post(`/trips/${cme.id}/expenses`, { spentAt: minutesAgo(3), category: 'event_fee', description: 'CME registration', amountPaise: 350000, paymentMode: 'card', paidBy: 'self', attachments: [receipt()] });
    expect(r.status).toBe(201);
    expect(r.body.expense.flags).toContain('pre_trip');
    const tooSoon = await rohan.post(`/trips/${cme.id}/expenses`, { spentAt: new Date(Date.now() + 12 * 24 * 3600_000).toISOString(), category: 'meals', description: 'Future lunch', amountPaise: 30000, paymentMode: 'cash', paidBy: 'self', attachments: [receipt()] });
    expect(tooSoon.status).toBe(409);
    expect(tooSoon.body.error.code).toBe('not_started');
  });

  it('keeps a pending upload visible as not received', async () => {
    const karthik = as(await login('karthik'));
    const e = await karthik.get(`/expenses/${S.E.k2}`);
    expect(e.body.expense.attachments[0].status).toBe('pending');
    expect(e.body.expense.attachments[0].url).toBeNull();
  });
});

describe('after the trip ends (FR-EXP-04, FR-END-06)', () => {
  it('locks expenses after ending, except those finance queried', async () => {
    const suresh = as(await login('suresh'));
    const locked = await suresh.patch(`/expenses/${S.E.ca1}`, { description: 'Changed' });
    expect(locked.status).toBe(409);
    const snap = await suresh.get(`/trips/${S.T.cath}`);
    expect(snap.body.me.claimStatus).toBe('ready');
  });

  it('adds a late entry flagged and sends a verified claim back to Ready', async () => {
    const imran = as(await login('imran'));
    const before = await imran.get(`/trips/${S.T.cath}/claim`);
    expect(before.body.status).toBe('verified');
    const r = await imran.post(`/trips/${S.T.cath}/expenses`, { spentAt: new Date(Date.now() - 3 * 24 * 3600_000).toISOString(), category: 'cab', description: 'Missed cab bill', amountPaise: 45000, paymentMode: 'upi', paidBy: 'self', budgetSource: 'pool', attachments: [receipt()] });
    expect(r.status).toBe(201);
    expect(r.body.expense.flags).toContain('late_entry');
    const after = await imran.get(`/trips/${S.T.cath}/claim`);
    expect(after.body.status).toBe('ready');
  });

  it('keeps a reimbursed claim locked (FR-VER-09)', async () => {
    const deepa = as(await login('deepa'));
    const r = await deepa.post(`/trips/${S.T.cath}/expenses`, { spentAt: minutesAgo(60 * 50), category: 'meals', description: 'Forgotten snack', amountPaise: 12000, paymentMode: 'cash', paidBy: 'self', attachments: [receipt()] });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('claim_locked');
  });
});

describe('queries (FR-VER-03)', () => {
  it('lets the member answer with text and a new file; finance is told', async () => {
    const arjun = as(await login('arjun'));
    const r = await arjun.post(`/expenses/${S.E.a1}/replies`, { body: 'Itemised bill attached.', attachments: [receipt('bill.jpg')] });
    expect(r.status).toBe(201);
    expect(r.body.uploads).toHaveLength(1);
    const meera = as(await login('meera', 'web'));
    const n = await meera.get('/notifications');
    expect(n.body.items.some((x: { type: string }) => x.type === 'query.reply')).toBe(true);
    const view = await arjun.get(`/expenses/${S.E.a1}`);
    expect(view.body.thread.map((t: { kind: string }) => t.kind)).toEqual(['query', 'reply']);
  });
});
