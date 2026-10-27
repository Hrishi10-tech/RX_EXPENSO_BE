/**
 * Demo data: the MedTech Expo story from the prototypes, replayed through the real services and dated relative to
 * today, so every screen of both apps has something true to show: trips running, extended, closed, cancelled and
 * scheduled; budgets and overages; queries and replies; payments; a receipt still on a phone; exports.
 *
 *   npm run db:seed          wipe the database and load the demo (refuses when NODE_ENV=production)
 *
 * Every demo account signs in with the password Expenso@2026, or with an email code when DEV_ECHO_OTP is on.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { runScheduledWork } from '../jobs/scheduler.js';
import { withTx, type Actor, type Ctx } from '../lib/context.js';
import { addDays, istDate, istTime } from '../lib/time.js';
import * as admin from '../modules/admin/service.js';
import { hashPassword } from '../modules/auth/service.js';
import * as ex from '../modules/expenses/service.js';
import * as xs from '../modules/exports/service.js';
import * as fin from '../modules/finance/service.js';
import * as locs from '../modules/locations/service.js';
import * as trips from '../modules/trips/service.js';
import { db, pool, schema } from './client.js';
import { billJpeg, docPdf, ticketJpeg, upiJpeg } from './demo-files.js';
import { runMigrations } from './migrate.js';

export const DEMO_PASSWORD = 'Expenso@2026';

/* ---------- the clock: day 0 is today, or yesterday before 16:30 IST, so no story event is in the future ---------- */
const realNow = new Date();
const D0 = istTime(realNow) >= '16:30' ? istDate(realNow) : addDays(istDate(realNow), -1);
const at = (d: number, hm: string) => new Date(`${addDays(D0, d)}T${hm}:00+05:30`);
const day = (d: number) => addDays(D0, d);
const plus = (t: Date, min: number) => new Date(t.getTime() + min * 60000);

/* ---------- people ---------- */
const DEPTS = ['Sales', 'Clinical Applications', 'Service', 'Finance', 'Administration'] as const;
interface Person { key: string; name: string; code: string; dept: (typeof DEPTS)[number]; finance?: boolean; admin?: boolean; neverSignedIn?: boolean; phone?: string }
const DESIGNATION: Record<string, string> = {'arjun': 'Area Sales Manager', 'divya': 'Key Account Manager', 'karthik': 'Sales Executive', 'rohan': 'Regional Sales Manager', 'priya': 'Sales Executive', 'sneha': 'Territory Manager', 'nikhil': 'Distributor Manager', 'aditi': 'Sales Trainee', 'lakshmi': 'Clinical Specialist', 'farhan': 'Application Specialist', 'suresh': 'Service Lead', 'imran': 'Field Service Engineer', 'deepa': 'Field Service Engineer', 'joseph': 'Tender Executive', 'harish': 'Audit Associate', 'meera': 'Finance Manager', 'vikram': 'Senior Accountant', 'farah': 'IT Administrator'};
const PEOPLE: Person[] = [
  { key: 'arjun', name: 'Arjun Mehta', code: 'XE1042', dept: 'Sales', phone: '+91 98400 11042' },
  { key: 'divya', name: 'Divya Raman', code: 'XE1117', dept: 'Sales', phone: '+91 98400 11117' },
  { key: 'karthik', name: 'Karthik Iyer', code: 'XE1122', dept: 'Sales', phone: '+91 98400 11122' },
  { key: 'rohan', name: 'Rohan Das', code: 'XE1131', dept: 'Sales', phone: '+91 98400 11131' },
  { key: 'priya', name: 'Priya Nair', code: 'XE1140', dept: 'Sales' },
  { key: 'sneha', name: 'Sneha Pillai', code: 'XE1133', dept: 'Sales' },
  { key: 'nikhil', name: 'Nikhil Verma', code: 'XE1009', dept: 'Sales' },
  { key: 'aditi', name: 'Aditi Rao', code: 'XE1160', dept: 'Sales', neverSignedIn: true },
  { key: 'lakshmi', name: 'Lakshmi Menon', code: 'XE2152', dept: 'Clinical Applications' },
  { key: 'farhan', name: 'Farhan Qureshi', code: 'XE2150', dept: 'Clinical Applications' },
  { key: 'suresh', name: 'Suresh Babu', code: 'XE3160', dept: 'Service' },
  { key: 'imran', name: 'Imran Khan', code: 'XE3161', dept: 'Service' },
  { key: 'deepa', name: 'Deepa Srinivasan', code: 'XE3162', dept: 'Service' },
  { key: 'joseph', name: 'Joseph Mathew', code: 'XE3163', dept: 'Service' },
  { key: 'harish', name: 'Harish Kumar', code: 'XE4205', dept: 'Finance' },
  { key: 'meera', name: 'Meera Krishnan', code: 'XE4201', dept: 'Finance', finance: true },
  { key: 'vikram', name: 'Vikram Rao', code: 'XE4202', dept: 'Finance', finance: true },
  { key: 'farah', name: 'Farah Siddiqui', code: 'XE5301', dept: 'Administration', admin: true },
];
export const emailOf = (key: string) => `${key}@xelements.test`;

type UserRow = typeof schema.users.$inferSelect;
const U: Record<string, UserRow> = {};
const T: Record<string, string> = {};            // trip ids by story key
const E: Record<string, string> = {};            // expense ids by story key
const L: Record<string, string> = {};            // location ids by story key

const actor = (key: string, client: Actor['client'] = 'mobile'): Actor => {
  const u = U[key];
  return { id: u.id, name: u.name, isFinance: u.isFinance, isAdmin: u.isAdmin, departmentId: u.departmentId, client };
};
const as = <R>(key: string, when: Date, fn: (ctx: Ctx) => Promise<R>, client: Actor['client'] = 'mobile') => withTx(actor(key, client), fn, when);
const web = <R>(key: string, when: Date, fn: (ctx: Ctx) => Promise<R>) => as(key, when, fn, 'web');

/* ---------- receipts ---------- */
type Receipt =
  | { kind: 'bill'; merchant: string; address: string; items: Array<[string, number]>; tax?: number; gstin?: string; pay?: string }
  | { kind: 'upi'; payee: string; vpa: string }
  | { kind: 'ticket'; carrier: string; mode: 'flight' | 'train'; fromCode: string; toCode: string; from: string; to: string; dep: string; arr: string; pnr: string; number: string };

