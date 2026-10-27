/**
 * Excel workbook (SRS §8.1): one row per expense with every field and the file name of each attachment,
 * plus summary, budget and per-member sheets. Amounts are numbers in rupees with Indian digit grouping.
 */
import ExcelJS from 'exceljs';
import { istDate } from '../../lib/time.js';
import {
  CATEGORY_LABEL, CLAIM_LABEL, DOC_LABEL, FLAG_LABEL, MODE_LABEL, PAY_MODE_LABEL, SCOPE_LABEL, SOURCE_LABEL, VERIFY_LABEL,
  statedIndividuals, type ExportData, type ExpenseItem, type MemberData,
} from './data.js';

const INR = '[>=10000000]"₹"##\\,##\\,##\\,##0.00;[>=100000]"₹"##\\,##\\,##0.00;"₹"#,##0.00';
const WHEN = 'ddd d mmm yyyy, hh:mm';
const DAY = 'ddd d mmm yyyy';
const IST_MS = 330 * 60 * 1000;
/** Excel has no time zones: write the IST wall-clock time. */
const ist = (d: Date | null | undefined) => (d ? new Date(d.getTime() + IST_MS) : null);
const dayCell = (s: string) => new Date(`${s}T00:00:00Z`);
const rs = (paise: number | null | undefined) => (paise == null ? null : paise / 100);

const HEAD_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF0F8' } };
const TITLE_FONT: Partial<ExcelJS.Font> = { name: 'Calibri', size: 16, bold: true, color: { argb: 'FF0E1020' } };
const LABEL_FONT: Partial<ExcelJS.Font> = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF4B5173' } };
const PROV_FONT: Partial<ExcelJS.Font> = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF8A5200' } };

interface ColDef { header: string; key: string; width: number; fmt?: string }

