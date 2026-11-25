import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { dictionaries, DEFAULT_LOCALE, type Locale } from "./dictionaries";
import { makeT } from "./translate";

export const getLocale = cache(async (): Promise<Locale> => {
  const v = (await cookies()).get("locale")?.value;
  return v === "en" || v === "km" ? v : DEFAULT_LOCALE;
});

export const getCurrency = cache(async (): Promise<"USD" | "KHR"> => {
  const v = (await cookies()).get("currency")?.value;
  return v === "KHR" ? "KHR" : "USD";
});

export async function getT() {
  const locale = await getLocale();
  return { t: makeT(dictionaries[locale]), locale };
}

/** Pick the localized field: (obj, "name") → obj.nameKm | obj.nameEn */
export function pick<T extends Record<string, unknown>>(obj: T, base: string, locale: Locale): string {
  const v = obj[`${base}${locale === "km" ? "Km" : "En"}`] ?? obj[`${base}En`];
  return (v as string) ?? "";
}