let seedN = 0;
let tinyReceipts = false;
let tinyJpeg: Buffer | null = null;
async function render(r: Receipt, when: Date, amountPaise: number, payer: string): Promise<Buffer> {
  seedN++;
  if (tinyReceipts) {
    // Tests only need real JPEG bytes, not a legible bill.
    tinyJpeg ??= await (await import('sharp')).default({ create: { width: 48, height: 64, channels: 3, background: '#f4efe6' } }).jpeg().toBuffer();
    return tinyJpeg;
  }
  const refNo = String(400000000000 + ((seedN * 7919) % 99999999)).slice(0, 12);
  if (r.kind === 'upi') return upiJpeg({ payee: r.payee, vpa: r.vpa, amountPaise, when, ref: refNo, from: 'HDFC Bank ••4421' }, seedN);
  if (r.kind === 'ticket') return ticketJpeg({ carrier: r.carrier, kind: r.mode, fromCode: r.fromCode, toCode: r.toCode, from: r.from, to: r.to, dep: r.dep, arr: r.arr, pax: payer, pnr: r.pnr, when, amountPaise, number: r.number }, seedN);
  return billJpeg({ merchant: r.merchant, address: r.address, gstin: r.gstin, when, billNo: `${r.merchant.slice(0, 2).toUpperCase()}/${String(1000 + seedN * 37)}`, items: r.items, totalPaise: amountPaise, taxPct: r.tax, pay: r.pay ?? `Paid by UPI · Ref ${refNo}` }, seedN);
}
const photoName = (t: Date, i = 0) => `IMG_${istDate(t).replace(/-/g, '')}_${istTime(plus(t, i)).replace(':', '')}${String(10 + (seedN % 49)).padStart(2, '0')}.jpg`;

interface Exp {
  key: string; who: string; trip: string; at: Date; cat: ex.ExpenseInput['category']; desc: string; rs: number;
  mode: 'upi' | 'cash' | 'card' | 'company'; paidBy?: 'self' | 'company'; source?: 'pool' | 'individual'; remarks?: string; loc?: string;
  receipts: Receipt[]; pendingUpload?: boolean; loggedAfterMin?: number;
}

const loggedAtOf = (x: { at: Date; loggedAfterMin?: number }) => plus(x.at, x.loggedAfterMin ?? 2);
async function addExpense(x: Exp) {
  const loggedAt = loggedAtOf(x);
  const payer = U[x.who].name;
  const amountPaise = Math.round(x.rs * 100);
  const files = await Promise.all(x.receipts.map(r => render(r, x.at, amountPaise, payer)));
  const r = await as(x.who, loggedAt, ctx => ex.createExpense(ctx, T[x.trip], {
    clientId: crypto.randomUUID(), locationId: x.loc ? L[x.loc] : null, spentAt: x.at, category: x.cat, description: x.desc, amountPaise,
    paymentMode: x.mode, paidBy: x.paidBy ?? (x.mode === 'company' ? 'company' : 'self'), budgetSource: x.source ?? null, remarks: x.remarks ?? null,
    attachments: files.map((f, i) => ({ clientId: crypto.randomUUID(), name: photoName(x.at, i), mime: 'image/jpeg', size: f.length, capturedAt: plus(x.at, i) })),
    confirmDuplicate: true, deviceTime: loggedAt,
  }));
  E[x.key] = r.expense.id;
  if (!x.pendingUpload) {
    for (let i = 0; i < r.uploads.length; i++) {
      await as(x.who, plus(loggedAt, 1), ctx => ex.uploadContent(ctx, r.uploads[i].attachmentId, files[i], 'image/jpeg'));
    }
  }
}
const version = async (key: string) => (await db.select({ v: schema.expenses.version }).from(schema.expenses).where(eq(schema.expenses.id, E[key])))[0].v;
const verify = async (fk: string, key: string, when: Date, approvedRs?: number, reason?: string) =>
  web(fk, when, async ctx => fin.verifyExpense(ctx, E[key], await version(key), approvedRs ? Math.round(approvedRs * 100) : null, reason ?? null));
