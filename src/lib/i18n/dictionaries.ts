import en from "./locales/en.json";
import km from "./locales/km.json";
import vi from "./locales/vi.json";
import zhCN from "./locales/zh-CN.json";
import fr from "./locales/fr.json";

export type Dict = typeof en;

export const dictionaries = {
  en,
  km: km as Dict,
  vi: vi as Dict,
  "zh-CN": zhCN as Dict,
  fr: fr as Dict,
} as const;

export type Locale = keyof typeof dictionaries;

export const LOCALES: readonly Locale[] = ["km", "en", "vi", "zh-CN", "fr"] as const;
export const DEFAULT_LOCALE: Locale = "km";

export type LocaleMeta = {
  code: Locale;
  bcp47: string;
  short: string;
  nativeName: string;
  englishName: string;
};

export const LOCALE_META: Record<Locale, LocaleMeta> = {
  km: { code: "km", bcp47: "km-KH", short: "ខ្មែរ", nativeName: "ភាសាខ្មែរ", englishName: "Khmer" },
  en: { code: "en", bcp47: "en-US", short: "EN", nativeName: "English", englishName: "English" },
  vi: { code: "vi", bcp47: "vi-VN", short: "VI", nativeName: "Tiếng Việt", englishName: "Vietnamese" },
  "zh-CN": { code: "zh-CN", bcp47: "zh-CN", short: "中文", nativeName: "简体中文", englishName: "Chinese (Simplified)" },
  fr: { code: "fr", bcp47: "fr-FR", short: "FR", nativeName: "Français", englishName: "French" },
};

const LOCALE_ALIASES: Record<string, Locale> = {
  km: "km",
  "km-kh": "km",
  en: "en",
  "en-us": "en",
  "en-gb": "en",
  vi: "vi",
  "vi-vn": "vi",
  zh: "zh-CN",
  "zh-cn": "zh-CN",
  "zh-hans": "zh-CN",
  "zh-hans-cn": "zh-CN",
  "zh-sg": "zh-CN",
  fr: "fr",
  "fr-fr": "fr",
  "fr-ca": "fr",
};

export function normalizeLocale(input: string | null | undefined): Locale | null {
  if (!input) return null;
  const key = input.trim().toLowerCase().replace(/_/g, "-");
  return LOCALE_ALIASES[key] ?? null;
}

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v);
}
