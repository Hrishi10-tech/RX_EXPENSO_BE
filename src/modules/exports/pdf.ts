/**
 * PDF statement (SRS §8.4): header, budget summary, claim summary, expense table, category summary,
 * verification and reimbursement, attachment appendix and declaration, in that order.
 *
 * pdfkit lays out the text blocks; pdf-lib then inserts the attachment appendix (images compressed per FR-EXPT-06,
 * PDF documents page by page) and stamps every page with the footer and, when provisional, the PROVISIONAL mark (FR-EXPT-08).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument as PdfLib, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { inr } from '../../lib/money.js';
import { storage } from '../../lib/storage.js';
import { calendarDays, istDate, istLabel, istTime } from '../../lib/time.js';
import {
  CATEGORY_LABEL, CLAIM_LABEL, DOC_LABEL, FLAG_LABEL, MODE_LABEL, PAY_MODE_LABEL, SCOPE_LABEL, SOURCE_LABEL, VERIFY_LABEL,
  statedIndividuals, type AttachmentRow, type ExportData, type MemberData,
} from './data.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(here, '../../../assets');
const FONT = {
  R: path.join(ASSETS, 'fonts/Manrope_400Regular.ttf'),
  S: path.join(ASSETS, 'fonts/Manrope_600SemiBold.ttf'),
  B: path.join(ASSETS, 'fonts/Manrope_700Bold.ttf'),
  X: path.join(ASSETS, 'fonts/Manrope_800ExtraBold.ttf'),
  M: path.join(ASSETS, 'fonts/JetBrainsMono_400Regular.ttf'),
};
const MARK = path.join(ASSETS, 'brand/xmark.png');
const fontBytes = new Map<string, Buffer>();
const bytesOf = (f: string) => { let b = fontBytes.get(f); if (!b) { b = fs.readFileSync(f); fontBytes.set(f, b); } return b; };

/** Xelements palette (light theme tokens of the prototypes). */
const C = {
  ink: '#0E1020', ink2: '#4B5173', ink3: '#6A7091', line: '#E3E6F1', line2: '#CDD2E5', sunken: '#EEF0F8', ground: '#F5F6FB',
  accent: '#4E5DDB', accentSoft: '#ECEEFD', accentText: '#4353D6', pool: '#3657C9', poolSoft: '#EAF0FF', priv: '#8A4FAE', privSoft: '#F6EEFA',
  ok: '#127552', okSoft: '#E3F4EC', warn: '#8A5200', warnSoft: '#FFF1DA', bad: '#B92D3A', badSoft: '#FDEBED',
  barOk: '#2FA36F', barWarn: '#E09A2B', barBad: '#DE4453', track: '#E6E9F4',
};
const VERIFY_COLOR: Record<string, string> = { pending: C.ink3, verified: C.ok, query: C.warn, rejected: C.bad };

const PAGE_W = 595.28, PAGE_H = 841.89, L = 36, W = PAGE_W - 72, R = L + W, TOP = 46, BOTTOM = PAGE_H - 58;

type Font = 'R' | 'S' | 'B' | 'X' | 'M';
interface TOpts { font?: Font; size?: number; color?: string; align?: 'left' | 'right' | 'center'; lineGap?: number }

/** Tracks the cursor so every block can keep itself together and repeat table headers across pages. */
class Writer {
  y = TOP;
  pages = 1;
  continuation: (() => void) | null = null;
  constructor(public doc: PDFKit.PDFDocument) {
    doc.on('pageAdded', () => { this.pages++; this.y = TOP; if (this.continuation) this.continuation(); });
  }
  set(o: TOpts) { this.doc.font(o.font ?? 'R').fontSize(o.size ?? 8.5).fillColor(o.color ?? C.ink); return this; }
  height(s: string, w: number, o: TOpts = {}) { this.set(o); return this.doc.heightOfString(s || ' ', { width: w, lineGap: o.lineGap ?? 1 }); }
  width(s: string, o: TOpts = {}) { this.set(o); return this.doc.widthOfString(s); }
  text(s: string, x: number, y: number, w: number, o: TOpts = {}) {
    this.set(o);
    this.doc.text(s || ' ', x, y, { width: w, align: o.align ?? 'left', lineGap: o.lineGap ?? 1 });
    return this.doc.heightOfString(s || ' ', { width: w, lineGap: o.lineGap ?? 1 });
  }
  ensure(h: number) { if (this.y + h > BOTTOM) this.doc.addPage(); }
  fillRect(x: number, y: number, w: number, h: number, color: string, r = 0) {
    (r ? this.doc.roundedRect(x, y, w, h, r) : this.doc.rect(x, y, w, h)).fillColor(color).fill();
  }
  rule(y: number, color = C.line, x1 = L, x2 = R, lw = 0.6) { this.doc.moveTo(x1, y).lineTo(x2, y).lineWidth(lw).strokeColor(color).stroke(); }
  /** Section heading: numbered chip and title, kept with at least `keep` points of what follows. */
  section(n: number, title: string, sub?: string, keep = 60) {
    this.ensure(34 + keep);
    if (this.y > TOP + 4) this.y += 10;
    this.fillRect(L, this.y, 18, 18, C.accentSoft, 5);
    this.text(String(n), L, this.y + 3.5, 18, { font: 'B', size: 9, color: C.accentText, align: 'center' });
    this.text(title, L + 26, this.y + 2, W - 26, { font: 'X', size: 12.5 });
    this.y += 22;
    if (sub) { this.y += this.text(sub, L + 26, this.y, W - 26, { size: 7.5, color: C.ink3 }) + 2; }
    this.rule(this.y + 2);
    this.y += 9;
  }
  /** Label-over-value pairs in columns. */
  kv(pairs: Array<[string, string]>, cols = 2) {
    const gap = 14, cw = (W - gap * (cols - 1)) / cols;
    for (let i = 0; i < pairs.length; i += cols) {
      const row = pairs.slice(i, i + cols);
      const h = Math.max(...row.map(([, v]) => this.height(v, cw, { size: 8.5 }))) + 12;
      this.ensure(h + 4);
      row.forEach(([k, v], j) => {
        const x = L + j * (cw + gap);
        this.text(k.toUpperCase(), x, this.y, cw, { font: 'S', size: 6.5, color: C.ink3 });
        this.text(v, x, this.y + 9, cw, { size: 8.5 });
      });
      this.y += h + 4;
    }
  }
  note(s: string, tone: 'neutral' | 'warn' | 'bad' | 'ok' | 'priv' = 'neutral') {
    const bg = { neutral: C.ground, warn: C.warnSoft, bad: C.badSoft, ok: C.okSoft, priv: C.privSoft }[tone];
    const fg = { neutral: C.ink2, warn: C.warn, bad: C.bad, ok: C.ok, priv: C.priv }[tone];
    const h = this.height(s, W - 20, { size: 7.5 }) + 12;
    this.ensure(h + 6);
    this.fillRect(L, this.y, W, h, bg, 5);
    this.text(s, L + 10, this.y + 6, W - 20, { size: 7.5, color: fg });
    this.y += h + 6;
  }
}

