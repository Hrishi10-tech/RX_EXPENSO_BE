/**
 * Demo receipts and finance documents for the seed: rendered on the server so the demo needs no binary fixtures.
 * Receipts look like phone photos of paper bills, UPI screens and e-tickets; documents are small PDFs.
 */
import PDFDocument from 'pdfkit';
import sharp from 'sharp';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const IST_MS = 330 * 60 * 1000;
const ist = (d: Date) => new Date(d.getTime() + IST_MS);
const pad = (n: number) => String(n).padStart(2, '0');
const dmy = (d: Date) => { const x = ist(d); return `${pad(x.getUTCDate())}/${pad(x.getUTCMonth() + 1)}/${x.getUTCFullYear()}`; };
const hm = (d: Date) => { const x = ist(d); return `${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}`; };
const money = (paise: number) => {
  const r = Math.floor(paise / 100), p = paise % 100, s = String(r);
  const last3 = s.slice(-3), rest = s.slice(0, -3);
  return (rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3) + '.' + String(p).padStart(2, '0');
};

/** Put a flat render on a desk at a slight angle with a soft shadow, like a phone photo. */
async function asPhoto(svg: string, w: number, h: number, seed: number, bg = '#cfc6b8'): Promise<Buffer> {
  const paper = await sharp(Buffer.from(svg)).png().toBuffer();
  const angle = ((seed % 7) - 3) * 0.6;
  const rotated = await sharp(paper).rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const meta = await sharp(rotated).metadata();
  const W = Math.round(w * 1.22), H = Math.round(h * 1.16);
  const shadow = await sharp({ create: { width: meta.width!, height: meta.height!, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.28 } } })
    .composite([{ input: rotated, blend: 'dest-in' }]).blur(9).png().toBuffer();
  const left = Math.round((W - meta.width!) / 2), top = Math.round((H - meta.height!) / 2);
  return sharp({ create: { width: W, height: H, channels: 3, background: bg } })
    .composite([{ input: shadow, left: left + 10, top: top + 14 }, { input: rotated, left, top }])
    .modulate({ brightness: 1 + ((seed % 5) - 2) * 0.015 })
    .jpeg({ quality: 82, mozjpeg: true }).toBuffer();
}

export interface Bill {
  merchant: string; address: string; gstin?: string; when: Date; billNo: string;
  /** Line items as [label, weight]; amounts are split by weight so the bill totals exactly totalPaise. */
  items: Array<[string, number]>;
  totalPaise: number;
  taxPct?: number; pay: string; foot?: string;
}

/** A thermal-paper bill whose total, GST included, is exactly the amount claimed. */
export async function billJpeg(input: Bill, seed = 1): Promise<Buffer> {
  const w = 560, lineH = 30;
  const sub = input.taxPct ? Math.floor(input.totalPaise / (1 + input.taxPct / 100)) : input.totalPaise;
  const tax = input.totalPaise - sub;
  const wsum = input.items.reduce((s, [, x]) => s + x, 0) || 1;
  const split = input.items.map(([label, x]) => [label, Math.floor(sub * x / wsum)] as [string, number]);
  split[split.length - 1][1] += sub - split.reduce((s, [, p]) => s + p, 0);
  const b = { ...input, items: split };
  const rows: string[] = [];
  let y = 70;
  const t = (x: number, s: string, o: { size?: number; weight?: string; anchor?: string; fill?: string } = {}) =>
    rows.push(`<text x="${x}" y="${y}" font-family="DejaVu Sans Mono, monospace" font-size="${o.size ?? 20}" font-weight="${o.weight ?? 'normal'}" text-anchor="${o.anchor ?? 'start'}" fill="${o.fill ?? '#1d1d1f'}">${esc(s)}</text>`);
  t(w / 2, b.merchant.toUpperCase(), { size: 26, weight: 'bold', anchor: 'middle' }); y += 34;
  for (const ln of b.address.split('\n')) { t(w / 2, ln, { size: 17, anchor: 'middle', fill: '#444' }); y += 24; }
  if (b.gstin) { t(w / 2, `GSTIN ${b.gstin}`, { size: 16, anchor: 'middle', fill: '#444' }); y += 24; }
  y += 10; rows.push(`<line x1="30" y1="${y - 14}" x2="${w - 30}" y2="${y - 14}" stroke="#888" stroke-dasharray="6 5"/>`);
  t(34, `Bill ${b.billNo}`, { size: 18 }); t(w - 34, `${dmy(b.when)} ${hm(b.when)}`, { size: 18, anchor: 'end' }); y += lineH + 4;
  rows.push(`<line x1="30" y1="${y - 18}" x2="${w - 30}" y2="${y - 18}" stroke="#888" stroke-dasharray="6 5"/>`);
  for (const [label, p] of b.items) { t(34, label.slice(0, 30), { size: 19 }); t(w - 34, money(p), { size: 19, anchor: 'end' }); y += lineH; }
  y += 6; rows.push(`<line x1="30" y1="${y - 18}" x2="${w - 30}" y2="${y - 18}" stroke="#888" stroke-dasharray="6 5"/>`);
  if (tax) {
    t(34, 'Sub total', { size: 18, fill: '#444' }); t(w - 34, money(sub), { size: 18, anchor: 'end', fill: '#444' }); y += lineH - 2;
    t(34, `CGST ${b.taxPct! / 2}%`, { size: 18, fill: '#444' }); t(w - 34, money(Math.floor(tax / 2)), { size: 18, anchor: 'end', fill: '#444' }); y += lineH - 2;
    t(34, `SGST ${b.taxPct! / 2}%`, { size: 18, fill: '#444' }); t(w - 34, money(tax - Math.floor(tax / 2)), { size: 18, anchor: 'end', fill: '#444' }); y += lineH;
  }
  t(34, 'TOTAL', { size: 24, weight: 'bold' }); t(w - 34, `Rs ${money(sub + tax)}`, { size: 24, weight: 'bold', anchor: 'end' }); y += lineH + 6;
  t(34, b.pay, { size: 17, fill: '#333' }); y += lineH + 10;
  t(w / 2, b.foot ?? 'Thank you. Visit again.', { size: 17, anchor: 'middle', fill: '#555' }); y += 30;
  const h = y + 20;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fbfaf5"/>` +
    `<path d="M0 ${h} ${Array.from({ length: 29 }, (_, i) => `L${(i + 0.5) * (w / 28)} ${h - (i % 2 ? 0 : 7)}`).join(' ')} L${w} ${h}" fill="#e9e5dc"/>${rows.join('')}</svg>`;
  return asPhoto(svg, w, h, seed);
}