function sheetName(wb: ExcelJS.Workbook, want: string) {
  const base = want.replace(/[\\/*?:[\]]/g, ' ').slice(0, 31).trim() || 'Sheet';
  let name = base, i = 2;
  while (wb.getWorksheet(name)) name = `${base.slice(0, 28)} ${i++}`;
  return name;
}

function tableAt(ws: ExcelJS.Worksheet, startRow: number, cols: ColDef[], rows: Array<Record<string, unknown>>, total?: Record<string, unknown>) {
  const head = ws.getRow(startRow);
  cols.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.value = c.header;
    cell.font = LABEL_FONT;
    cell.fill = HEAD_FILL;
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  head.height = 20;
  let r = startRow + 1;
  for (const row of rows) {
    const xr = ws.getRow(r++);
    cols.forEach((c, i) => {
      const cell = xr.getCell(i + 1);
      cell.value = (row[c.key] ?? null) as ExcelJS.CellValue;
      if (c.fmt) cell.numFmt = c.fmt;
      cell.alignment = { vertical: 'top', wrapText: c.width >= 28 };
    });
  }
  if (total) {
    const xr = ws.getRow(r++);
    cols.forEach((c, i) => {
      const cell = xr.getCell(i + 1);
      cell.value = (total[c.key] ?? null) as ExcelJS.CellValue;
      if (c.fmt) cell.numFmt = c.fmt;
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFECEEFD' } };
    });
  }
  return r;
}

function titleBlock(ws: ExcelJS.Worksheet, d: ExportData, who: MemberData | null, provisional: boolean) {
  ws.getCell('A1').value = `${d.ref} · ${d.trip.name}`;
  ws.getCell('A1').font = TITLE_FONT;
  ws.getCell('A2').value = who ? `Member statement: ${who.name} (${who.code})` : 'Trip statement';
  ws.getCell('A2').font = { size: 11, color: { argb: 'FF4B5173' } };
  let r = 3;
  if (provisional) {
    const reasons = who
      ? [...(!(d.trip.status === 'closed' || d.trip.status === 'cancelled') ? ['The trip is still running.'] : []), ...(!['verified', 'part_paid', 'reimbursed'].includes(who.member.claimStatus) ? [`${who.name}’s claim isn’t verified yet.`] : [])]
      : d.provisionalReasons;
    ws.getCell(`A${r}`).value = `PROVISIONAL. ${reasons.join(' ')}`;
    ws.getCell(`A${r}`).font = PROV_FONT;
    ws.getCell(`A${r}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF1DA' } };
    r++;
  }
  return r + 1;
}

function kvRows(ws: ExcelJS.Worksheet, start: number, pairs: Array<[string, ExcelJS.CellValue, string?]>) {
  let r = start;
  for (const [k, v, fmt] of pairs) {
    ws.getCell(`A${r}`).value = k;
    ws.getCell(`A${r}`).font = LABEL_FONT;
    const c = ws.getCell(`B${r}`);
    c.value = v;
    if (fmt) c.numFmt = fmt;
    c.alignment = { wrapText: true, vertical: 'top' };
    r++;
  }
  return r + 1;
}

const EXPENSE_COLS = (maxFiles: number, withMember: boolean): ColDef[] => [
  ...(withMember ? [{ header: 'Member', key: 'member', width: 20 }, { header: 'Employee ID', key: 'code', width: 12 }] : []),
  { header: 'Location', key: 'location', width: 16 },
  { header: 'Date and time (IST)', key: 'when', width: 22, fmt: WHEN },
  { header: 'Category', key: 'category', width: 20 },
  { header: 'Expense for', key: 'description', width: 32 },
  { header: 'Amount', key: 'amount', width: 13, fmt: INR },
  { header: 'Payment mode', key: 'mode', width: 13 },
  { header: 'Paid by', key: 'paidBy', width: 10 },
  { header: 'Budget source', key: 'source', width: 13 },
  { header: 'Verification', key: 'verification', width: 12 },
  { header: 'Approved amount', key: 'approved', width: 14, fmt: INR },
  { header: 'Approval reason', key: 'approvalReason', width: 24 },
  { header: 'Finance remark', key: 'financeRemark', width: 28 },
  { header: 'Member remarks', key: 'remarks', width: 24 },
  { header: 'Entry flags', key: 'flags', width: 18 },
  { header: 'Receipts', key: 'receiptState', width: 16 },
  ...Array.from({ length: maxFiles }, (_, i) => ({ header: `Attachment ${i + 1}`, key: `file${i + 1}`, width: 58 })),
  { header: 'Logged on device (IST)', key: 'deviceTime', width: 22, fmt: WHEN },
  { header: 'Reached server (IST)', key: 'receivedAt', width: 22, fmt: WHEN },
  { header: 'Expense ID', key: 'id', width: 38 },
];

function expenseRow(m: MemberData, it: ExpenseItem) {
  const e = it.e;
  const row: Record<string, unknown> = {
    member: m.name, code: m.code, location: it.location?.city ?? '', when: ist(e.spentAt), category: CATEGORY_LABEL[e.category] ?? e.category,
    description: e.description, amount: rs(e.amountPaise), mode: MODE_LABEL[e.paymentMode], paidBy: e.paidBy === 'self' ? 'Self' : 'Company',
    source: e.budgetSource ? SOURCE_LABEL[e.budgetSource] : '', verification: VERIFY_LABEL[e.verification],
    approved: e.verification === 'verified' ? (e.paidBy === 'self' ? rs(e.approvedPaise ?? e.amountPaise) : 0) : e.verification === 'rejected' ? 0 : null,
    approvalReason: e.approvalReason ?? '', financeRemark: e.financeRemark ?? '', remarks: e.remarks ?? '',
    flags: e.flags.map(f => FLAG_LABEL[f] ?? f).join(', '),
    receiptState: !it.files.length ? (e.paidBy === 'self' ? 'Receipt not received' : 'None (company-paid)') : it.files.every(f => f.received) ? `${it.files.length} received` : `${it.files.filter(f => !f.received).length} not received`,
    deviceTime: ist(e.deviceTime), receivedAt: ist(e.receivedAt), id: e.id,
  };
  it.files.forEach((f, i) => { row[`file${i + 1}`] = f.received ? f.name : `${f.name} (not received)`; });
  return row;
}

export async function buildStatementXlsx(d: ExportData, who: MemberData | null, provisional: boolean): Promise<Buffer> {
  const members = who ? [who] : d.members;
  const wb = new ExcelJS.Workbook();
  wb.creator = d.generatedBy;
  wb.created = d.generatedAt;
  wb.title = `${d.ref} ${who ? who.name : 'Trip'} statement${provisional ? ' (PROVISIONAL)' : ''}`;
  wb.company = 'Expenso';

  /* ---- Summary ---- */
  const s = wb.addWorksheet('Summary', { views: [{ showGridLines: false }] });
  s.columns = [{ width: 26 }, { width: 22 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 18 }, { width: 16 }, { width: 16 }, { width: 18 }];
  let r = titleBlock(s, d, who, provisional);
  r = kvRows(s, r, [
    ['Trip reference', d.ref], ['Trip name', d.trip.name], ['Purpose', d.purposeLabel], ['Client / event', d.trip.clientEvent ?? ''],
    ['Department', d.departmentName], ['Owner', `${d.ownerName} (${d.ownerCode})`],
    ['Scheduled start', ist(d.trip.scheduledStart), WHEN], ['Tentative end', ist(d.trip.tentativeEnd), WHEN],
    ['Trip status', d.statusLabel], ['Extended since', ist(d.trip.extendedAt), WHEN],
    ['Locations', d.locations.map(l => `${l.city}${l.venue ? ` (${l.venue})` : ''}: ${l.arrivalDate} to ${l.departureDate}`).join('\n')],
    ['Export scope', who ? `One member: ${who.name}` : SCOPE_LABEL.trip], ['Limited to', d.limitLabel ?? 'Whole trip'],
    ['Generated', ist(d.generatedAt), WHEN], ['Generated by', `${d.generatedBy}${d.via === 'mobile' ? ' (mobile app)' : ''}`],
    ['Provisional', provisional ? 'Yes' : 'No'],
  ]);
  s.getCell(`A${r}`).value = 'Members';
  s.getCell(`A${r}`).font = { bold: true, size: 12 };
  r = tableAt(s, r + 1, [
    { header: 'Member', key: 'name', width: 26 }, { header: 'Employee ID', key: 'code', width: 14 }, { header: 'Role', key: 'role', width: 10 },
    { header: 'Actual start (IST)', key: 'start', width: 20, fmt: WHEN }, { header: 'Start method', key: 'sm', width: 12 },
    { header: 'Actual end (IST)', key: 'end', width: 20, fmt: WHEN }, { header: 'End method', key: 'em', width: 12 }, { header: 'Claim status', key: 'claim', width: 18 },
  ], (who ? d.allMembers.filter(m => m.userId === who.userId) : d.allMembers).map(m => ({
    name: m.name, code: m.code, role: m.role === 'owner' ? 'Owner' : 'Member', start: ist(m.member.actualStart), sm: m.member.startMethod ?? '',
    end: ist(m.member.actualEnd), em: m.member.endMethod ?? '', claim: CLAIM_LABEL[m.member.claimStatus],
  }))) + 1;
  s.getCell(`A${r}`).value = d.limitLabel ? `Claim summary (spent to approved: ${d.limitLabel}; reimbursed and balance: whole claim)` : 'Claim summary';
  s.getCell(`A${r}`).font = { bold: true, size: 12 };
  const sum = (f: (m: MemberData) => number) => rs(members.reduce((a, m) => a + f(m), 0));
  r = tableAt(s, r + 1, [
    { header: 'Member', key: 'name', width: 26 }, { header: 'Total spent', key: 'total', width: 14, fmt: INR }, { header: 'Company-paid', key: 'company', width: 14, fmt: INR },
    { header: 'Self-paid', key: 'self', width: 14, fmt: INR }, { header: 'Rejected', key: 'rejected', width: 14, fmt: INR }, { header: 'Approved reimbursable', key: 'approved', width: 16, fmt: INR },
    { header: 'Reimbursed', key: 'paid', width: 14, fmt: INR }, { header: 'Balance due', key: 'balance', width: 14, fmt: INR }, { header: 'Status', key: 'status', width: 18 },
  ], members.map(m => ({
    name: m.name, total: rs(m.scoped.totalPaise), company: rs(m.scoped.companyPaise), self: rs(m.scoped.selfPaise), rejected: rs(m.scoped.rejectedPaise),
    approved: rs(m.scoped.approvedPaise), paid: rs(m.claim.paidPaise), balance: rs(Math.max(0, m.claim.balancePaise)), status: CLAIM_LABEL[m.member.claimStatus],
  })), members.length > 1 ? { name: 'All members', total: sum(m => m.scoped.totalPaise), company: sum(m => m.scoped.companyPaise), self: sum(m => m.scoped.selfPaise), rejected: sum(m => m.scoped.rejectedPaise), approved: sum(m => m.scoped.approvedPaise), paid: sum(m => m.claim.paidPaise), balance: sum(m => Math.max(0, m.claim.balancePaise)) } : undefined) + 1;
  s.getCell(`A${r}`).value = 'Category summary';
  s.getCell(`A${r}`).font = { bold: true, size: 12 };
  const cats = new Map<string, { n: number; s: number }>();
  for (const m of members) for (const it of m.expenses) { const c = cats.get(it.e.category) ?? { n: 0, s: 0 }; c.n++; c.s += it.e.amountPaise; cats.set(it.e.category, c); }
  const all = [...cats.values()].reduce((a, c) => a + c.s, 0);
  tableAt(s, r + 1, [{ header: 'Category', key: 'cat', width: 26 }, { header: 'Expenses', key: 'n', width: 10 }, { header: 'Total', key: 's', width: 14, fmt: INR }, { header: 'Share', key: 'p', width: 10, fmt: '0%' }],
    [...cats.entries()].sort((a, b) => b[1].s - a[1].s).map(([k, v]) => ({ cat: CATEGORY_LABEL[k] ?? k, n: v.n, s: rs(v.s), p: all ? v.s / all : 0 })),
    { cat: 'All categories', n: [...cats.values()].reduce((a, c) => a + c.n, 0), s: rs(all), p: all ? 1 : 0 });

  /* ---- Budgets (trip statements; a member statement states its budgets on the summary) ---- */
  const budgetRows = [
    ...(d.pool ? [{ budget: 'Trip pool', member: 'Every member', alloc: rs(d.pool.allocatedPaise), spent: rs(d.pool.spentPaise), rem: rs(d.pool.remainingPaise), pct: d.pool.pct / 100 }] : []),
    ...statedIndividuals(d, who ?? undefined).map(x => ({ budget: 'Individual', member: x.name, alloc: rs(x.view.allocatedPaise), spent: rs(x.view.spentPaise), rem: rs(x.view.remainingPaise), pct: x.view.pct / 100 })),
    { budget: 'Unbudgeted', member: members.filter(m => m.scoped.unbudgetedPaise).map(m => m.name).join(', '), alloc: null, spent: rs(members.reduce((a, m) => a + m.scoped.unbudgetedPaise, 0)), rem: null, pct: null },
  ];
  const budgetCols: ColDef[] = [{ header: 'Budget', key: 'budget', width: 16 }, { header: 'Member', key: 'member', width: 26 }, { header: 'Allocated', key: 'alloc', width: 14, fmt: INR },
    { header: 'Spent', key: 'spent', width: 14, fmt: INR }, { header: 'Remaining (negative = over)', key: 'rem', width: 18, fmt: INR }, { header: 'Used', key: 'pct', width: 10, fmt: '0%' }];
  const logCols: ColDef[] = [{ header: 'When (IST)', key: 'at', width: 22, fmt: WHEN }, { header: 'Budget', key: 'type', width: 12 }, { header: 'Member', key: 'member', width: 22 },
    { header: 'Old amount', key: 'old', width: 14, fmt: INR }, { header: 'New amount', key: 'new', width: 14, fmt: INR }, { header: 'Note', key: 'note', width: 30 }, { header: 'Changed by', key: 'by', width: 20 }];
  const logRows = d.budgetLog.map(c => ({ at: ist(c.at), type: c.type === 'pool' ? 'Trip pool' : 'Individual', member: c.memberName ?? '', old: rs(c.oldPaise), new: rs(c.newPaise), note: c.note ?? '', by: c.by }));
  const b = wb.addWorksheet('Budgets', { views: [{ showGridLines: false }] });
  b.columns = logCols.map((c, i) => ({ width: Math.max(c.width, budgetCols[i]?.width ?? 0) }));
  b.getCell('A1').value = 'Budgets (whole trip)';
  b.getCell('A1').font = { bold: true, size: 13 };
  let br = tableAt(b, 2, budgetCols, budgetRows) + 1;
  b.getCell(`A${br}`).value = 'Change log';
  b.getCell(`A${br}`).font = { bold: true, size: 12 };
  tableAt(b, br + 1, logCols, logRows);

  /* ---- Expenses: one row per expense ---- */
  const maxFiles = Math.max(1, ...members.flatMap(m => m.expenses.map(it => it.files.length)));
  const cols = EXPENSE_COLS(maxFiles, !who);
  const ex = wb.addWorksheet('Expenses', { views: [{ state: 'frozen', ySplit: 1, xSplit: who ? 1 : 2 }] });
  ex.columns = cols.map(c => ({ header: c.header, key: c.key, width: c.width }));
  ex.getRow(1).font = LABEL_FONT;
  ex.getRow(1).fill = HEAD_FILL;
  ex.getRow(1).height = 20;
  for (const m of members) for (const it of m.expenses) {
    const row = ex.addRow(expenseRow(m, it));
    cols.forEach((c, i) => { if (c.fmt) row.getCell(i + 1).numFmt = c.fmt; });
  }
  ex.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };

  /* ---- Per-member sheets (trip statements) ---- */
  if (!who) {
    const mcols = EXPENSE_COLS(maxFiles, false);
    for (const m of members) {
      const ws = wb.addWorksheet(sheetName(wb, m.name), { views: [{ state: 'frozen', ySplit: 1 }] });
      ws.columns = mcols.map(c => ({ header: c.header, key: c.key, width: c.width }));
      ws.getRow(1).font = LABEL_FONT;
      ws.getRow(1).fill = HEAD_FILL;
      for (const it of m.expenses) {
        const row = ws.addRow(expenseRow(m, it));
        mcols.forEach((c, i) => { if (c.fmt) row.getCell(i + 1).numFmt = c.fmt; });
      }
      const t = ws.addRow({ location: 'Total', amount: rs(m.scoped.totalPaise), approved: rs(m.scoped.approvedPaise) });
      t.font = { bold: true };
      mcols.forEach((c, i) => { if (c.fmt) t.getCell(i + 1).numFmt = c.fmt; });
    }
  }

  /* ---- Payments, reopenings, queries and documents ---- */
  const p = wb.addWorksheet(who ? 'Payments and queries' : 'Payments', { views: [{ showGridLines: false }] });
  p.columns = [{ width: 22 }, { width: 16 }, { width: 14 }, { width: 18 }, { width: 14 }, { width: 58 }, { width: 30 }, { width: 20 }, { width: 22 }];
  p.getCell('A1').value = 'Payments';
  p.getCell('A1').font = { bold: true, size: 13 };
  let pr = tableAt(p, 2, [
    { header: 'Member', key: 'member', width: 22 }, { header: 'Paid on', key: 'paidOn', width: 16, fmt: DAY }, { header: 'Mode', key: 'mode', width: 14 },
    { header: 'Reference', key: 'ref', width: 18 }, { header: 'Amount', key: 'amount', width: 14, fmt: INR }, { header: 'Proof file', key: 'proof', width: 58 },
    { header: 'Note', key: 'note', width: 30 }, { header: 'Recorded by', key: 'by', width: 20 }, { header: 'Recorded at (IST)', key: 'at', width: 22, fmt: WHEN },
  ], members.flatMap(m => m.payments.map(x => ({ member: m.name, paidOn: dayCell(x.paidOn), mode: PAY_MODE_LABEL[x.mode], ref: x.reference ?? '', amount: rs(x.amountPaise), proof: x.proofName ?? '', note: x.note ?? '', by: x.recordedByName, at: ist(x.recordedAt) })))) + 1;
  p.getCell(`A${pr}`).value = 'Claim reopenings';
  p.getCell(`A${pr}`).font = { bold: true, size: 12 };
  pr = tableAt(p, pr + 1, [{ header: 'Member', key: 'member', width: 22 }, { header: 'When (IST)', key: 'at', width: 22, fmt: WHEN }, { header: 'By', key: 'by', width: 20 }, { header: 'Reason', key: 'reason', width: 58 }],
    members.flatMap(m => m.reopenings.map(x => ({ member: m.name, at: ist(x.at), by: x.by, reason: x.reason })))) + 1;
  p.getCell(`A${pr}`).value = 'Queries, replies and remarks';
  p.getCell(`A${pr}`).font = { bold: true, size: 12 };
  pr = tableAt(p, pr + 1, [
    { header: 'Member', key: 'member', width: 22 }, { header: 'Expense date', key: 'day', width: 16, fmt: DAY }, { header: 'Category', key: 'cat', width: 14 },
    { header: 'Expense for', key: 'desc', width: 18 }, { header: 'Amount', key: 'amount', width: 14, fmt: INR }, { header: 'Message', key: 'body', width: 58 },
    { header: 'Kind', key: 'kind', width: 30 }, { header: 'From', key: 'by', width: 20 }, { header: 'When (IST)', key: 'at', width: 22, fmt: WHEN },
  ], members.flatMap(m => m.expenses.flatMap(it => it.messages.map(x => ({
    member: m.name, day: dayCell(istDate(it.e.spentAt)), cat: CATEGORY_LABEL[it.e.category], desc: it.e.description, amount: rs(it.e.amountPaise),
    body: x.body, kind: x.kind === 'query' ? 'Query' : x.kind === 'reject' ? 'Rejected' : x.kind === 'reply' ? 'Reply' : 'Note', by: x.authorName, at: ist(x.at),
  }))))) + 1;
  p.getCell(`A${pr}`).value = 'Finance documents';
  p.getCell(`A${pr}`).font = { bold: true, size: 12 };
  const docs = [...members.flatMap(m => m.documents.map(x => ({ x, m: m.name }))), ...(who ? [] : d.tripDocuments.map(x => ({ x, m: '' })))];
  tableAt(p, pr + 1, [
    { header: 'Attached to', key: 'to', width: 22 }, { header: 'Uploaded (IST)', key: 'at', width: 16, fmt: WHEN }, { header: 'Type', key: 'type', width: 14 },
    { header: 'Original name', key: 'orig', width: 18 }, { header: 'Size (KB)', key: 'kb', width: 14 }, { header: 'File name in the ZIP', key: 'name', width: 58 },
    { header: 'Visible to member', key: 'vis', width: 30 }, { header: 'Uploaded by', key: 'by', width: 20 },
  ], docs.map(({ x, m }) => ({
    to: x.a.docScope === 'trip' ? 'Trip' : x.a.docScope === 'expense' ? `Expense · ${m}` : `Claim · ${m}`, at: ist(x.a.uploadedAt ?? x.a.createdAt),
    type: DOC_LABEL[x.a.docType ?? 'other'], orig: x.a.originalName, kb: Math.round(x.a.sizeBytes / 1024), name: x.name, vis: x.a.visibleToMember ? 'Yes' : 'No', by: x.uploadedByName,
  })));

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}