interface Col { label: string; w: number; align?: 'left' | 'right' | 'center' }
type Cell = string | { t: string; color?: string; font?: Font; size?: number; bg?: string };

/** A simple table: header repeats on every page it spans. */
function table(w: Writer, cols: Col[], rows: Cell[][], o: { size?: number; zebra?: boolean; bold?: number[]; foot?: Cell[] } = {}) {
  const size = o.size ?? 7.8, pad = 4;
  const headH = Math.max(...cols.map(c => w.height(c.label, c.w - pad * 2, { font: 'S', size: 6.8 }))) + 8;
  const header = () => {
    w.fillRect(L, w.y, W, headH, C.sunken, 3);
    let x = L;
    for (const c of cols) { w.text(c.label, x + pad, w.y + 4.5, c.w - pad * 2, { font: 'S', size: 6.8, color: C.ink2, align: c.align }); x += c.w; }
    w.y += headH + 2;
  };
  const cell = (c: Cell) => (typeof c === 'string' ? { t: c } : c);
  const draw = (r: Cell[], idx: number, isFoot = false) => {
    const h = Math.max(...r.map((c, i) => w.height(cell(c).t, cols[i].w - pad * 2, { size: cell(c).size ?? size, font: cell(c).font }))) + pad * 2 - 1;
    if (w.y + h > BOTTOM) { w.doc.addPage(); header(); }
    if (isFoot) w.fillRect(L, w.y, W, h, C.accentSoft, 3);
    else if (o.zebra !== false && idx % 2 === 1) w.fillRect(L, w.y, W, h, '#FAFBFE');
    let x = L;
    r.forEach((c0, i) => {
      const c = cell(c0);
      if (c.bg) w.fillRect(x + 1, w.y + 1, cols[i].w - 2, h - 2, c.bg, 3);
      w.text(c.t, x + pad, w.y + pad - 0.5, cols[i].w - pad * 2, { size: c.size ?? size, font: c.font ?? (isFoot ? 'B' : 'R'), color: c.color ?? C.ink, align: cols[i].align });
      x += cols[i].w;
    });
    w.y += h;
    if (!isFoot) w.rule(w.y, C.line, L, R, 0.4);
  };
  w.ensure(headH + 24);
  header();
  rows.forEach((r, i) => draw(r, i));
  if (o.foot) draw(o.foot, 0, true);
  w.y += 8;
}

/** Budget bar with the prototype colours: green under 80 %, amber to 100 %, red over. */
function bar(w: Writer, x: number, y: number, width: number, pct: number) {
  w.fillRect(x, y, width, 4, C.track, 2);
  const p = Math.max(0, Math.min(pct, 100));
  if (p > 0) w.fillRect(x, y, Math.max(3, (width * p) / 100), 4, pct >= 100 ? C.barBad : pct >= 80 ? C.barWarn : C.barOk, 2);
}

const dayLabel = (d: Date) => istLabel(d, false);
const dateLong = (d: Date) => `${istLabel(d, false)} ${istDate(d).slice(0, 4)}`;
const range = (a: string, b: string) => {
  const f = (s: string) => istLabel(new Date(`${s}T12:00:00+05:30`), false);
  return a === b ? f(a) : `${f(a)} to ${f(b)}`;
};

export interface AppendixItem {
  kind: 'receipt' | 'document';
  a: AttachmentRow;
  name: string;
  caption: string;
  detail: string;
}

export interface PdfResult { buffer: Buffer; pages: number; appendix: number }

