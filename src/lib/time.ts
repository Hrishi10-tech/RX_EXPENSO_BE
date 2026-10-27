/** Time helpers. Everything is stored in UTC; calendar days are counted in IST (UTC+05:30, no DST). */
const IST_MS = 330 * 60 * 1000;

/** IST calendar date (YYYY-MM-DD) of an instant. */
export function istDate(d: Date): string {
  return new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);
}
/** Start of an IST calendar day as a UTC instant. */
export function istDayStart(day: string): Date {
  return new Date(new Date(`${day}T00:00:00Z`).getTime() - IST_MS);
}
/** 'HH:MM' in IST. */
export function istTime(d: Date): string {
  return new Date(d.getTime() + IST_MS).toISOString().slice(11, 16);
}
/** e.g. "Thu 1 Oct, 09:00" in IST. */
export function istLabel(d: Date, withTime = true): string {
  const x = new Date(d.getTime() + IST_MS);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][x.getUTCDay()];
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][x.getUTCMonth()];
  return `${wd} ${x.getUTCDate()} ${mo}` + (withTime ? `, ${istTime(d)}` : '');
}
/** Inclusive calendar days between two IST dates: 1 Oct to 4 Oct is 4 days (FR-END-08). */
export function calendarDays(a: Date, b: Date): number {
  const d1 = new Date(`${istDate(a)}T00:00:00Z`).getTime();
  const d2 = new Date(`${istDate(b)}T00:00:00Z`).getTime();
  return Math.round((d2 - d1) / 86400000) + 1;
}
export function addDays(day: string, n: number): string {
  const t = new Date(`${day}T00:00:00Z`).getTime() + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
export const minutes = (n: number) => n * 60 * 1000;
export const hours = (n: number) => n * 3600 * 1000;
/** "13 h early", "2 d 7 h" style durations. */
export function humanDuration(ms: number): string {
  const m = Math.round(Math.abs(ms) / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d) return `${d} d ${h} h`;
  if (h) return mm ? `${h} h ${mm} min` : `${h} h`;
  return `${mm} min`;
}
