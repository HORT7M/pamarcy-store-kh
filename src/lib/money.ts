import type { Prisma } from "@prisma/client";

export type Num = number | string | Prisma.Decimal | null | undefined;

/** Convert Decimal/string/number into a JS number (safe for 2-decimal USD amounts). */
export function toNum(v: Num): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  return Number(v.toString());
}

/** Round half-up to 2 decimals using integer cents to avoid float drift. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function toCents(n: Num): number {
  return Math.round(toNum(n) * 100);
}

export function formatUSD(v: Num): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(toNum(v));
}

/** KHR is conventionally rounded to the nearest 100 riel for cash. */
export function usdToKhr(v: Num, rate: number): number {
  return Math.round((toNum(v) * rate) / 100) * 100;
}

export function formatKHR(riel: number): string {
  return "៛" + new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(riel);
}

export function formatMoney(v: Num, currency: "USD" | "KHR", rate: number): string {
  return currency === "KHR" ? formatKHR(usdToKhr(v, rate)) : formatUSD(v);
}