/** One statement: the whole trip (who = null) or one member. */
export async function buildStatementPdf(d: ExportData, who: MemberData | null, provisional: boolean, onProgress?: (done: number, total: number) => void): Promise<PdfResult> {
  const members = who ? [who] : d.members;
  const title = who ? `Member statement · ${who.name}` : 'Trip statement';
  const doc = new PDFDocument({
    size: 'A4', margins: { top: TOP, bottom: 20, left: L, right: L }, compress: true, autoFirstPage: true,
    info: { Title: `${d.ref} ${d.trip.name} · ${title}${provisional ? ' (PROVISIONAL)' : ''}`, Author: d.generatedBy, Subject: 'Trip expense statement', Creator: 'Expenso', Producer: 'Expenso' },
  });
  for (const [k, f] of Object.entries(FONT)) doc.registerFont(k, f);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const ended = new Promise<void>(res => doc.on('end', () => res()));
  const w = new Writer(doc);

  /* ---------- 1 · Header ---------- */
  doc.image(MARK, L, w.y - 2, { height: 20 });
  w.text('Expenso', L + 30, w.y + 1, 120, { font: 'X', size: 13 });
  w.text(title, L + 150, w.y + 1, W - 150, { font: 'S', size: 8.5, color: C.ink2, align: 'right' });
  w.text(`Generated ${dateLong(d.generatedAt)}, ${istTime(d.generatedAt)} IST by ${d.generatedBy}${d.via === 'mobile' ? ' on the mobile app' : ''}`, L + 150, w.y + 12, W - 150, { size: 7, color: C.ink3, align: 'right' });
  w.y += 30;
  if (provisional) {
    const reasons = who ? provisionalFor(d, who) : d.provisionalReasons;
    w.note(`PROVISIONAL. ${reasons.join(' ')} This mark prints on every page; export again after verification for a final copy.`, 'warn');
  }
  w.text(d.ref, L, w.y, W, { font: 'M', size: 8.5, color: C.accentText });
  w.y += 12;
  w.y += w.text(d.trip.name, L, w.y, W, { font: 'X', size: 19 }) + 2;
  const scopeLine = who ? `${who.name} (${who.code}) · their claim only` : `${SCOPE_LABEL.trip} · ${d.members.length} member${d.members.length === 1 ? '' : 's'}`;
  w.y += w.text(scopeLine + (d.limitLabel ? ` · limited to ${d.limitLabel}` : ''), L, w.y, W, { size: 9, color: C.ink2 }) + 10;

  const ext = d.trip.extendedAt ? `Extended since ${dateLong(d.trip.extendedAt)}, ${istTime(d.trip.extendedAt)}` : 'No';
  w.kv([
    ['Purpose', d.purposeLabel], ['Client / event', d.trip.clientEvent || '–'],
    ['Department', d.departmentName], ['Owner', `${d.ownerName}${d.ownerCode ? ` (${d.ownerCode})` : ''}`],
    ['Scheduled start', `${dateLong(d.trip.scheduledStart)}, ${istTime(d.trip.scheduledStart)}`], ['Tentative end', `${dateLong(d.trip.tentativeEnd)}, ${istTime(d.trip.tentativeEnd)}`],
    ['Trip status', d.statusLabel + (d.trip.closedAt ? `, ${dateLong(d.trip.closedAt)}` : '') + (d.trip.cancelledAt ? `, ${dateLong(d.trip.cancelledAt)}` : '')], ['Extension', ext],
    ['Export scope', (who ? `One member: ${who.name}` : SCOPE_LABEL.trip) + (d.limitLabel ? ` · ${d.limitLabel}` : '')], ['Generated', `${dateLong(d.generatedAt)}, ${istTime(d.generatedAt)} IST · ${d.generatedBy}`],
  ]);
  w.y += 2;
  w.text('LOCATIONS', L, w.y, W, { font: 'S', size: 6.5, color: C.ink3 });
  w.y += 10;
  table(w, [{ label: 'City', w: 120 }, { label: 'Venue / address', w: W - 120 - 150 }, { label: 'Dates', w: 150 }],
    d.locations.map(l => [
      { t: l.city + (l.isPrimary ? '  · primary' : ''), font: 'S' }, [l.venue, l.address].filter(Boolean).join(', ') || '–', range(l.arrivalDate, l.departureDate) + (l.deletedAt ? ' (deleted)' : ''),
    ]));

  w.text('MEMBERS', L, w.y, W, { font: 'S', size: 6.5, color: C.ink3 });
  w.y += 10;
  const listed = who ? d.allMembers.filter(m => m.userId === who.userId) : d.allMembers;
  table(w, [{ label: 'Member', w: 128 }, { label: 'Role', w: 44 }, { label: 'Actual start', w: 118 }, { label: 'Actual end', w: 128 }, { label: 'Days', w: 30, align: 'right' }, { label: 'Claim', w: W - 448 }],
    listed.map(m => {
      const x = m.member;
      const start = x.actualStart ? `${dayLabel(x.actualStart)}, ${istTime(x.actualStart)} · ${x.startMethod === 'automatic' ? 'automatic' : 'manual'}${x.startBackdated ? ' · backdated' : ''}` : 'Not started';
      const end = x.actualEnd ? `${dayLabel(x.actualEnd)}, ${istTime(x.actualEnd)} · ${x.endMethod === 'finance' ? 'by finance' : 'by member'}` : x.actualStart ? 'Still running' : '–';
      return [{ t: `${m.name}\n${m.code}`, font: 'S' as Font }, m.role === 'owner' ? 'Owner' : 'Member', start, end + (x.endReason ? `\n${x.endReason}` : ''),
        x.actualStart && x.actualEnd ? String(calendarDays(x.actualStart, x.actualEnd)) : '–', { t: CLAIM_LABEL[x.claimStatus] ?? x.claimStatus, color: x.claimStatus === 'reimbursed' || x.claimStatus === 'verified' ? C.ok : C.ink2 }];
    }));

  /* ---------- 2 · Budget summary ---------- */
  w.section(2, 'Budget summary', 'Budgets cover the whole trip. Nothing is blocked by a budget; an overage is stated here (FR-BUD-12).');
  const bRows: Cell[][] = [];
  const bLine = (label: string, sub: string, v: { allocatedPaise: number; spentPaise: number; remainingPaise: number; pct: number } | null) => {
    if (!v) return;
    const over = v.remainingPaise < 0;
    bRows.push([{ t: `${label}\n${sub}`, font: 'S' }, inr(v.allocatedPaise), inr(v.spentPaise),
      { t: over ? `Over by ${inr(-v.remainingPaise)}` : inr(v.remainingPaise), color: over ? C.bad : C.ok, font: 'S' }, { t: `${v.pct}%`, color: v.pct >= 100 ? C.bad : v.pct >= 80 ? C.warn : C.ink2 }]);
  };
  bLine('Trip pool', 'Shared by every member', d.pool);
  for (const s of statedIndividuals(d, who ?? undefined)) bLine(`Individual · ${s.name}`, 'Private to the member and finance', s.view);
  const unb = members.reduce((s, m) => s + m.scoped.unbudgetedPaise, 0);
  if (!bRows.length && !unb) w.note('No budget was set on this trip. Every self-paid expense is Unbudgeted.');
  if (bRows.length) {
    table(w, [{ label: 'Budget', w: 190 }, { label: 'Allocated', w: 82, align: 'right' }, { label: 'Spent', w: 82, align: 'right' }, { label: 'Remaining or overage', w: 110, align: 'right' }, { label: 'Used', w: W - 464, align: 'right' }], bRows);
  }
  if (unb) w.note(`Unbudgeted: ${inr(unb)} across ${members.filter(m => m.scoped.unbudgetedPaise).map(m => m.name).join(', ')}. Unbudgeted expenses draw down no budget.`, 'neutral');
  if (who && !who.individual) w.note(`${who.name} holds no individual budget on this trip.`, 'neutral');

  /* ---------- 3 · Claim summary ---------- */
  w.section(3, 'Claim summary', d.limitLabel
    ? `Spent, company-paid, self-paid, rejected and approved cover ${d.limitLabel}. Reimbursed and balance cover the whole claim.`
    : 'Company-paid expenses are shown for the true cost of the trip and are never reimbursed.');
  const cRows: Cell[][] = members.map(m => [
    { t: `${m.name}\n${CLAIM_LABEL[m.member.claimStatus]}`, font: 'S' }, inr(m.scoped.totalPaise), inr(m.scoped.companyPaise), inr(m.scoped.selfPaise),
    { t: inr(m.scoped.rejectedPaise), color: m.scoped.rejectedPaise ? C.bad : C.ink }, { t: inr(m.scoped.approvedPaise), font: 'S' }, inr(m.claim.paidPaise),
    { t: inr(Math.max(0, m.claim.balancePaise)), font: 'B', color: m.claim.balancePaise > 0 ? C.warn : C.ok },
  ]);
  const tot = (f: (m: MemberData) => number) => inr(members.reduce((s, m) => s + f(m), 0));
  table(w, [{ label: 'Member', w: 107 }, { label: 'Total spent', w: 60, align: 'right' }, { label: 'Company-paid', w: 60, align: 'right' }, { label: 'Self-paid', w: 60, align: 'right' },
    { label: 'Rejected', w: 56, align: 'right' }, { label: 'Approved reimbursable', w: 64, align: 'right' }, { label: 'Reimbursed', w: 58, align: 'right' }, { label: 'Balance due', w: W - 465, align: 'right' }],
  cRows, members.length > 1 ? { foot: ['All members', tot(m => m.scoped.totalPaise), tot(m => m.scoped.companyPaise), tot(m => m.scoped.selfPaise), tot(m => m.scoped.rejectedPaise), tot(m => m.scoped.approvedPaise), tot(m => m.claim.paidPaise), tot(m => Math.max(0, m.claim.balancePaise))] } : {});
  const pendingCount = members.reduce((s, m) => s + m.expenses.filter(x => x.e.verification === 'pending' || x.e.verification === 'query').length, 0);
  if (pendingCount) w.note(`${pendingCount} expense${pendingCount === 1 ? ' is' : 's are'} still pending or under query. Approved reimbursable counts verified expenses only.`, 'warn');

  /* ---------- 4 · Expense table ---------- */
  w.section(4, 'Expenses', 'Grouped by member, then location, then date. Each attachment is listed under its row by the name it has in the ZIP.', 90);
  const cols: Col[] = [{ label: 'Date', w: 62 }, { label: 'Category', w: 84 }, { label: 'Expense for', w: W - 62 - 84 - 64 - 64 - 58 }, { label: 'Amount', w: 64, align: 'right' }, { label: 'Approved', w: 64, align: 'right' }, { label: 'Status', w: 58 }];
  const colX = cols.reduce<number[]>((a, c, i) => (a.push(i ? a[i - 1] + cols[i - 1].w : L), a), []);
  const tHeader = () => {
    w.fillRect(L, w.y, W, 16, C.sunken, 3);
    cols.forEach((c, i) => w.text(c.label, colX[i] + 4, w.y + 4.5, c.w - 8, { font: 'S', size: 6.8, color: C.ink2, align: c.align }));
    w.y += 18;
  };
  let appendixTotal = 0;
  for (const m of members) {
    appendixTotal += m.expenses.reduce((s, x) => s + x.files.filter(f => f.received).length, 0) + m.documents.length;
  }
  appendixTotal += who ? 0 : d.tripDocuments.length;
  let rowsDone = 0;
  const rowsTotal = members.reduce((s, m) => s + m.expenses.length, 0);
  for (const m of members) {
    w.ensure(90);
    w.fillRect(L, w.y, W, 22, C.accentSoft, 4);
    w.text(`${m.name}  ·  ${m.code}`, L + 8, w.y + 6, W / 2, { font: 'B', size: 9.5 });
    w.text(`${m.scoped.count} expense${m.scoped.count === 1 ? '' : 's'} · ${inr(m.scoped.totalPaise)}`, L + W / 2, w.y + 6.5, W / 2 - 8, { font: 'S', size: 8.5, color: C.ink2, align: 'right' });
    w.y += 28;
    if (!m.expenses.length) { w.note(d.limitLabel ? `No expenses for ${d.limitLabel}.` : 'No expenses logged.'); continue; }
    const byLoc = new Map<string, typeof m.expenses>();
    for (const it of m.expenses) { const k = it.e.locationId; byLoc.set(k, [...(byLoc.get(k) ?? []), it]); }
    const locOrder = [...byLoc.keys()].sort((a, b) => (d.locations.findIndex(l => l.id === a) - d.locations.findIndex(l => l.id === b)));
    for (const lid of locOrder) {
      const list = byLoc.get(lid)!;
      const loc = list[0].location;
      const locTitle = loc ? `${loc.city}${loc.venue ? ` · ${loc.venue}` : ''} · ${range(loc.arrivalDate, loc.departureDate)}` : 'Location';
      w.ensure(70);
      w.text(locTitle, L, w.y, W, { font: 'B', size: 8.5, color: C.pool });
      w.y += 13;
      w.continuation = () => { w.text(`${m.name} · ${loc?.city ?? ''} (continued)`, L, w.y, W, { font: 'S', size: 7.5, color: C.ink3 }); w.y += 12; tHeader(); };
      tHeader();
      list.forEach((it, idx) => {
        const e = it.e;
        const desc = e.description + (e.remarks ? `\nRemarks: ${e.remarks}` : '');
        const meta = e.paidBy === 'self'
          ? [MODE_LABEL[e.paymentMode], 'Paid by self', e.budgetSource ? SOURCE_LABEL[e.budgetSource] : 'Unbudgeted'].join(' · ')
          : 'Paid by the company · not reimbursed, draws no budget';
        const flags = e.flags.map(f => FLAG_LABEL[f] ?? f).join(' · ');
        const fileText = it.files.length
          ? it.files.map(f => f.received ? f.name : `${f.name} (not received)`).join('\n')
          : e.paidBy === 'self' ? 'Receipt not received' : 'No receipt attached (company-paid)';
        const noneReceived = e.paidBy === 'self' && !it.files.some(f => f.received);
        const dW = cols[2].w - 8;
        const hDesc = w.height(desc, dW, { size: 8 }) + w.height(meta, dW, { size: 6.8 }) + (flags ? w.height(flags, dW, { size: 6.8 }) : 0);
        const hFiles = w.height(fileText, W - cols[0].w - 8, { font: 'M', size: 6.2 });
        const h = Math.max(hDesc, 22) + hFiles + 12;
        if (w.y + h > BOTTOM) doc.addPage();
        if (idx % 2 === 1) w.fillRect(L, w.y, W, h, '#FAFBFE');
        const y0 = w.y + 4;
        w.text(dayLabel(e.spentAt), colX[0] + 4, y0, cols[0].w - 8, { font: 'S', size: 7.8 });
        w.text(istTime(e.spentAt), colX[0] + 4, y0 + 10, cols[0].w - 8, { size: 7, color: C.ink3 });
        w.text(CATEGORY_LABEL[e.category] ?? e.category, colX[1] + 4, y0, cols[1].w - 8, { size: 7.8 });
        let yy = y0 + w.text(desc, colX[2] + 4, y0, dW, { size: 8 });
        yy += w.text(meta, colX[2] + 4, yy, dW, { size: 6.8, color: C.ink2 });
        if (flags) w.text(flags, colX[2] + 4, yy, dW, { size: 6.8, color: C.warn, font: 'S' });
        w.text(inr(e.amountPaise, true), colX[3] + 4, y0, cols[3].w - 8, { font: 'S', size: 8, align: 'right' });
        const approved = e.paidBy === 'company' ? '–' : e.verification === 'verified' ? inr(e.approvedPaise ?? e.amountPaise, true) : e.verification === 'rejected' ? inr(0, true) : '–';
        const lowered = e.verification === 'verified' && e.approvedPaise != null && e.approvedPaise !== e.amountPaise;
        w.text(approved, colX[4] + 4, y0, cols[4].w - 8, { size: 7.6, align: 'right', color: lowered ? C.accentText : e.verification === 'rejected' ? C.bad : C.ink, font: lowered ? 'S' : 'R' });
        w.text(VERIFY_LABEL[e.verification], colX[5] + 4, y0, cols[5].w - 8, { font: 'S', size: 7.6, color: VERIFY_COLOR[e.verification] });
        w.text(fileText, colX[1] + 4, w.y + Math.max(hDesc, 22) + 6, W - cols[0].w - 8, { font: 'M', size: 6.2, color: noneReceived ? C.bad : C.ink3 });
        w.y += h;
        w.rule(w.y, C.line, L, R, 0.4);
        rowsDone++;
      });
      w.continuation = null;
      const sub = list.reduce((s, x) => s + x.e.amountPaise, 0);
      const subA = list.reduce((s, x) => s + (x.e.verification === 'verified' && x.e.paidBy === 'self' ? x.e.approvedPaise ?? x.e.amountPaise : 0), 0);
      w.ensure(18);
      w.fillRect(L, w.y + 2, W, 15, C.ground, 3);
      w.text(`Subtotal · ${loc?.city ?? 'location'}`, L + 6, w.y + 5.5, 300, { font: 'S', size: 7.5, color: C.ink2 });
      w.text(`${inr(sub, true)}  ·  approved ${inr(subA, true)}`, L + 300, w.y + 5.5, W - 306, { font: 'B', size: 7.5, align: 'right' });
      w.y += 24;
    }
    w.ensure(20);
    w.fillRect(L, w.y, W, 17, C.accentSoft, 3);
    w.text(`Total · ${m.name}`, L + 6, w.y + 4.5, 260, { font: 'B', size: 8 });
    w.text(`${inr(m.scoped.totalPaise, true)} · company-paid ${inr(m.scoped.companyPaise, true)} · approved ${inr(m.scoped.approvedPaise, true)}`, L + 200, w.y + 4.5, W - 206, { font: 'B', size: 8, align: 'right' });
    w.y += 26;
    onProgress?.(rowsDone, rowsTotal);
  }

  /* ---------- 5 · Category summary ---------- */
  w.section(5, 'Category summary', d.limitLabel ? `Across this export: ${d.limitLabel}.` : 'Across this export.');
  const cats = new Map<string, { n: number; s: number }>();
  for (const m of members) for (const it of m.expenses) { const c = cats.get(it.e.category) ?? { n: 0, s: 0 }; c.n++; c.s += it.e.amountPaise; cats.set(it.e.category, c); }
  const all = [...cats.values()].reduce((s, c) => s + c.s, 0);
  if (!cats.size) w.note('No expenses in this export.');
  else {
    table(w, [{ label: 'Category', w: 190 }, { label: 'Expenses', w: 60, align: 'right' }, { label: 'Total', w: 100, align: 'right' }, { label: 'Share', w: W - 350 }],
      [...cats.entries()].sort((a, b) => b[1].s - a[1].s).map(([k, v]) => [{ t: CATEGORY_LABEL[k] ?? k, font: 'S' }, String(v.n), inr(v.s, true), `${all ? Math.round((v.s / all) * 100) : 0}%`]),
      { foot: ['All categories', String([...cats.values()].reduce((s, c) => s + c.n, 0)), inr(all, true), '100%'] });
  }

  /* ---------- 6 · Verification and reimbursement ---------- */
  w.section(6, 'Verification and reimbursement', 'Queries, replies and finance remarks on each expense; payments with date, mode and reference; claim reopenings (FR-VER-09).');
  let any = false;
  w.text('QUERIES AND REMARKS', L, w.y, W, { font: 'S', size: 6.5, color: C.ink3 });
  w.y += 11;
  for (const m of members) {
    for (const it of m.expenses) {
      const e = it.e;
      const lines: Array<{ t: string; color: string; font: Font }> = [];
      for (const msg of it.messages) {
        const label = msg.kind === 'query' ? 'Query' : msg.kind === 'reject' ? 'Rejected' : msg.kind === 'reply' ? 'Reply' : 'Note';
        lines.push({ t: `${label} · ${msg.authorName} · ${istLabel(msg.at)}: ${msg.body}`, color: msg.side === 'finance' ? C.ink : C.pool, font: 'R' });
      }
      if (e.verification === 'verified' && e.approvedPaise != null && e.approvedPaise !== e.amountPaise && !it.messages.some(x => x.kind === 'note')) lines.push({ t: `Approved ${inr(e.approvedPaise, true)} of ${inr(e.amountPaise, true)}: ${e.approvalReason ?? ''}`, color: C.accentText, font: 'S' });
      if (e.financeRemark && !it.messages.some(x => x.body === e.financeRemark)) lines.push({ t: `Finance remark: ${e.financeRemark}`, color: C.ink, font: 'R' });
      if (!lines.length) continue;
      any = true;
      const head = `${m.name} · ${dayLabel(e.spentAt)} · ${CATEGORY_LABEL[e.category]} · ${e.description} · ${inr(e.amountPaise, true)} · ${VERIFY_LABEL[e.verification]}`;
      const h = w.height(head, W - 16, { font: 'B', size: 8 }) + lines.reduce((s, l) => s + w.height(l.t, W - 24, { size: 7.6 }) + 2, 0) + 12;
      w.ensure(Math.min(h, 200));
      w.fillRect(L, w.y, 2.5, h - 6, VERIFY_COLOR[e.verification], 1);
      let yy = w.y + 2;
      yy += w.text(head, L + 10, yy, W - 16, { font: 'B', size: 8 }) + 2;
      for (const l of lines) yy += w.text(l.t, L + 16, yy, W - 24, { size: 7.6, color: l.color, font: l.font }) + 2;
      w.y = yy + 6;
    }
  }
  if (!any) w.note('No queries, rejections or lowered amounts on these expenses.');
  const pays = members.flatMap(m => m.payments.map(p => ({ m, p })));
  w.y += 4;
  w.text('PAYMENTS', L, w.y, W, { font: 'S', size: 6.5, color: C.ink3 });
  w.y += 11;
  if (!pays.length) w.note('No reimbursement recorded yet.');
  else table(w, [{ label: 'Member', w: 88 }, { label: 'Paid on', w: 58 }, { label: 'Mode', w: 58 }, { label: 'Reference', w: 104 }, { label: 'Amount', w: 64, align: 'right' }, { label: 'Proof', w: W - 372 - 60 }, { label: 'Recorded by', w: 60 }],
    pays.map(({ m, p }) => [{ t: m.name, font: 'S' }, dayLabel(new Date(`${p.paidOn}T12:00:00+05:30`)) + ` ${p.paidOn.slice(0, 4)}`, PAY_MODE_LABEL[p.mode] ?? p.mode, p.reference || '–', { t: inr(p.amountPaise, true), font: 'S' },
      { t: p.proofName ?? 'No proof file', font: p.proofName ? 'M' : 'R', size: 6.2, color: p.proofName ? C.ink3 : C.warn }, p.recordedByName]),
    { foot: ['Total paid', '', '', '', inr(pays.reduce((s, x) => s + x.p.amountPaise, 0), true), '', ''] });
  const reopenings = members.flatMap(m => m.reopenings.map(r => ({ m, r })));
  if (reopenings.length) {
    w.text('CLAIM REOPENINGS', L, w.y, W, { font: 'S', size: 6.5, color: C.ink3 });
    w.y += 11;
    for (const { m, r } of reopenings) w.note(`${m.name}’s claim was reopened on ${dateLong(r.at)}, ${istTime(r.at)} by ${r.by}: ${r.reason}`, 'warn');
  }

  /* ---------- 7 · appendix index (the pages themselves follow from pdf-lib) ---------- */
  const appendix = appendixItems(d, who);
  const nR = appendix.filter(a => a.kind === 'receipt').length, nD = appendix.length - nR;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  w.section(7, 'Attachment appendix', appendix.length
    ? `${plural(nR, 'receipt', 'receipts')} and ${plural(nD, 'finance document', 'finance documents')} follow, one per page, in the order of the expense table. Images are compressed for printing; the ZIP carries every file as stored.`
    : undefined, 40);
  if (!appendix.length) w.note('No attachment is on the server for this export.');
  else table(w, [{ label: '#', w: 24, align: 'right' }, { label: 'Attachment', w: 250 }, { label: 'File name in the ZIP', w: W - 274 }],
    appendix.map((a, i) => [String(i + 1), { t: `${a.caption}\n${a.detail}`, size: 7.2 }, { t: a.name, font: 'M' as Font, size: 6.2, color: C.ink2 }]), { size: 7.2 });
  const missingHere = d.missingReceipts.filter(x => members.some(m => m.userId === x.userId));
  if (missingHere.length) w.note(`${plural(missingHere.length, 'self-paid expense has', 'self-paid expenses have')} no receipt on the server: ${missingHere.map(x => `${x.memberName}, ${x.description}, ${dayLabel(x.spentAt)}, ${inr(x.amountPaise)}`).join('; ')}.`, 'bad');
  const appendixAt = w.pages;

  /* ---------- 8 · Declaration ---------- */
  doc.addPage();
  w.section(8, 'Declaration');
  for (const m of members) {
    w.ensure(120);
    const box = w.y;
    w.fillRect(L, box, W, 108, C.ground, 6);
    w.text(`I, ${m.name} (${m.code}), declare that the expenses listed for me in this statement are genuine and were incurred for official purposes on ${d.ref}, ${d.trip.name}.`, L + 14, box + 14, W - 28, { size: 9 });
    w.text('NAME', L + 14, box + 58, 150, { font: 'S', size: 6.5, color: C.ink3 });
    w.text(m.name, L + 14, box + 68, 150, { font: 'S', size: 9 });
    w.text('EXPORT DATE', L + 190, box + 58, 120, { font: 'S', size: 6.5, color: C.ink3 });
    w.text(`${dateLong(d.generatedAt)}`, L + 190, box + 68, 120, { size: 9 });
    w.text('SIGNATURE', L + 330, box + 58, W - 344, { font: 'S', size: 6.5, color: C.ink3 });
    w.rule(box + 88, C.line2, L + 330, R - 14, 0.8);
    w.y = box + 120;
  }
  doc.end();
  await ended;
  const main = Buffer.concat(chunks);
  const out = await assemble(d, who, provisional, main, appendixAt, appendix, (i, n) => onProgress?.(rowsTotal + i, rowsTotal + n));
  return { buffer: out.buffer, pages: out.pages, appendix: appendixTotal };
}