/** A UPI payment confirmation, as a screenshot would look. */
export async function upiJpeg(u: { payee: string; vpa: string; amountPaise: number; when: Date; ref: string; from: string }, seed = 1): Promise<Buffer> {
  const w = 540, h = 900;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <rect width="100%" height="330" fill="#1a73e8"/>
  <circle cx="${w / 2}" cy="110" r="46" fill="#ffffff" opacity="0.95"/>
  <path d="M${w / 2 - 20} 110 l14 15 l28 -32" stroke="#1a73e8" stroke-width="9" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="${w / 2}" y="205" font-family="DejaVu Sans" font-size="46" font-weight="bold" fill="#fff" text-anchor="middle">₹${esc(money(u.amountPaise).replace(/\.00$/, ''))}</text>
  <text x="${w / 2}" y="250" font-family="DejaVu Sans" font-size="21" fill="#e8f0fe" text-anchor="middle">Paid to ${esc(u.payee)}</text>
  <text x="${w / 2}" y="285" font-family="DejaVu Sans" font-size="18" fill="#c6dafc" text-anchor="middle">${esc(u.vpa)}</text>
  <text x="40" y="390" font-family="DejaVu Sans" font-size="18" fill="#5f6368">Completed</text>
  <text x="${w - 40}" y="390" font-family="DejaVu Sans" font-size="18" fill="#202124" text-anchor="end">${dmy(u.when)}, ${hm(u.when)}</text>
  <line x1="40" y1="420" x2="${w - 40}" y2="420" stroke="#e0e0e0"/>
  <text x="40" y="465" font-family="DejaVu Sans" font-size="18" fill="#5f6368">UPI transaction ID</text>
  <text x="40" y="495" font-family="DejaVu Sans Mono" font-size="20" fill="#202124">${esc(u.ref)}</text>
  <text x="40" y="545" font-family="DejaVu Sans" font-size="18" fill="#5f6368">From</text>
  <text x="40" y="575" font-family="DejaVu Sans" font-size="20" fill="#202124">${esc(u.from)}</text>
  <text x="40" y="625" font-family="DejaVu Sans" font-size="18" fill="#5f6368">To</text>
  <text x="40" y="655" font-family="DejaVu Sans" font-size="20" fill="#202124">${esc(u.payee)}</text>
  <rect x="40" y="720" width="${w - 80}" height="64" rx="32" fill="#e8f0fe"/>
  <text x="${w / 2}" y="760" font-family="DejaVu Sans" font-size="20" fill="#1a73e8" text-anchor="middle">Share receipt</text>
  </svg>`;
  return asPhoto(svg, w, h, seed, '#2b2f3a');
}

/** A flight or train e-ticket. */
export async function ticketJpeg(t: { carrier: string; kind: 'flight' | 'train'; fromCode: string; toCode: string; from: string; to: string; dep: string; arr: string; pax: string; pnr: string; when: Date; amountPaise: number; number: string }, seed = 1): Promise<Buffer> {
  const w = 620, h = 760;
  const accent = t.kind === 'flight' ? '#0b3d91' : '#7a2e0e';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <rect width="100%" height="96" fill="${accent}"/>
  <text x="36" y="60" font-family="DejaVu Sans" font-size="30" font-weight="bold" fill="#fff">${esc(t.carrier)}</text>
  <text x="${w - 36}" y="60" font-family="DejaVu Sans" font-size="20" fill="#dde6ff" text-anchor="end">${t.kind === 'flight' ? 'E-ticket' : 'Electronic reservation slip'}</text>
  <text x="36" y="190" font-family="DejaVu Sans" font-size="54" font-weight="bold" fill="#111">${esc(t.fromCode)}</text>
  <text x="${w - 36}" y="190" font-family="DejaVu Sans" font-size="54" font-weight="bold" fill="#111" text-anchor="end">${esc(t.toCode)}</text>
  <text x="36" y="225" font-family="DejaVu Sans" font-size="18" fill="#555">${esc(t.from)} · ${esc(t.dep)}</text>
  <text x="${w - 36}" y="225" font-family="DejaVu Sans" font-size="18" fill="#555" text-anchor="end">${esc(t.to)} · ${esc(t.arr)}</text>
  <line x1="36" y1="270" x2="${w - 36}" y2="270" stroke="#ddd"/>
  <text x="36" y="315" font-family="DejaVu Sans" font-size="16" fill="#777">Passenger</text><text x="36" y="345" font-family="DejaVu Sans" font-size="21" fill="#111">${esc(t.pax)}</text>
  <text x="330" y="315" font-family="DejaVu Sans" font-size="16" fill="#777">${t.kind === 'flight' ? 'Flight' : 'Train'}</text><text x="330" y="345" font-family="DejaVu Sans" font-size="21" fill="#111">${esc(t.number)}</text>
  <text x="36" y="400" font-family="DejaVu Sans" font-size="16" fill="#777">PNR</text><text x="36" y="430" font-family="DejaVu Sans Mono" font-size="22" fill="#111">${esc(t.pnr)}</text>
  <text x="330" y="400" font-family="DejaVu Sans" font-size="16" fill="#777">Booked on</text><text x="330" y="430" font-family="DejaVu Sans" font-size="21" fill="#111">${dmy(t.when)} ${hm(t.when)}</text>
  <line x1="36" y1="480" x2="${w - 36}" y2="480" stroke="#ddd"/>
  <text x="36" y="530" font-family="DejaVu Sans" font-size="20" fill="#333">Base fare and taxes</text>
  <text x="${w - 36}" y="530" font-family="DejaVu Sans" font-size="20" fill="#333" text-anchor="end">₹${esc(money(t.amountPaise))}</text>
  <text x="36" y="590" font-family="DejaVu Sans" font-size="26" font-weight="bold" fill="#111">Total paid</text>
  <text x="${w - 36}" y="590" font-family="DejaVu Sans" font-size="26" font-weight="bold" fill="#111" text-anchor="end">₹${esc(money(t.amountPaise))}</text>
  <text x="36" y="680" font-family="DejaVu Sans" font-size="15" fill="#888">Carry a government photo ID. This is a computer-generated ticket.</text>
  </svg>`;
  return asPhoto(svg, w, h, seed, '#d7d9de');
}

/** A one-page PDF: payment advice, invoice or approval note. */
export async function docPdf(title: string, subtitle: string, rows: Array<[string, string]>, note?: string): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 56 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>(r => doc.on('end', () => r()));
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#0b2545').text(title);
  doc.moveDown(0.3).font('Helvetica').fontSize(11).fillColor('#555').text(subtitle);
  doc.moveDown(1.2);
  for (const [k, v] of rows) {
    const y = doc.y;
    doc.font('Helvetica').fontSize(10.5).fillColor('#666').text(k, 56, y, { width: 170 });
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#111').text(v.replace(/₹/g, 'Rs '), 236, y, { width: 300 });
    doc.moveDown(0.6);
  }
  if (note) { doc.moveDown(1).font('Helvetica-Oblique').fontSize(10).fillColor('#555').text(note.replace(/₹/g, 'Rs '), 56, doc.y, { width: 480 }); }
  doc.moveDown(3).font('Helvetica').fontSize(8.5).fillColor('#999').text('This is a system-generated document for the Expenso demo.', 56);
  doc.end();
  await done;
  return Buffer.concat(chunks);
}
