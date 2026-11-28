import { badRequest } from "./errors";

export const TIMEZONE = "Asia/Phnom_Penh";

function parts(d: Date, opts: Intl.DateTimeFormatOptions) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, ...opts });
  return Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
}

/** DD/MM/YYYY in Asia/Phnom_Penh */
export function formatDate(v: Date | string | null | undefined): string {
  if (!v) return "—";
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return "—";
  const p = parts(d, { day: "2-digit", month: "2-digit", year: "numeric" });
  return `${p.day}/${p.month}/${p.year}`;
}

/** DD/MM/YYYY HH:mm in Asia/Phnom_Penh */
export function formatDateTime(v: Date | string | null | undefined): string {
  if (!v) return "—";
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return "—";
  const p = parts(d, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

/** YYYY-MM-DD key for a date in Phnom Penh time (for grouping). */
export function dayKey(d: Date): string {
  const p = parts(d, { day: "2-digit", month: "2-digit", year: "numeric" });
  return `${p.year}-${p.month}-${p.day}`;
}

export function monthKey(d: Date): string {
  return dayKey(d).slice(0, 7);
}

/** Cambodia is UTC+7 with no DST. Start of the given local day as a UTC Date. */
export function startOfDayPP(d = new Date()): Date {
  const [y, m, day] = dayKey(d).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day, -7, 0, 0));
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86400000);
}

export function startOfMonthPP(d = new Date()): Date {
  const [y, m] = dayKey(d).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1, -7));
}

export function startOfYearPP(d = new Date()): Date {
  const [y] = dayKey(d).split("-").map(Number);
  return new Date(Date.UTC(y, 0, 1, -7));
}

export function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Parse "YYYY-MM-DD" (from <input type=date>) as Phnom Penh midnight. */
export function parseDateInput(s: string): Date {
  if (!isValidIsoDate(s)) throw badRequest("Invalid date");
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, -7));
}

export function toDateInput(v: Date | string | null | undefined): string {
  if (!v) return "";
  return dayKey(typeof v === "string" ? new Date(v) : v);
}