const query = async (fk: string, key: string, when: Date, remark: string) => web(fk, when, async ctx => fin.queryExpense(ctx, E[key], await version(key), remark));
const reject = async (fk: string, key: string, when: Date, remark: string) => web(fk, when, async ctx => fin.rejectExpense(ctx, E[key], await version(key), remark));
async function reply(who: string, key: string, when: Date, text: string, receipt?: { r: Receipt; rs: number }) {
  const file = receipt ? await render(receipt.r, when, Math.round(receipt.rs * 100), U[who].name) : null;
  const r = await as(who, when, ctx => ex.replyToQuery(ctx, E[key], text, file ? [{ clientId: crypto.randomUUID(), name: photoName(when), mime: 'image/jpeg', size: file.length, capturedAt: when }] : []));
  if (file) await as(who, plus(when, 1), ctx => ex.uploadContent(ctx, r.uploads[0].attachmentId, file, 'image/jpeg'));
}
async function pay(fk: string, trip: string, who: string, when: Date, rs: number, reference: string, mode: 'bank_transfer' | 'upi' | 'cash' = 'bank_transfer') {
  const paidOn = istDate(when);
  const proof = await docPdf('Payment advice', `${mode === 'bank_transfer' ? 'NEFT transfer' : mode === 'upi' ? 'UPI transfer' : 'Cash'} · Xelements Health Pvt Ltd`, [
    ['Beneficiary', U[who].name], ['Employee ID', U[who].employeeCode], ['Amount', `₹${rs.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
    ['Paid on', paidOn], ['Reference', reference], ['Purpose', 'Trip expense reimbursement'],
  ]);
  const doc = await web(fk, when, ctx => fin.uploadDocument(ctx, { tripId: T[trip], scope: 'claim', memberUserId: U[who].id, docType: 'payment_proof', name: `Payment advice ${reference.split('/').pop()}.pdf`, mime: 'application/pdf', body: proof }));
  return web(fk, plus(when, 1), ctx => fin.recordPayment(ctx, T[trip], U[who].id, { amountPaise: Math.round(rs * 100), paidOn, mode, reference, proofAttachmentId: doc.id }));
}
const tick = (when: Date) => runScheduledWork(when);

/* ---------- the story ---------- */
type Step = { at: Date; run: () => Promise<unknown> };
const steps: Step[] = [];
const on = (when: Date, run: () => Promise<unknown>) => steps.push({ at: when, run });
const onExp = (x: Exp) => on(loggedAtOf(x), () => addExpense(x));

function story() {
  /* === Hospital install · Hyderabad: Arjun alone, closed and reimbursed three weeks ago === */
  on(at(-24, '10:00'), () => as('arjun', at(-24, '10:00'), async ctx => { T.hyd = (await trips.createTrip(ctx, { name: 'Hospital install · Hyderabad', type: 'multi_day', purpose: 'installation', clientEvent: 'Care Hospitals, Banjara Hills', scheduledStart: at(-20, '07:00'), tentativeEnd: at(-18, '20:00'), primaryCity: 'Hyderabad' })).id; }));
  on(at(-20, '06:30'), () => as('arjun', at(-20, '06:30'), ctx => trips.startTrip(ctx, T.hyd)));
  const hyd: Array<Omit<Exp, 'who' | 'trip'>> = [
    { key: 'hyd1', at: at(-20, '06:05'), cat: 'airfare', desc: 'Flight to Hyderabad', rs: 6480, mode: 'card', receipts: [{ kind: 'ticket', carrier: 'SkyLark Airways', mode: 'flight', fromCode: 'MAA', toCode: 'HYD', from: 'Chennai', to: 'Hyderabad', dep: '07:10', arr: '08:25', pnr: 'QZ4K8P', number: 'SL 511' }] },
    { key: 'hyd2', at: at(-20, '09:20'), cat: 'cab', desc: 'Airport to hospital', rs: 890, mode: 'upi', receipts: [{ kind: 'upi', payee: 'CityRide Cabs', vpa: 'cityride@okhdfc' }] },
    { key: 'hyd3', at: at(-19, '11:00'), cat: 'accommodation', desc: 'Hotel, two nights', rs: 7800, mode: 'card', receipts: [{ kind: 'bill', merchant: 'Hotel Deccan Residency', address: 'Road No. 1, Banjara Hills\nHyderabad 500034', gstin: '36AADCD4412K1ZQ', items: [['Executive room x 2 nights', 1]], tax: 12, pay: 'Paid by card ••0921' }] },
    { key: 'hyd4', at: at(-19, '20:40'), cat: 'meals', desc: 'Dinner', rs: 720, mode: 'upi', receipts: [{ kind: 'bill', merchant: 'Paradise Kitchen', address: 'Somajiguda, Hyderabad', items: [['Veg biryani', 3], ['Raita', 1], ['Lime soda', 1]], tax: 5 }] },
    { key: 'hyd5', at: at(-18, '18:10'), cat: 'airfare', desc: 'Flight back to Chennai', rs: 2800, mode: 'card', receipts: [{ kind: 'ticket', carrier: 'SkyLark Airways', mode: 'flight', fromCode: 'HYD', toCode: 'MAA', from: 'Hyderabad', to: 'Chennai', dep: '19:40', arr: '20:55', pnr: 'QZ4K8P', number: 'SL 518' }] },
  ];
  for (const x of hyd) onExp({ ...x, who: 'arjun', trip: 'hyd' });
  on(at(-18, '21:05'), () => as('arjun', at(-18, '21:05'), ctx => trips.endTrip(ctx, T.hyd)));
  on(at(-17, '11:00'), async () => { for (const k of ['hyd1', 'hyd2', 'hyd3', 'hyd4', 'hyd5']) await verify('meera', k, at(-17, '11:00')); });
  on(at(-15, '15:30'), () => pay('meera', 'hyd', 'arjun', at(-15, '15:30'), 18690, 'HDFC/NEFT/0915/33120'));

  /* === Distributor meet · Madurai: Sneha alone, reimbursed === */
  on(at(-18, '10:00'), () => as('sneha', at(-18, '10:00'), async ctx => { T.mdu = (await trips.createTrip(ctx, { name: 'Distributor meet · Madurai', type: 'multi_day', purpose: 'client_meeting', clientEvent: 'Meenakshi Surgicals', scheduledStart: at(-15, '08:00'), tentativeEnd: at(-13, '18:00'), primaryCity: 'Madurai' })).id; }));
  on(at(-15, '08:00'), () => tick(at(-15, '08:00')));
  const mdu: Array<Omit<Exp, 'who' | 'trip'>> = [
    { key: 'mdu1', at: at(-15, '06:10'), cat: 'train', desc: 'Train to Madurai', rs: 1240, mode: 'upi', receipts: [{ kind: 'ticket', carrier: 'Southern Rail', mode: 'train', fromCode: 'MS', toCode: 'MDU', from: 'Chennai Egmore', to: 'Madurai Jn', dep: '06:40', arr: '14:05', pnr: '4521789034', number: '12635 Vaigai Exp' }] },
    { key: 'mdu2', at: at(-15, '15:00'), cat: 'accommodation', desc: 'Hotel, two nights', rs: 5600, mode: 'upi', receipts: [{ kind: 'bill', merchant: 'Temple View Inn', address: 'West Veli Street, Madurai 625001', gstin: '33AAFCT7781M1Z2', items: [['Standard room x 2 nights', 1]], tax: 12 }] },
    { key: 'mdu3', at: at(-14, '13:30'), cat: 'client_entertainment', desc: 'Lunch with distributor team', rs: 1850, mode: 'card', receipts: [{ kind: 'bill', merchant: 'Hotel Annapoorna', address: 'Town Hall Road, Madurai', items: [['South Indian meals x 4', 4], ['Sweet', 1]], tax: 5, pay: 'Paid by card ••0417' }] },
    { key: 'mdu4', at: at(-13, '17:40'), cat: 'cab', desc: 'Cab to station', rs: 650, mode: 'upi', receipts: [{ kind: 'upi', payee: 'CityRide Cabs', vpa: 'cityride@okhdfc' }] },
  ];
  for (const x of mdu) onExp({ ...x, who: 'sneha', trip: 'mdu', loggedAfterMin: x.key === 'mdu1' ? 180 : 3 });
  on(at(-13, '19:10'), () => as('sneha', at(-13, '19:10'), ctx => trips.endTrip(ctx, T.mdu)));
  on(at(-12, '10:30'), async () => { for (const k of ['mdu1', 'mdu2', 'mdu3', 'mdu4']) await verify('meera', k, at(-12, '10:30')); });
  on(at(-11, '12:00'), () => pay('meera', 'mdu', 'sneha', at(-11, '12:00'), 9340, 'HDFC/NEFT/0922/40218'));

  /* === Product demo · Chennai: entered after it began (FR-TRIP-10), reimbursed === */
  on(at(-13, '10:40'), () => as('arjun', at(-13, '10:40'), async ctx => { T.demo = (await trips.createTrip(ctx, { name: 'Product demo · Chennai', type: 'same_day', purpose: 'client_meeting', clientEvent: 'Apollo Speciality, Vanagaram', scheduledStart: at(-13, '10:00'), tentativeEnd: at(-13, '18:00'), primaryCity: 'Chennai' })).id; }));
  onExp({ key: 'demo1', who: 'arjun', trip: 'demo', at: at(-13, '11:55'), cat: 'cab', desc: 'Cab with demo kit', rs: 1150, mode: 'upi', receipts: [{ kind: 'upi', payee: 'CityRide Cabs', vpa: 'cityride@okhdfc' }] });
  onExp({ key: 'demo2', who: 'arjun', trip: 'demo', at: at(-13, '16:05'), cat: 'printing', desc: 'Brochure printing', rs: 1850, mode: 'upi', receipts: [{ kind: 'bill', merchant: 'Print Hub', address: 'Anna Nagar, Chennai 600040', items: [['A4 colour brochure x 100', 1]], tax: 18 }] });
  on(at(-13, '18:25'), () => as('arjun', at(-13, '18:25'), ctx => trips.endTrip(ctx, T.demo)));
  on(at(-12, '11:00'), async () => { await verify('meera', 'demo1', at(-12, '11:00')); await verify('meera', 'demo2', at(-12, '11:01')); });
  on(at(-10, '16:00'), () => pay('meera', 'demo', 'arjun', at(-10, '16:00'), 3000, 'UPI/427118830021', 'upi'));

  /* === Tender submission · Chennai: Joseph, closed, a late entry, waiting for finance === */
  on(at(-14, '09:00'), () => as('joseph', at(-14, '09:00'), async ctx => { T.tender = (await trips.createTrip(ctx, { name: 'Tender submission · Chennai', type: 'multi_day', purpose: 'other', clientEvent: 'Tamil Nadu Medical Services Corp.', scheduledStart: at(-12, '07:00'), tentativeEnd: at(-11, '21:00'), primaryCity: 'Chennai' })).id; }));
  on(at(-12, '06:40'), () => as('joseph', at(-12, '06:40'), ctx => trips.startTrip(ctx, T.tender)));
  onExp({ key: 'ten1', who: 'joseph', trip: 'tender', at: at(-12, '09:05'), cat: 'courier', desc: 'Tender documents courier', rs: 1450, mode: 'upi', receipts: [{ kind: 'bill', merchant: 'Swift Courier', address: 'Egmore, Chennai 600008', items: [['Document courier, same day', 1]], tax: 18 }] });
  onExp({ key: 'ten2', who: 'joseph', trip: 'tender', at: at(-12, '13:20'), cat: 'printing', desc: 'Bound copies of the bid', rs: 2280, mode: 'cash', receipts: [{ kind: 'bill', merchant: 'Print Hub', address: 'Anna Nagar, Chennai 600040', items: [['Spiral binding x 6', 1], ['B/W print x 600', 2]], tax: 18, pay: 'Paid in cash' }] });
  onExp({ key: 'ten3', who: 'joseph', trip: 'tender', at: at(-11, '20:00'), cat: 'meals', desc: 'Dinner', rs: 590, mode: 'upi', receipts: [{ kind: 'bill', merchant: 'Saravana Tiffin Centre', address: 'T Nagar, Chennai', items: [['Mini meals', 1], ['Filter coffee', 1]], tax: 5 }] });
  on(at(-11, '21:30'), () => as('joseph', at(-11, '21:30'), ctx => trips.endTrip(ctx, T.tender)));
  onExp({ key: 'ten4', who: 'joseph', trip: 'tender', at: at(-11, '18:30'), cat: 'cab', desc: 'Cab back from TNMSC office', rs: 2500, mode: 'upi', loggedAfterMin: 930, receipts: [{ kind: 'upi', payee: 'CityRide Cabs', vpa: 'cityride@okhdfc' }] });

  /* === Service visit · Madurai: cancelled before it began === */
  on(at(-9, '09:30'), () => as('imran', at(-9, '09:30'), async ctx => { T.svc = (await trips.createTrip(ctx, { name: 'Service visit · Madurai', type: 'multi_day', purpose: 'installation', clientEvent: 'Velammal Medical College Hospital', scheduledStart: at(-5, '09:00'), tentativeEnd: at(-4, '18:00'), primaryCity: 'Madurai' })).id; }));
  on(at(-7, '17:15'), () => as('imran', at(-7, '17:15'), ctx => trips.cancelTrip(ctx, T.svc, 'The hospital postponed the service window.')));

  /* === Distributor review · Coimbatore: over budget, extended, owner later deactivated === */
  on(at(-14, '10:00'), () => as('nikhil', at(-14, '10:00'), async ctx => { T.cbe = (await trips.createTrip(ctx, { name: 'Distributor review · Coimbatore', type: 'multi_day', purpose: 'client_meeting', clientEvent: 'Kovai Medical Distributors', scheduledStart: at(-10, '09:00'), tentativeEnd: at(-4, '18:00'), primaryCity: 'Coimbatore', inviteeIds: [U.sneha.id] })).id; }));
  on(at(-14, '12:00'), () => as('sneha', at(-14, '12:00'), ctx => trips.respond(ctx, T.cbe, true)));
  on(at(-13, '11:00'), () => web('meera', at(-13, '11:00'), ctx => fin.setBudget(ctx, T.cbe, { type: 'pool', amountPaise: 20000_00, note: 'Quarterly distributor review' })));
  on(at(-10, '08:10'), () => as('nikhil', at(-10, '08:10'), ctx => trips.startTrip(ctx, T.cbe)));
  on(at(-10, '09:00'), () => tick(at(-10, '09:00')));
  const cbe: Array<Omit<Exp, 'trip'>> = [
    { key: 'cbe1', who: 'nikhil', at: at(-10, '08:40'), cat: 'train', desc: 'Train to Coimbatore', rs: 1450, mode: 'upi', receipts: [{ kind: 'ticket', carrier: 'Southern Rail', mode: 'train', fromCode: 'MAS', toCode: 'CBE', from: 'Chennai Central', to: 'Coimbatore Jn', dep: '06:10', arr: '13:15', pnr: '4410982771', number: '12675 Kovai Exp' }] },
    { key: 'cbe2', who: 'nikhil', at: at(-9, '12:00'), cat: 'accommodation', desc: 'Hotel, four nights', rs: 9800, mode: 'card', receipts: [{ kind: 'bill', merchant: 'Hotel Kovai Grand', address: 'Race Course Road, Coimbatore 641018', gstin: '33AABCK5520Q1Z8', items: [['Deluxe room x 4 nights', 1]], tax: 12, pay: 'Paid by card ••1180' }] },
    { key: 'cbe3', who: 'sneha', at: at(-9, '13:00'), cat: 'accommodation', desc: 'Hotel, three nights', rs: 4900, mode: 'upi', receipts: [{ kind: 'bill', merchant: 'Hotel Kovai Grand', address: 'Race Course Road, Coimbatore 641018', gstin: '33AABCK5520Q1Z8', items: [['Standard room x 3 nights', 1]], tax: 12 }] },
    { key: 'cbe4', who: 'nikhil', at: at(-8, '21:00'), cat: 'client_entertainment', desc: 'Dinner with distributor', rs: 2100, mode: 'card', receipts: [{ kind: 'bill', merchant: 'Annalakshmi', address: 'Race Course, Coimbatore', items: [['Dinner for 3', 3], ['Beverages', 1]], tax: 5, pay: 'Paid by card ••1180' }] },
    { key: 'cbe5', who: 'nikhil', at: at(-6, '10:00'), cat: 'cab', desc: 'Cab for dealer visits', rs: 1650, mode: 'upi', receipts: [{ kind: 'upi', payee: 'CityRide Cabs', vpa: 'cityride@okhdfc' }] },
    { key: 'cbe6', who: 'sneha', at: at(-5, '16:00'), cat: 'fuel_toll', desc: 'Fuel for the Tiruppur leg', rs: 1700, mode: 'upi', receipts: [{ kind: 'bill', merchant: 'Kongu Fuels', address: 'Avinashi Road, Coimbatore', items: [['Petrol 16.2 L', 1]], pay: 'Paid by UPI' }] },
  ];
  for (const x of cbe) onExp({ ...x, trip: 'cbe' });
  on(at(-4, '18:00'), () => tick(at(-4, '18:00')));
  on(at(-3, '06:05'), () => tick(at(-3, '06:05')));
  on(at(-2, '17:30'), () => web('farah', at(-2, '17:30'), ctx => admin.deactivate(ctx, U.nikhil.id)));
  on(at(-2, '18:10'), () => tick(at(-2, '18:10')));

  /* === Cath lab install · Hyderabad: closed, over the pool; one reimbursed, one verified, one with a query answered === */
  on(at(-9, '10:00'), () => as('suresh', at(-9, '10:00'), async ctx => { T.cath = (await trips.createTrip(ctx, { name: 'Cath lab install · Hyderabad', type: 'multi_day', purpose: 'installation', clientEvent: 'Yashoda Hospitals, Secunderabad', scheduledStart: at(-4, '08:00'), tentativeEnd: at(-2, '20:00'), primaryCity: 'Hyderabad', inviteeIds: [U.imran.id, U.deepa.id] })).id; }));
  on(at(-9, '11:20'), () => as('imran', at(-9, '11:20'), ctx => trips.respond(ctx, T.cath, true)));
  on(at(-9, '15:45'), () => as('deepa', at(-9, '15:45'), ctx => trips.respond(ctx, T.cath, true)));
  on(at(-8, '12:00'), () => web('meera', at(-8, '12:00'), ctx => fin.setBudget(ctx, T.cath, { type: 'pool', amountPaise: 40000_00, note: 'Install team travel and stay' })));
  on(at(-8, '12:05'), () => web('meera', at(-8, '12:05'), ctx => fin.setBudget(ctx, T.cath, { type: 'individual', memberUserId: U.imran.id, amountPaise: 8000_00, note: 'Imran stays a day longer for calibration' })));
  on(at(-4, '05:45'), () => as('suresh', at(-4, '05:45'), ctx => trips.startTrip(ctx, T.cath)));
  on(at(-4, '08:00'), () => tick(at(-4, '08:00')));
  const cath: Array<Omit<Exp, 'trip'>> = [
    { key: 'ca1', who: 'suresh', at: at(-4, '06:30'), cat: 'airfare', desc: 'Flight to Hyderabad', rs: 7800, mode: 'card', receipts: [{ kind: 'ticket', carrier: 'SkyLark Airways', mode: 'flight', fromCode: 'MAA', toCode: 'HYD', from: 'Chennai', to: 'Hyderabad', dep: '07:10', arr: '08:25', pnr: 'MV2R9D', number: 'SL 511' }] },
    { key: 'cd1', who: 'deepa', at: at(-4, '06:35'), cat: 'airfare', desc: 'Flight to Hyderabad', rs: 7600, mode: 'card', source: 'pool', receipts: [{ kind: 'ticket', carrier: 'SkyLark Airways', mode: 'flight', fromCode: 'MAA', toCode: 'HYD', from: 'Chennai', to: 'Hyderabad', dep: '07:10', arr: '08:25', pnr: 'MV2R9E', number: 'SL 511' }] },
    { key: 'ca2', who: 'suresh', at: at(-4, '14:00'), cat: 'accommodation', desc: 'Hotel, three rooms for two nights', rs: 14400, mode: 'card', receipts: [{ kind: 'bill', merchant: 'Hotel Secunderabad Park', address: 'SD Road, Secunderabad 500003', gstin: '36AAHCS8810L1Z4', items: [['Deluxe room x 3 x 2 nights', 1]], tax: 12, pay: 'Paid by card ••7712' }] },
    { key: 'ca3', who: 'suresh', at: at(-3, '09:00'), cat: 'cab', desc: 'Tempo for equipment to hospital', rs: 2200, mode: 'upi', receipts: [{ kind: 'upi', payee: 'Sri Sai Transport', vpa: 'srisaitransport@okaxis' }] },
    { key: 'ca4', who: 'suresh', at: at(-3, '10:00'), cat: 'other', desc: 'Crane hire for the C-arm', rs: 6500, mode: 'company', receipts: [{ kind: 'bill', merchant: 'Hyderabad Crane Services', address: 'Balanagar, Hyderabad', gstin: '36AAGFH2271R1ZK', items: [['Crane hire, 4 hours', 1]], tax: 18, pay: 'Billed to Xelements Health' }] },
    { key: 'ci1', who: 'imran', at: at(-3, '11:00'), cat: 'other', desc: 'Calibration tools', rs: 2300, mode: 'upi', source: 'individual', receipts: [{ kind: 'bill', merchant: 'Deccan Tools', address: 'Ranigunj, Secunderabad', items: [['Torque driver set', 2], ['Cable ties, pack', 1]], tax: 18 }] },
    { key: 'ca5', who: 'suresh', at: at(-3, '16:00'), cat: 'courier', desc: 'Spare parts courier from Chennai', rs: 3600, mode: 'upi', receipts: [{ kind: 'bill', merchant: 'Swift Courier', address: 'Egmore, Chennai 600008', items: [['Express cargo 14 kg', 1]], tax: 18 }] },
    { key: 'cd2', who: 'deepa', at: at(-3, '21:00'), cat: 'meals', desc: 'Team dinner', rs: 2450, mode: 'upi', source: 'pool', receipts: [{ kind: 'bill', merchant: 'Paradise Kitchen', address: 'Secunderabad', items: [['Biryani x 3', 3], ['Starters', 2], ['Soft drinks', 1]], tax: 5 }] },
    { key: 'ci2', who: 'imran', at: at(-2, '13:00'), cat: 'meals', desc: 'Lunch during calibration', rs: 1900, mode: 'upi', source: 'individual', receipts: [{ kind: 'bill', merchant: 'Hotel Minerva', address: 'Secunderabad', items: [['Lunch buffet x 2', 2], ['Juice', 1]], tax: 5 }] },
    { key: 'ca6', who: 'suresh', at: at(-2, '17:00'), cat: 'fuel_toll', desc: 'Toll and parking', rs: 1900, mode: 'cash', receipts: [{ kind: 'bill', merchant: 'ORR Toll Plaza', address: 'Shamshabad, Hyderabad', items: [['Toll, LCV', 3], ['Parking', 1]], pay: 'Paid in cash' }] },
    { key: 'cd3', who: 'deepa', at: at(-2, '18:30'), cat: 'cab', desc: 'Cab to the airport', rs: 1850, mode: 'upi', source: 'pool', receipts: [{ kind: 'upi', payee: 'CityRide Cabs', vpa: 'cityride@okhdfc' }] },
  ];
  for (const x of cath) onExp({ ...x, trip: 'cath' });
  on(at(-2, '20:45'), () => as('imran', at(-2, '20:45'), ctx => trips.endTrip(ctx, T.cath)));
  on(at(-2, '21:00'), () => as('deepa', at(-2, '21:00'), ctx => trips.endTrip(ctx, T.cath)));
  on(at(-2, '21:10'), () => as('suresh', at(-2, '21:10'), ctx => trips.endTrip(ctx, T.cath)));
  on(at(-1, '10:00'), async () => {
    for (const k of ['cd1', 'cd2', 'cd3']) await verify('meera', k, at(-1, '10:00'));
    await verify('meera', 'ci1', at(-1, '10:10'));
    await verify('meera', 'ci2', at(-1, '10:12'), 1500, 'Meal limit is ₹750 a person; two people.');
    await verify('meera', 'ca1', at(-1, '10:20'));
    await verify('meera', 'ca2', at(-1, '10:21'));
    await verify('meera', 'ca3', at(-1, '10:22'));
    await verify('meera', 'ca4', at(-1, '10:23'));
    await verify('meera', 'ca6', at(-1, '10:24'));
    await query('meera', 'ca5', at(-1, '10:30'), 'Please attach the courier company’s GST invoice. The photo is the counter slip only.');
  });
  on(at(-1, '18:05'), () => reply('suresh', 'ca5', at(-1, '18:05'), 'Invoice attached. The counter slip was all they gave at pickup.', { r: { kind: 'bill', merchant: 'Swift Courier Pvt Ltd', address: 'Tax invoice · Egmore, Chennai 600008', gstin: '33AAECS9912P1Z6', items: [['Express cargo 14 kg, MAA to HYD', 1]], tax: 18, pay: 'Paid by UPI' }, rs: 3600 }));
  on(at(0, '11:00'), () => pay('meera', 'cath', 'deepa', at(0, '11:00'), 11900, 'HDFC/NEFT/0928/77121'));

  /* === Clinical training · Kochi: running, no budget === */
  on(at(-8, '10:00'), () => as('lakshmi', at(-8, '10:00'), async ctx => { T.kochi = (await trips.createTrip(ctx, { name: 'Clinical training · Kochi', type: 'multi_day', purpose: 'training', clientEvent: 'Amrita Hospital cath lab team', scheduledStart: at(-2, '09:00'), tentativeEnd: at(1, '17:00'), primaryCity: 'Kochi', inviteeIds: [U.farhan.id] })).id; }));
  on(at(-8, '11:00'), () => as('farhan', at(-8, '11:00'), ctx => trips.respond(ctx, T.kochi, true)));
  on(at(-2, '09:00'), () => tick(at(-2, '09:00')));
  const kochi: Array<Omit<Exp, 'trip'>> = [
    { key: 'ko1', who: 'lakshmi', at: at(-3, '21:10'), cat: 'train', desc: 'Train to Kochi', rs: 1850, mode: 'upi', receipts: [{ kind: 'ticket', carrier: 'Southern Rail', mode: 'train', fromCode: 'MAS', toCode: 'ERS', from: 'Chennai Central', to: 'Ernakulam Jn', dep: '21:25', arr: '09:10', pnr: '4238817745', number: '12623 Trivandrum Mail' }] },
    { key: 'ko2', who: 'farhan', at: at(-2, '09:40'), cat: 'cab', desc: 'Station to hospital', rs: 450, mode: 'upi', receipts: [{ kind: 'upi', payee: 'CityRide Cabs', vpa: 'cityride@okhdfc' }] },
    { key: 'ko3', who: 'lakshmi', at: at(-2, '13:00'), cat: 'accommodation', desc: 'Hotel, three nights', rs: 5400, mode: 'card', receipts: [{ kind: 'bill', merchant: 'Marine Drive Residency', address: 'Marine Drive, Kochi 682031', gstin: '32AAKCM5561D1Z9', items: [['Standard room x 3 nights', 1]], tax: 12, pay: 'Paid by card ••3380' }] },
    { key: 'ko4', who: 'farhan', at: at(-1, '11:00'), cat: 'printing', desc: 'Training handouts', rs: 780, mode: 'cash', receipts: [{ kind: 'bill', merchant: 'Copy Corner', address: 'Edappally, Kochi', items: [['Colour print x 60', 1]], tax: 18, pay: 'Paid in cash' }] },
    { key: 'ko5', who: 'lakshmi', at: at(-1, '13:10'), cat: 'meals', desc: 'Lunch', rs: 620, mode: 'upi', receipts: [{ kind: 'bill', merchant: 'Kayees Rahmathulla', address: 'Mattancherry, Kochi', items: [['Biryani', 1], ['Lime juice', 1]], tax: 5 }] },
    { key: 'ko6', who: 'farhan', at: at(0, '13:00'), cat: 'meals', desc: 'Lunch', rs: 540, mode: 'upi', receipts: [{ kind: 'bill', merchant: 'Kayees Rahmathulla', address: 'Mattancherry, Kochi', items: [['Meals', 1], ['Tea', 1]], tax: 5 }] },
  ];
  for (const x of kochi) onExp({ ...x, trip: 'kochi' });

  /* === Supplier audit · Visakhapatnam: a finance user on the trip (FR-VER-10) === */
  on(at(-7, '10:00'), () => as('vikram', at(-7, '10:00'), async ctx => { T.vizag = (await trips.createTrip(ctx, { name: 'Supplier audit · Visakhapatnam', type: 'multi_day', purpose: 'audit', clientEvent: 'Coastal Polymers Pvt Ltd', scheduledStart: at(-1, '07:00'), tentativeEnd: at(1, '20:00'), primaryCity: 'Visakhapatnam', inviteeIds: [U.harish.id] })).id; }));
  on(at(-7, '11:30'), () => as('harish', at(-7, '11:30'), ctx => trips.respond(ctx, T.vizag, true)));
  on(at(-6, '12:00'), () => web('meera', at(-6, '12:00'), ctx => fin.setBudget(ctx, T.vizag, { type: 'pool', amountPaise: 25000_00, note: 'Annual supplier audit' })));
  on(at(-1, '07:00'), () => tick(at(-1, '07:00')));
  const vizag: Array<Omit<Exp, 'trip'>> = [
    { key: 'vz1', who: 'vikram', at: at(-2, '19:00'), cat: 'airfare', desc: 'Flights, Chennai to Vizag, two people', rs: 6200, mode: 'card', receipts: [{ kind: 'ticket', carrier: 'SkyLark Airways', mode: 'flight', fromCode: 'MAA', toCode: 'VTZ', from: 'Chennai', to: 'Visakhapatnam', dep: '06:00', arr: '07:25', pnr: 'HT7N2C', number: 'SL 743' }] },
    { key: 'vz2', who: 'vikram', at: at(-1, '07:40'), cat: 'cab', desc: 'Airport to the plant', rs: 650, mode: 'upi', receipts: [{ kind: 'upi', payee: 'CityRide Cabs', vpa: 'cityride@okhdfc' }] },
    { key: 'vz3', who: 'vikram', at: at(-1, '13:00'), cat: 'accommodation', desc: 'Hotel, two rooms', rs: 3800, mode: 'card', receipts: [{ kind: 'bill', merchant: 'Beach Road Suites', address: 'RK Beach Road, Visakhapatnam 530002', gstin: '37AAGCB3308F1ZT', items: [['Standard room x 2', 1]], tax: 12, pay: 'Paid by card ••5521' }] },
    { key: 'vz4', who: 'harish', at: at(0, '13:00'), cat: 'meals', desc: 'Lunch at the plant canteen', rs: 800, mode: 'cash', receipts: [{ kind: 'bill', merchant: 'Coastal Polymers Canteen', address: 'Parawada, Visakhapatnam', items: [['Meals x 2', 2], ['Tea', 1]], pay: 'Paid in cash' }] },
  ];
  for (const x of vizag) onExp({ ...x, trip: 'vizag' });

  /* === MedTech Expo · Bengaluru & Mysuru: the main story, day 2 of 4 === */
  on(at(-6, '11:00'), () => as('arjun', at(-6, '11:00'), async ctx => {
    T.mt = (await trips.createTrip(ctx, { name: 'MedTech Expo · Bengaluru & Mysuru', type: 'multi_day', purpose: 'conference', clientEvent: 'MedTech India Expo 2026', scheduledStart: at(-1, '09:00'), tentativeEnd: at(2, '18:00'), primaryCity: 'Bengaluru', notes: 'Booth B-14, Hall 3. Demo units ship on the Tuesday before.', inviteeIds: [U.divya.id, U.karthik.id, U.rohan.id, U.priya.id] })).id;
  }));
  on(at(-6, '11:05'), () => as('arjun', at(-6, '11:05'), async ctx => {
    const primary = (await locs.tripLocations(ctx, T.mt))[0];
    L.blr = (await locs.updateLocation(ctx, primary.id, { venue: 'BIEC, Hall 3', address: 'Tumkur Road, Madavara, Bengaluru 562123', departureDate: day(1) })).id;
    L.mys = (await locs.addLocation(ctx, T.mt, { clientId: crypto.randomUUID(), city: 'Mysuru', venue: 'JSS Hospital', address: 'MG Road, Agrahara, Mysuru 570004', arrivalDate: day(1), departureDate: day(2) })).id;
  }));
  on(at(-6, '12:10'), () => as('divya', at(-6, '12:10'), ctx => trips.respond(ctx, T.mt, true)));
  on(at(-6, '15:40'), () => as('karthik', at(-6, '15:40'), ctx => trips.respond(ctx, T.mt, true)));
  on(at(-5, '10:05'), () => as('rohan', at(-5, '10:05'), ctx => trips.respond(ctx, T.mt, true)));
  on(at(-5, '18:30'), () => as('priya', at(-5, '18:30'), ctx => trips.respond(ctx, T.mt, false)));
  on(at(-5, '11:00'), () => web('meera', at(-5, '11:00'), ctx => fin.setBudget(ctx, T.mt, { type: 'pool', amountPaise: 50000_00, note: 'Expo budget approved by the Sales head' })));
  on(at(-5, '11:04'), () => web('meera', at(-5, '11:04'), ctx => fin.setBudget(ctx, T.mt, { type: 'individual', memberUserId: U.divya.id, amountPaise: 15000_00, note: 'Divya flies in from the Delhi office' })));
  const mt: Array<Omit<Exp, 'trip'>> = [
    { key: 'd3', who: 'divya', at: at(-3, '17:20'), cat: 'airfare', desc: 'Flight to Bengaluru', rs: 9500, mode: 'card', source: 'individual', receipts: [{ kind: 'ticket', carrier: 'SkyLark Airways', mode: 'flight', fromCode: 'DEL', toCode: 'BLR', from: 'New Delhi', to: 'Bengaluru', dep: `${day(-2).slice(8)}/${day(-2).slice(5, 7)} 16:05`, arr: '18:55', pnr: 'X7K2QM', number: 'SL 2127' }] },
    { key: 'a4', who: 'arjun', at: at(-2, '21:10'), cat: 'cab', desc: 'Airport cab', rs: 780, mode: 'upi', receipts: [{ kind: 'upi', payee: 'CityRide Cabs', vpa: 'cityride@okhdfc' }] },
    { key: 'k1', who: 'karthik', at: at(-1, '08:20'), cat: 'cab', desc: 'Airport cab', rs: 800, mode: 'upi', receipts: [{ kind: 'upi', payee: 'CityRide Cabs', vpa: 'cityride@okhdfc' }] },
    { key: 'd2', who: 'divya', at: at(-1, '08:40'), cat: 'cab', desc: 'Airport cab', rs: 650, mode: 'upi', source: 'pool', receipts: [{ kind: 'upi', payee: 'CityRide Cabs', vpa: 'cityride@okhdfc' }] },
    { key: 'a3', who: 'arjun', at: at(-1, '10:15'), cat: 'printing', desc: 'Booth printing', rs: 4300, mode: 'company', loc: 'blr', receipts: [{ kind: 'bill', merchant: 'Signage Studio', address: 'Peenya Industrial Area, Bengaluru', gstin: '29AAQFS6620B1ZM', items: [['Backdrop 10 x 8 ft', 3], ['Standees x 2', 1]], tax: 18, pay: 'Billed to Xelements Health' }] },
    { key: 'a2', who: 'arjun', at: at(-1, '14:05'), cat: 'accommodation', desc: 'Hotel, three rooms', rs: 12000, mode: 'upi', loc: 'blr', receipts: [{ kind: 'bill', merchant: 'Hotel Garden Residency', address: 'Tumkur Road, Yeshwanthpur\nBengaluru 560022', gstin: '29AABCH1234F1Z5', items: [['Deluxe room x 3 (1 night)', 1]], tax: 12 }] },
    { key: 'r1', who: 'rohan', at: at(-1, '16:30'), cat: 'printing', desc: 'Expo stall supplies', rs: 1150, mode: 'cash', loc: 'blr', receipts: [{ kind: 'bill', merchant: 'Stationery World', address: 'Yeshwanthpur, Bengaluru', items: [['Visitor forms x 200', 2], ['Pens, box', 1], ['Tape and ties', 1]], tax: 18, pay: 'Paid in cash' }] },
    { key: 'r2', who: 'rohan', at: at(-1, '20:30'), cat: 'meals', desc: 'Dinner', rs: 540, mode: 'upi', loc: 'blr', receipts: [{ kind: 'bill', merchant: 'Udupi Grand', address: 'Yeshwanthpur, Bengaluru', items: [['Thali', 1], ['Buttermilk', 1]], tax: 5 }] },
    { key: 'd1', who: 'divya', at: at(-1, '21:40'), cat: 'client_entertainment', desc: 'Client dinner', rs: 3200, mode: 'upi', source: 'pool', loc: 'blr', remarks: 'Dinner with Dr Rao and Dr Shetty after the demo.', receipts: [{ kind: 'bill', merchant: 'The Malabar House', address: 'Malleshwaram, Bengaluru 560003', gstin: '29AAHFM7813C1Z1', items: [['Dinner for 4', 4], ['Beverages', 1]], tax: 5 }] },
    { key: 'k2', who: 'karthik', at: at(0, '12:50'), cat: 'meals', desc: 'Lunch at the expo', rs: 620, mode: 'upi', loc: 'blr', pendingUpload: true, receipts: [{ kind: 'bill', merchant: 'BIEC Food Court', address: 'Hall 3, BIEC, Bengaluru', items: [['Meals', 1], ['Coffee', 1]], tax: 5 }] },
    { key: 'a1', who: 'arjun', at: at(0, '13:30'), cat: 'meals', desc: 'Team lunch', rs: 1640, mode: 'card', loc: 'blr', receipts: [{ kind: 'bill', merchant: 'BIEC Food Court', address: 'Hall 3, BIEC, Bengaluru', items: [['Card slip', 1]], pay: 'Paid by card ••0921' }] },
  ];
  on(at(-2, '20:00'), () => as('arjun', at(-2, '20:00'), ctx => trips.startTrip(ctx, T.mt)));
  on(at(-1, '08:10'), () => as('karthik', at(-1, '08:10'), ctx => trips.startTrip(ctx, T.mt)));
  on(at(-1, '09:00'), () => tick(at(-1, '09:00')));
  for (const x of mt) onExp({ ...x, trip: 'mt' });
  on(at(0, '09:30'), async () => { await verify('meera', 'a2', at(0, '09:30')); await verify('meera', 'k1', at(0, '09:31')); });
  on(at(0, '14:10'), () => query('meera', 'a1', at(0, '14:10'), 'The photo shows only the card slip. Please attach the itemised bill.'));

  /* === Scheduled trips === */
  on(at(-3, '16:00'), () => as('rohan', at(-3, '16:00'), async ctx => { T.dealer = (await trips.createTrip(ctx, { name: 'Dealer onboarding · Mysuru', type: 'same_day', purpose: 'client_meeting', clientEvent: 'Mysuru Surgicals', scheduledStart: at(1, '10:00'), tentativeEnd: at(1, '17:00'), primaryCity: 'Mysuru', inviteeIds: [U.karthik.id] })).id; }));
  on(at(-2, '10:00'), () => as('arjun', at(-2, '10:00'), async ctx => { T.pune = (await trips.createTrip(ctx, { name: 'KOL visit · Pune', type: 'multi_day', purpose: 'client_meeting', clientEvent: 'Dr Kulkarni Heart Clinic', scheduledStart: at(7, '08:00'), tentativeEnd: at(8, '20:00'), primaryCity: 'Pune', inviteeIds: [U.divya.id, U.rohan.id] })).id; }));
  on(at(-2, '11:00'), () => as('divya', at(-2, '11:00'), ctx => trips.respond(ctx, T.pune, true)));
  onExp({ key: 'pune1', who: 'arjun', trip: 'pune', at: at(-1, '21:50'), cat: 'airfare', desc: 'Flight to Pune, booked early', rs: 6200, mode: 'card', receipts: [{ kind: 'ticket', carrier: 'SkyLark Airways', mode: 'flight', fromCode: 'MAA', toCode: 'PNQ', from: 'Chennai', to: 'Pune', dep: `${day(7).slice(8)}/${day(7).slice(5, 7)} 06:05`, arr: '07:55', pnr: 'KP8W3Z', number: 'SL 6531' }] });
  on(at(-1, '15:00'), () => as('rohan', at(-1, '15:00'), async ctx => { T.cme = (await trips.createTrip(ctx, { name: 'Cardiology CME · Kochi', type: 'multi_day', purpose: 'conference', clientEvent: 'Kerala Cardiology CME 2026', scheduledStart: at(11, '09:00'), tentativeEnd: at(12, '17:00'), primaryCity: 'Kochi', inviteeIds: [U.sneha.id, U.priya.id] })).id; }));
  on(at(-1, '16:30'), () => as('sneha', at(-1, '16:30'), ctx => trips.respond(ctx, T.cme, true)));
  on(at(-1, '18:00'), () => as('karthik', at(-1, '18:00'), async ctx => { T.hosur = (await trips.createTrip(ctx, { name: 'Warehouse audit · Hosur', type: 'same_day', purpose: 'audit', clientEvent: 'Xelements central warehouse', scheduledStart: at(13, '09:00'), tentativeEnd: at(13, '18:00'), primaryCity: 'Hosur' })).id; }));
}

async function wipe() {
  const tables = ['audit_log', 'notifications', 'exports', 'payments', 'attachments', 'expense_messages', 'expenses', 'budget_changes', 'budgets', 'locations', 'trip_members', 'trips', 'ref_counters', 'device_tokens', 'otp_codes', 'refresh_tokens', 'user_settings', 'users', 'departments'];
  await db.execute(sql.raw(`truncate ${tables.join(', ')} restart identity cascade`));
  if (config.STORAGE_DRIVER === 'local') {
    for (const dir of [config.STORAGE_DIR]) {
      const full = path.resolve(dir);
      for (const sub of ['receipts', 'documents', 'exports']) await fs.rm(path.join(full, sub), { recursive: true, force: true });
    }
  }
}

export async function seed(opts: { exports?: boolean; quiet?: boolean; tinyReceipts?: boolean } = {}) {
  if (config.NODE_ENV === 'production' && !process.argv.includes('--force')) throw new Error('Refusing to seed a production database. Pass --force if you really mean it.');
  steps.length = 0;
  for (const m of [U, T, E, L] as Array<Record<string, unknown>>) for (const k of Object.keys(m)) delete m[k];
  seedN = 0;
  tinyReceipts = !!opts.tinyReceipts;
  await wipe();
  const hash = await hashPassword(DEMO_PASSWORD);
  const deptIds: Record<string, string> = {};
  for (const name of DEPTS) {
    const [d] = await db.insert(schema.departments).values({ name, createdAt: at(-90, '10:00'), updatedAt: at(-90, '10:00') }).returning();
    deptIds[name] = d.id;
  }
  for (const p of PEOPLE) {
    const [u] = await db.insert(schema.users).values({
      employeeCode: p.code, name: p.name, email: emailOf(p.key), phone: p.phone ?? null, designation: DESIGNATION[p.key] ?? null, departmentId: deptIds[p.dept],
      isFinance: !!p.finance, isAdmin: !!p.admin, passwordHash: hash, firstMobileLoginAt: p.neverSignedIn || p.admin ? null : at(-60, '09:30'),
      createdAt: at(-90, '10:00'), updatedAt: at(-90, '10:00'),
    }).returning();
    U[p.key] = u;
  }
  // References continue from where the year's register stood (the prototypes show EXP-2026-00097 onward).
  await db.insert(schema.refCounters).values({ year: Number(day(-24).slice(0, 4)), last: 96 }).onConflictDoNothing();

  story();
  steps.sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const s of steps) {
    try { await s.run(); } catch (e) {
      console.error(`seed step at ${s.at.toISOString()} failed`);
      throw e;
    }
  }
  await runScheduledWork(new Date());

  // Past exports: a final whole-trip package of the closed install trip, and Arjun's own claim from his phone.
  if (opts.exports !== false) {
    const x = await web('meera', new Date(), ctx => xs.requestExport(ctx, T.cath, { scope: 'trip_and_each', formats: ['pdf', 'xlsx', 'zip'] }, 'web'));
    await xs.runQueuedExports();
    const mtRef = (await db.select({ ref: schema.trips.ref }).from(schema.trips).where(eq(schema.trips.id, T.mt)))[0].ref;
    await as('arjun', at(0, '15:00'), ctx => xs.logDeviceExport(ctx, T.mt, { formats: ['pdf'], provisional: true, builtAt: at(0, '15:00'), files: [{ format: 'pdf', name: `${mtRef}_Arjun-Mehta_statement_PROVISIONAL.pdf`, size: 2_400_000 }] }));
    const ready = await xs.getExport(x.id);
    if (!opts.quiet) console.log(`export ${ready.status}${ready.error ? `: ${ready.error}` : ''}`);
  }
  if (!opts.quiet) {
    const counts = await db.execute(sql`select (select count(*) from trips) trips, (select count(*) from expenses) expenses, (select count(*) from attachments) files, (select count(*) from notifications) notifications, (select count(*) from audit_log) audit`);
    console.log('seeded', counts.rows[0], `day 0 = ${D0}`);
    console.log(`sign in as ${emailOf('arjun')} (mobile), ${emailOf('meera')} (finance web) or ${emailOf('farah')} (admin web), password ${DEMO_PASSWORD}`);
  }
  return { U, T, E, L, D0 };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  (async () => {
    await runMigrations();
    await seed({ exports: !process.argv.includes('--no-exports') });
    await pool.end();
  })().catch(async e => { console.error(e); await pool.end().catch(() => undefined); process.exit(1); });
}