function provisionalFor(d: ExportData, m: MemberData) {
  const r: string[] = [];
  if (!(d.trip.status === 'closed' || d.trip.status === 'cancelled')) r.push(d.trip.status === 'scheduled' ? 'The trip has not started yet.' : 'The trip is still running.');
  if (!['verified', 'part_paid', 'reimbursed'].includes(m.member.claimStatus)) r.push(`${m.name}’s claim isn’t verified yet.`);
  return r;
}

/** Receipts in expense-table order, then finance documents (claim and expense documents, then trip documents). */
export function appendixItems(d: ExportData, who: MemberData | null): AppendixItem[] {
  const members = who ? [who] : d.members;
  const items: AppendixItem[] = [];
  const total = members.reduce((s, m) => s + m.expenses.reduce((t, x) => t + x.files.filter(f => f.received).length, 0), 0);
  let n = 0;
  for (const m of members) {
    const byLoc = [...m.expenses].sort((a, b) => (d.locations.findIndex(l => l.id === a.e.locationId) - d.locations.findIndex(l => l.id === b.e.locationId)) || (a.e.spentAt.getTime() - b.e.spentAt.getTime()));
    for (const it of byLoc) for (const f of it.files.filter(x => x.received)) {
      n++;
      items.push({
        kind: 'receipt', a: f.a, name: f.name,
        caption: `Receipt ${n} of ${total} · ${m.name}`,
        detail: `${dateLong(it.e.spentAt)}, ${istTime(it.e.spentAt)} · ${it.location?.city ?? ''} · ${CATEGORY_LABEL[it.e.category]} · ${it.e.description} · ${inr(it.e.amountPaise, true)} · ${VERIFY_LABEL[it.e.verification]}`,
      });
    }
  }
  const docs = [...members.flatMap(m => m.documents.map(x => ({ x, m }))), ...(who ? [] : d.tripDocuments.map(x => ({ x, m: null as MemberData | null })))];
  docs.forEach(({ x, m }, i) => items.push({
    kind: 'document', a: x.a, name: x.name,
    caption: `Finance document ${i + 1} of ${docs.length} · ${DOC_LABEL[x.a.docType ?? 'other']}`,
    detail: `${m ? (x.a.docScope === 'expense' ? `On an expense of ${m.name}` : `On ${m.name}’s claim`) : 'On the trip'} · uploaded ${dateLong(x.a.uploadedAt ?? x.a.createdAt)} by ${x.uploadedByName}`,
  }));
  return items;
}

