import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { db, schema } from '../src/db/client.js';
import { seed } from '../src/db/seed.js';
import { runQueuedExports } from '../src/modules/exports/service.js';
import { api, as, login } from './helpers.js';
import { zipEntries } from './zip-list.js';

let S: Awaited<ReturnType<typeof seed>>;
let ref = '';
beforeAll(async () => {
  S = await seed({ exports: false, quiet: true, tinyReceipts: true });
  ref = (await db.select().from(schema.trips).where(eq(schema.trips.id, S.T.mt)))[0].ref;
});

const binary = (res: import('supertest').Response, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
async function download(token: string, id: string, format: string) {
  return api().get(`/api/v1/exports/${id}/download/${format}`).set('Authorization', `Bearer ${token}`).buffer(true).parse(binary as never);
}
async function cellsOf(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const out: string[] = [];
  wb.eachSheet(ws => ws.eachRow(r => r.eachCell(c => out.push(String(c.value ?? '')))));
  return { sheets: wb.worksheets.map(w => w.name), text: out.join('\n') };
}

describe('export preview (W08, FR-EXPT-08/10)', () => {
  it('marks an unverified member export Provisional and lists the receipt still on the phone', async () => {
    const meera = as(await login('meera', 'web'));
    const r = await meera.get(`/finance/trips/${S.T.mt}/exports/preview?scope=member&memberUserId=${S.U.karthik.id}`);
    expect(r.status).toBe(200);
    expect(r.body.provisional).toBe(true);
    expect(r.body.missingReceipts.map((m: { description: string }) => m.description)).toEqual(['Lunch at the expo']);
    expect(r.body.deliverables.map((d: { name: string }) => d.name)).toEqual([
      `${ref}_Karthik-Iyer_statement_PROVISIONAL.pdf`, `${ref}_Karthik-Iyer_statement_PROVISIONAL.xlsx`, `${ref}_Karthik-Iyer_PROVISIONAL.zip`,
    ]);
    expect(r.body.zipPaths.join('\n')).not.toContain('Divya');
  });

  it('restricts to one location or a date range (FR-EXPT-11)', async () => {
    const meera = as(await login('meera', 'web'));
    const snap = await meera.get(`/finance/trips/${S.T.mt}`);
    const blr = snap.body.locations.find((l: { city: string }) => l.city === 'Bengaluru');
    const r = await meera.get(`/finance/trips/${S.T.mt}/exports/preview?scope=trip&locationId=${blr.id}&formats=pdf`);
    expect(r.body.limitLabel).toContain('Bengaluru');
    expect(r.body.deliverables[0].name).toBe(`${ref}_Trip-statement_Bengaluru_PROVISIONAL.pdf`);
    const bad = await meera.get(`/finance/trips/${S.T.mt}/exports/preview?scope=trip&dateFrom=2026-10-05&dateTo=2026-10-01`);
    expect(bad.status).toBe(400);
  });
});

describe('building exports (FR-EXPT-01..07)', () => {
  it('builds one member’s package with none of another member’s individual data (FR-EXPT-04)', async () => {
    const s = await login('meera', 'web');
    const meera = as(s);
    const q = await meera.post(`/finance/trips/${S.T.mt}/exports`, { scope: 'member', memberUserId: S.U.karthik.id, formats: ['pdf', 'xlsx', 'zip'] });
    expect(q.status).toBe(202);
    expect(q.body.status).toBe('queued');
    await runQueuedExports();
    const x = await meera.get(`/exports/${q.body.id}`);
    expect(x.body.status).toBe('ready');
    expect(x.body.files.map((f: { format: string }) => f.format)).toEqual(['pdf', 'xlsx', 'zip']);

    const zip = await download(s.token, q.body.id, 'zip');
    expect(zip.status).toBe(200);
    expect(zip.headers['content-disposition']).toContain(`${ref}_Karthik-Iyer_PROVISIONAL.zip`);
    const names = zipEntries(zip.body as Buffer);
    expect(names.every(n => n.startsWith(`${ref}_Karthik-Iyer_PROVISIONAL/`))).toBe(true);
    expect(names).toContain(`${ref}_Karthik-Iyer_PROVISIONAL/${ref}_Karthik-Iyer_statement_PROVISIONAL.pdf`);
    expect(names.some(n => /\/Receipts\/.*_Local-travel-cab_800_1\.jpg$/.test(n))).toBe(true);
    expect(names.join('\n')).not.toMatch(/Divya|Arjun|Rohan/);

    const xlsx = await download(s.token, q.body.id, 'xlsx');
    const { sheets, text } = await cellsOf(xlsx.body as Buffer);
    expect(sheets).toEqual(['Summary', 'Budgets', 'Expenses', 'Payments and queries']);
    expect(text).toContain('Airport cab');
    expect(text).toContain('1 not received');
    expect(text).not.toContain('Divya');
    expect(text).not.toContain('Flight to Bengaluru');

    const pdf = await download(s.token, q.body.id, 'pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('lays out the whole trip and each member as SRS §8.3, naming every file by the rule (FR-EXPT-02/03)', async () => {
    const s = await login('meera', 'web');
    const q = await as(s).post(`/finance/trips/${S.T.cath}/exports`, { scope: 'trip_and_each', formats: ['zip'] });
    await runQueuedExports();
    const cref = (await db.select().from(schema.trips).where(eq(schema.trips.id, S.T.cath)))[0].ref;
    const zip = await download(s.token, q.body.id, 'zip');
    const names = zipEntries(zip.body as Buffer);
    const root = `${cref}_Cath-lab-install-Hyderabad_PROVISIONAL`;
    expect(names).toContain(`${root}/${cref}_Trip-statement_PROVISIONAL.pdf`);
    expect(names).toContain(`${root}/${cref}_Trip-statement_PROVISIONAL.xlsx`);
    expect(names).toContain(`${root}/Members/Deepa-Srinivasan/${cref}_Deepa-Srinivasan_statement.pdf`);
    expect(names.some(n => n.startsWith(`${root}/Members/Imran-Khan/Receipts/${cref}_Imran-Khan_Hyderabad_`) && n.endsWith('_Meals_1900_1.jpg'))).toBe(true);
    expect(names.some(n => n.startsWith(`${root}/Finance-documents/Deepa-Srinivasan/${cref}_Deepa-Srinivasan_Payment-proof_`))).toBe(true);
    // Suresh answered a query with a second file: both are in, numbered.
    expect(names.filter(n => /Suresh-Babu_Hyderabad_.*_Courier_3600_\d\.jpg$/.test(n))).toHaveLength(2);
  });

  it('lets a member export their own claim, and only they and finance can fetch it (FR-EXPT-09)', async () => {
    const k = await login('karthik');
    const q = await as(k).post(`/trips/${S.T.mt}/exports`, { formats: ['pdf'] });
    expect(q.status).toBe(202);
    await runQueuedExports();
    const x = await as(k).get(`/exports/${q.body.id}`);
    expect(x.body.status).toBe('ready');
    expect(x.body.scopeLabel).toBe('Own claim');
    const pdf = await download(k.token, q.body.id, 'pdf');
    expect(pdf.status).toBe(200);
    const d = await login('divya');
    expect((await as(d).get(`/exports/${q.body.id}`)).status).toBe(404);
    expect((await download(d.token, q.body.id, 'pdf')).status).toBe(404);
    const other = await as(k).post(`/trips/${S.T.cath}/exports`, { formats: ['pdf'] });
    expect(other.status).toBe(404);
  });

  it('logs an export the phone built offline; the file stays on the phone', async () => {
    const d = as(await login('divya'));
    const r = await d.post(`/trips/${S.T.mt}/exports/log`, { formats: ['xlsx'], provisional: true, builtAt: new Date().toISOString(), files: [{ format: 'xlsx', name: `${ref}_Divya-Raman_statement_PROVISIONAL.xlsx`, size: 48000 }] });
    expect(r.status).toBe(201);
    const list = await as(await login('meera', 'web')).get(`/finance/exports?via=mobile&tripId=${S.T.mt}`);
    const row = list.body.items.find((i: { id: string }) => i.id === r.body.id);
    expect(row.files[0]).toMatchObject({ onDevice: true, url: null });
    expect(row.requestedByName).toBe('Divya Raman');
  });

  it('fails with the file named when storage can’t supply a receipt, and retries (W08·d)', async () => {
    const rec = (await db.select().from(schema.attachments).where(eq(schema.attachments.expenseId, S.E.r1)))[0];
    const file = path.resolve(config.STORAGE_DIR, rec.storageKey!);
    const aside = `${file}.aside`;
    await fs.rename(file, aside);
    const meera = as(await login('meera', 'web'));
    const q = await meera.post(`/finance/trips/${S.T.mt}/exports`, { scope: 'member', memberUserId: S.U.rohan.id, formats: ['zip'] });
    await runQueuedExports();
    const failed = await meera.get(`/exports/${q.body.id}`);
    expect(failed.body.status).toBe('failed');
    expect(failed.body.error).toContain('_Printing-and-stationery_1150_1.jpg');
    await fs.rename(aside, file);
    const retry = await meera.post(`/finance/exports/${q.body.id}/retry`);
    expect(retry.status).toBe(200);
    await runQueuedExports();
    expect((await meera.get(`/exports/${q.body.id}`)).body.status).toBe('ready');
    const log = await meera.get(`/finance/trips/${S.T.mt}`);
    expect(log.body.exports.length).toBeGreaterThanOrEqual(3);
  });

  it('cancels a queued export without a trace in the log', async () => {
    const meera = as(await login('meera', 'web'));
    const q = await meera.post(`/finance/trips/${S.T.mt}/exports`, { scope: 'trip', formats: ['pdf'] });
    const del = await meera.del(`/finance/exports/${q.body.id}`);
    expect(del.status).toBe(204);
    expect((await meera.get(`/exports/${q.body.id}`)).status).toBe(404);
  });
});
