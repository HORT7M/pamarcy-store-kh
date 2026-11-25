"use client";

import { createContext, useCallback, useContext, useMemo } from "react";
import { useRouter } from "next/navigation";
import { dictionaries, type Locale } from "@/lib/i18n/dictionaries";
import { makeT, type TKey } from "@/lib/i18n/translate";
import { formatKHR, formatUSD, usdToKhr, type Num, toNum } from "@/lib/money";

type Ctx = {
  locale: Locale;
  currency: "USD" | "KHR";
  rate: number;
  t: (k: TKey, v?: Record<string, string | number>) => string;
  setLocale: (l: Locale) => void;
  setCurrency: (c: "USD" | "KHR") => void;
  /** Format a USD amount in the user's preferred currency */
  money: (usd: Num) => string;
  /** USD primary + KHR secondary */
  dual: (usd: Num) => { primary: string; secondary: string };
  pick: (obj: Record<string, unknown>, base: string) => string;
};

const I18nCtx = createContext<Ctx | null>(null);

export function I18nProvider({ locale, currency, rate, children }: { locale: Locale; currency: "USD" | "KHR"; rate: number; children: React.ReactNode }) {
  const router = useRouter();
  const t = useMemo(() => makeT(dictionaries[locale]), [locale]);
  const setCookie = (k: "locale" | "currency", v: string) => {
    if ((k === "locale" && v !== "km" && v !== "en") || (k === "currency" && v !== "USD" && v !== "KHR")) return;
    const secure = typeof window !== "undefined" && window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${k}=${encodeURIComponent(v)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
    router.refresh();
  };
  const money = useCallback((usd: Num) => (currency === "KHR" ? formatKHR(usdToKhr(usd, rate)) : formatUSD(usd)), [currency, rate]);
  const dual = useCallback(
    (usd: Num) =>
      currency === "KHR"
        ? { primary: formatKHR(usdToKhr(usd, rate)), secondary: formatUSD(usd) }
        : { primary: formatUSD(usd), secondary: formatKHR(usdToKhr(toNum(usd), rate)) },
    [currency, rate],
  );
  const pick = useCallback(
    (obj: Record<string, unknown>, base: string) => ((obj[`${base}${locale === "km" ? "Km" : "En"}`] ?? obj[`${base}En`]) as string) ?? "",
    [locale],
  );
  const value: Ctx = { locale, currency, rate, t, money, dual, pick, setLocale: (l) => setCookie("locale", l), setCurrency: (c) => setCookie("currency", c) };
  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>;
}

export function useI18n() {
  const c = useContext(I18nCtx);
  if (!c) throw new Error("useI18n must be used inside I18nProvider");
  return c;
}
