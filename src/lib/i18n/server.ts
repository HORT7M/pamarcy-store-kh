import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { dictionaries, DEFAULT_LOCALE, normalizeLocale, type Locale } from "./dictionaries";
import { makeT, makeTryT } from "./translate";

export const getLocale = cache(async (): Promise<Locale> => {
  const v = (await cookies()).get("locale")?.value;
  return normalizeLocale(v) ?? DEFAULT_LOCALE;
});

export const getCurrency = cache(async (): Promise<"USD" | "KHR"> => {
  const v = (await cookies()).get("currency")?.value;
  return v === "KHR" ? "KHR" : "USD";
});

export async function getT() {
  const locale = await getLocale();
  const dict = dictionaries[locale] ?? dictionaries[DEFAULT_LOCALE];
  return {
    t: makeT(dict, dictionaries.en),
    tryT: makeTryT(dict, dictionaries.en),
    locale,
  };
}

/** Pick the localized DB field: (obj, "name") → obj.nameKm for km, obj.nameEn for en/vi/zh-CN/fr */
export function pick<T extends Record<string, unknown>>(obj: T, base: string, locale: Locale): string {
  const v = obj[`${base}${locale === "km" ? "Km" : "En"}`] ?? obj[`${base}En`];
  return (v as string) ?? "";
}
