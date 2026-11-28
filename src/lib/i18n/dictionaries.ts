import en, { type Dict } from "./locales/en";
import km from "./locales/km";
import vi from "./locales/vi";
import zhCN from "./locales/zh-CN";
import fr from "./locales/fr";
import type { Locale } from "./config";

export {
  DEFAULT_LOCALE,
  isLocale,
  LOCALE_META,
  LOCALE_NAMESPACE_FILES,
  LOCALES,
  normalizeLocale,
  type Locale,
  type LocaleMeta,
} from "./config";

export type { Dict };

export const dictionaries: Record<Locale, Dict> = {
  km,
  en,
  vi,
  "zh-CN": zhCN,
  fr,
} as const;
