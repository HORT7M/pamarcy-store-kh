"use client";

import { createContext, startTransition, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { dictionaries, LOCALE_META, normalizeLocale, type Locale } from "@/lib/i18n/dictionaries";
import {
  localizeCategoryName,
  localizePaymentMethod,
  makeT,
  makeTryT,
  translateApiError,
  type TFunc,
  type TryTFunc,
} from "@/lib/i18n/translate";
import { formatKHR, formatUSD, usdToKhr, type Num, toNum } from "@/lib/money";

const LS_LOCALE_KEY = "pamarcy_locale";
const LS_CURRENCY_KEY = "pamarcy_currency";

type Ctx = {
  locale: Locale;
  bcp47: string;
  currency: "USD" | "KHR";
  rate: number;
  t: TFunc;
  tryT: TryTFunc;
  tError: (msg: string | null | undefined) => string;
  setLocale: (l: Locale) => void;
  setCurrency: (c: "USD" | "KHR") => void;
  /** Format a USD amount in the user's preferred currency */
  money: (usd: Num) => string;
  /** USD primary + KHR secondary */
  dual: (usd: Num) => { primary: string; secondary: string };
  pick: (obj: Record<string, unknown>, base: string) => string;
  catName: (cat: { slug?: string | null; nameEn?: string | null; nameKm?: string | null }) => string;
  payMethodName: (method: { code?: string | null; nameEn?: string | null; nameKm?: string | null }) => string;
};

const I18nCtx = createContext<Ctx | null>(null);

function writeCookie(key: "locale" | "currency", value: string) {
  if (typeof document === "undefined") return;
  const secure = typeof window !== "undefined" && window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${key}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}

function hasCookie(key: string): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie.split(";").some((c) => c.trim().startsWith(`${key}=`));
}

export function I18nProvider({
  locale: initialLocale,
  currency: initialCurrency,
  rate,
  children,
}: {
  locale: Locale;
  currency: "USD" | "KHR";
  rate: number;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const [currency, setCurrencyState] = useState<"USD" | "KHR">(initialCurrency);

  // Restore persisted localStorage preference if cookie was cleared/absent on initial visit
  useEffect(() => {
    try {
      if (!hasCookie("locale")) {
        const stored = normalizeLocale(window.localStorage.getItem(LS_LOCALE_KEY));
        if (stored && stored !== initialLocale) {
          setLocaleState(stored);
          writeCookie("locale", stored);
          document.documentElement.lang = stored;
          startTransition(() => router.refresh());
        }
      }
      if (!hasCookie("currency")) {
        const storedCur = window.localStorage.getItem(LS_CURRENCY_KEY);
        if ((storedCur === "USD" || storedCur === "KHR") && storedCur !== initialCurrency) {
          setCurrencyState(storedCur);
          writeCookie("currency", storedCur);
          startTransition(() => router.refresh());
        }
      }
    } catch {
      /* localStorage unavailable (private browsing) */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  const dict = dictionaries[locale] ?? dictionaries.en;
  const t = useMemo(() => makeT(dict, dictionaries.en), [dict]);
  const tryT = useMemo(() => makeTryT(dict, dictionaries.en), [dict]);
  const tError = useCallback((msg: string | null | undefined) => translateApiError(msg, t), [t]);

  const setLocale = useCallback(
    (nextRaw: Locale) => {
      const next = normalizeLocale(nextRaw);
      if (!next || next === locale) return;
      // 1. Instant client state update (no page reload, preserves POS cart & forms)
      setLocaleState(next);
      // 2. Immediate <html lang="..."> sync for typography/CSS
      if (typeof document !== "undefined") document.documentElement.lang = next;
      // 3. Persist in cookie + localStorage
      writeCookie("locale", next);
      try {
        window.localStorage.setItem(LS_LOCALE_KEY, next);
      } catch {
        /* ignore storage errors */
      }
      // 4. Refresh server components seamlessly in the background
      startTransition(() => {
        router.refresh();
      });
    },
    [locale, router],
  );

  const setCurrency = useCallback(
    (next: "USD" | "KHR") => {
      if ((next !== "USD" && next !== "KHR") || next === currency) return;
      setCurrencyState(next);
      writeCookie("currency", next);
      try {
        window.localStorage.setItem(LS_CURRENCY_KEY, next);
      } catch {
        /* ignore storage errors */
      }
      startTransition(() => {
        router.refresh();
      });
    },
    [currency, router],
  );

  const money = useCallback(
    (usd: Num) => (currency === "KHR" ? formatKHR(usdToKhr(usd, rate)) : formatUSD(usd)),
    [currency, rate],
  );

  const dual = useCallback(
    (usd: Num) =>
      currency === "KHR"
        ? { primary: formatKHR(usdToKhr(usd, rate)), secondary: formatUSD(usd) }
        : { primary: formatUSD(usd), secondary: formatKHR(usdToKhr(toNum(usd), rate)) },
    [currency, rate],
  );

  const pick = useCallback(
    (obj: Record<string, unknown>, base: string) =>
      ((obj[`${base}${locale === "km" ? "Km" : "En"}`] ?? obj[`${base}En`]) as string) ?? "",
    [locale],
  );

  const catName = useCallback(
    (cat: { slug?: string | null; nameEn?: string | null; nameKm?: string | null }) =>
      localizeCategoryName(cat, locale, tryT),
    [locale, tryT],
  );

  const payMethodName = useCallback(
    (method: { code?: string | null; nameEn?: string | null; nameKm?: string | null }) =>
      localizePaymentMethod(method, locale, tryT),
    [locale, tryT],
  );

  const bcp47 = LOCALE_META[locale]?.bcp47 ?? "en-US";

  const value = useMemo<Ctx>(
    () => ({
      locale,
      bcp47,
      currency,
      rate,
      t,
      tryT,
      tError,
      money,
      dual,
      pick,
      catName,
      payMethodName,
      setLocale,
      setCurrency,
    }),
    [locale, bcp47, currency, rate, t, tryT, tError, money, dual, pick, catName, payMethodName, setLocale, setCurrency],
  );

  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>;
}

export function useI18n() {
  const c = useContext(I18nCtx);
  if (!c) throw new Error("useI18n must be used inside I18nProvider");
  return c;
}
