/** Money is integer paise everywhere. Formatting uses Indian digit grouping (NFR-10). */
export function inr(paise: number, withDecimals = false): string {
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  const s = String(rupees);
  const last3 = s.slice(-3), rest = s.slice(0, -3);
  const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3;
  const dec = withDecimals || p ? '.' + String(p).padStart(2, '0') : '';
  return (neg ? '−' : '') + '₹' + grouped + dec;
}
export const rupees = (paise: number) => paise / 100;
export const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