const hex = (h: string) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);

/** Draw text that may contain characters the font lacks, replacing them rather than failing. */
function safe(font: PDFFont, s: string) {
  const set = new Set(font.getCharacterSet());
  return [...s].map(ch => (set.has(ch.codePointAt(0)!) ? ch : '?')).join('');
}
function wrap(font: PDFFont, s: string, size: number, maxW: number, maxLines: number) {
  const words = safe(font, s).split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const wd of words) {
    const t = cur ? `${cur} ${wd}` : wd;
    if (font.widthOfTextAtSize(t, size) <= maxW) cur = t;
    else { if (cur) lines.push(cur); cur = wd; }
    if (lines.length >= maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    let last = lines[maxLines - 1];
    while (last && font.widthOfTextAtSize(`${last}…`, size) > maxW) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last}…`;
  }
  return lines;
}

async function assemble(d: ExportData, who: MemberData | null, provisional: boolean, main: Buffer, appendixAt: number, items: AppendixItem[], onProgress?: (i: number, n: number) => void) {
  const src = await PdfLib.load(main);
  const out = await PdfLib.create();
  out.registerFontkit(fontkit);
  const fR = await out.embedFont(bytesOf(FONT.R), { subset: true });
  const fB = await out.embedFont(bytesOf(FONT.B), { subset: true });
  const fM = await out.embedFont(bytesOf(FONT.M), { subset: true });
  const copied = await out.copyPages(src, src.getPageIndices());
  copied.slice(0, appendixAt).forEach(p => out.addPage(p));

  const caption = (page: PDFPage, it: AppendixItem, extra = '') => {
    const top = PAGE_H - 44;
    page.drawRectangle({ x: L, y: top - 50, width: W, height: 50, color: hex(it.kind === 'receipt' ? C.poolSoft : C.privSoft) });
    page.drawText(safe(fB, it.caption + extra), { x: L + 10, y: top - 16, size: 10.5, font: fB, color: hex(C.ink) });
    wrap(fR, it.detail, 8, W - 20, 1).forEach((ln, i) => page.drawText(ln, { x: L + 10, y: top - 29 - i * 10, size: 8, font: fR, color: hex(C.ink2) }));
    page.drawText(safe(fM, it.name), { x: L + 10, y: top - 42, size: 6.8, font: fM, color: hex(C.accentText) });
    return top - 60;
  };
  const notice = (page: PDFPage, yTop: number, text: string) => {
    page.drawRectangle({ x: L, y: yTop - 60, width: W, height: 60, color: hex(C.ground), borderColor: hex(C.line), borderWidth: 0.6 });
    wrap(fR, text, 9, W - 30, 4).forEach((ln, i) => page.drawText(ln, { x: L + 15, y: yTop - 22 - i * 12, size: 9, font: fR, color: hex(C.ink2) }));
  };
  let i = 0;
  for (const it of items) {
    i++;
    onProgress?.(i, items.length);
    let body: Buffer | null = null;
    try { body = it.a.storageKey ? await storage.get(it.a.storageKey) : null; } catch { body = null; }
    if (!body) throw new ExportFileError(it.name);
    const mime = it.a.mime;
    if (mime === 'application/pdf') {
      try {
        const doc = await PdfLib.load(body, { ignoreEncryption: true });
        const n = doc.getPageCount();
        const pages = await out.embedPdf(doc, doc.getPageIndices());
        pages.forEach((ep, k) => {
          const page = out.addPage([PAGE_W, PAGE_H]);
          const yTop = caption(page, it, n > 1 ? ` · page ${k + 1} of ${n}` : '');
          const boxW = W, boxH = yTop - 58;
          const s = Math.min(boxW / ep.width, boxH / ep.height);
          const dw = ep.width * s, dh = ep.height * s;
          page.drawRectangle({ x: L + (boxW - dw) / 2 - 0.5, y: yTop - dh - 0.5, width: dw + 1, height: dh + 1, borderColor: hex(C.line2), borderWidth: 0.6 });
          page.drawPage(ep, { x: L + (boxW - dw) / 2, y: yTop - dh, width: dw, height: dh });
        });
        continue;
      } catch {
        const page = out.addPage([PAGE_W, PAGE_H]);
        notice(page, caption(page, it), `This PDF couldn’t be printed here (it may be protected). It is in the ZIP as ${it.name}.`);
        continue;
      }
    }
    if (mime.startsWith('image/')) {
      try {
        const jpg = await sharp(body, { failOn: 'none' }).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
          .flatten({ background: '#ffffff' }).jpeg({ quality: 62, mozjpeg: true }).toBuffer();
        const img = await out.embedJpg(jpg);
        const page = out.addPage([PAGE_W, PAGE_H]);
        const yTop = caption(page, it);
        const boxW = W, boxH = yTop - 58;
        const s = Math.min(boxW / img.width, boxH / img.height);
        const dw = img.width * s, dh = img.height * s;
        page.drawRectangle({ x: L + (boxW - dw) / 2 - 0.5, y: yTop - dh - 0.5, width: dw + 1, height: dh + 1, borderColor: hex(C.line2), borderWidth: 0.6 });
        page.drawImage(img, { x: L + (boxW - dw) / 2, y: yTop - dh, width: dw, height: dh });
        continue;
      } catch {
        const page = out.addPage([PAGE_W, PAGE_H]);
        notice(page, caption(page, it), `This image couldn’t be rendered for print. It is in the ZIP as ${it.name}.`);
        continue;
      }
    }
    const page = out.addPage([PAGE_W, PAGE_H]);
    const kind = /sheet|excel/.test(mime) ? 'Excel file' : /word/.test(mime) ? 'Word file' : 'file';
    notice(page, caption(page, it), `This ${kind} can’t be printed in a PDF. It is in the ZIP as ${it.name}.`);
  }
  copied.slice(appendixAt).forEach(p => out.addPage(p));

  // Footer and PROVISIONAL mark on every page (FR-EXPT-08).
  const pages = out.getPages();
  const label = safe(fR, `${d.ref} · ${d.trip.name} · ${who ? `Member statement: ${who.name}` : 'Trip statement'}${d.limitLabel ? ` · ${d.limitLabel}` : ''}`);
  pages.forEach((p, k) => {
    const { width } = p.getSize();
    p.drawLine({ start: { x: L, y: 40 }, end: { x: width - L, y: 40 }, thickness: 0.5, color: hex(C.line) });
    const lbl = wrap(fR, label, 7, width - 2 * L - 90, 1)[0] ?? '';
    p.drawText(lbl, { x: L, y: 28, size: 7, font: fR, color: hex(C.ink3) });
    const pn = `Page ${k + 1} of ${pages.length}`;
    p.drawText(pn, { x: width - L - fR.widthOfTextAtSize(pn, 7), y: 28, size: 7, font: fR, color: hex(C.ink3) });
    if (provisional) {
      const t = 'PROVISIONAL';
      const tw = fB.widthOfTextAtSize(t, 7.5);
      p.drawRectangle({ x: width - L - tw - 14, y: PAGE_H - 30, width: tw + 14, height: 15, color: hex(C.warnSoft), borderColor: hex(C.barWarn), borderWidth: 0.6 });
      p.drawText(t, { x: width - L - tw - 7, y: PAGE_H - 25.5, size: 7.5, font: fB, color: hex(C.warn) });
      p.drawText('Provisional: not final until the trip is closed and every claim verified', { x: L, y: 18, size: 6.5, font: fR, color: hex(C.warn) });
    }
  });
  out.setTitle(`${d.ref} ${d.trip.name} · ${who ? `Member statement: ${who.name}` : 'Trip statement'}${provisional ? ' (PROVISIONAL)' : ''}`);
  out.setAuthor(d.generatedBy);
  out.setCreator('Expenso');
  out.setProducer('Expenso');
  out.setCreationDate(d.generatedAt);
  const bytes = await out.save({ useObjectStreams: true });
  return { buffer: Buffer.from(bytes), pages: pages.length };
}

/** A stored attachment could not be read: the export fails with the file named and nothing partial is delivered (W08·d). */
export class ExportFileError extends Error {
  constructor(public fileName: string) { super(`Couldn’t read ${fileName} from storage.`); }
}
