import type { Dict, Locale } from "./dictionaries";

type Path<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Path<T[K], `${P}${K}.`>;
}[keyof T & string];

export type TKey = Path<Dict>;
export type TFunc = (key: TKey, vars?: Record<string, string | number>) => string;
export type TryTFunc = (key: string, fallback?: string, vars?: Record<string, string | number>) => string;

function lookup(dict: unknown, key: string): string | undefined {
  if (!dict || typeof dict !== "object") return undefined;
  const v = key.split(".").reduce<unknown>((o, k) => {
    if (o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k)) {
      return (o as Record<string, unknown>)[k];
    }
    return undefined;
  }, dict);
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function interpolate(str: string, vars?: Record<string, string | number>): string {
  if (!vars) return str;
  let s = str;
  for (const [k, val] of Object.entries(vars)) {
    const replacement = String(val);
    s = s.replaceAll(`{${k}}`, () => replacement);
  }
  return s;
}

/**
 * Create a type-safe translator with automatic fallback to English, then the raw key.
 */
export function makeT(dict: Dict, fallbackDict?: Dict): TFunc {
  return (key: TKey, vars?: Record<string, string | number>): string => {
    const raw = lookup(dict, key) ?? (fallbackDict ? lookup(fallbackDict, key) : undefined) ?? key;
    return interpolate(raw, vars);
  };
}

/**
 * Dynamic key lookup with graceful fallback (dict → en → fallback text → key).
 */
export function makeTryT(dict: Dict, fallbackDict?: Dict): TryTFunc {
  return (key: string, fallback?: string, vars?: Record<string, string | number>): string => {
    const raw = lookup(dict, key) ?? (fallbackDict ? lookup(fallbackDict, key) : undefined) ?? fallback ?? key;
    return interpolate(raw, vars);
  };
}

/**
 * Translate a category name by slug for vi / zh-CN / fr while preserving km & en DB fields verbatim.
 */
export function localizeCategoryName(
  cat: { slug?: string | null; nameEn?: string | null; nameKm?: string | null },
  locale: Locale,
  tryT: TryTFunc,
): string {
  const base = locale === "km" ? (cat.nameKm || cat.nameEn || "") : (cat.nameEn || cat.nameKm || "");
  if (locale === "km" || locale === "en" || !cat.slug) return base;
  return tryT(`catalogData.categories.${cat.slug}`, base);
}

/**
 * Translate a payment method label by code (KHQR, USDT, PAYPAL, CASH).
 */
export function localizePaymentMethod(
  method: { code?: string | null; nameEn?: string | null; nameKm?: string | null },
  locale: Locale,
  tryT: TryTFunc,
): string {
  const base = locale === "km" ? (method.nameKm || method.nameEn || method.code || "") : (method.nameEn || method.code || "");
  if (locale === "km" || locale === "en" || !method.code) return base;
  return tryT(`catalogData.paymentMethods.${method.code}`, base);
}

/**
 * Translate seeded marketing banners when they match known titles, while preserving custom banners.
 */
export function localizeBanner(
  banner: { titleEn?: string | null; titleKm?: string | null; subtitleEn?: string | null; subtitleKm?: string | null },
  locale: Locale,
  t: TFunc,
): { title: string; subtitle: string } {
  const title = locale === "km" ? (banner.titleKm || banner.titleEn || "") : (banner.titleEn || "");
  const subtitle = locale === "km" ? (banner.subtitleKm || banner.subtitleEn || "") : (banner.subtitleEn || "");
  if (locale === "km" || locale === "en") return { title, subtitle };
  if (banner.titleEn === "Vitamins for the Whole Family") {
    return { title: t("catalogData.banners.b1Title"), subtitle: t("catalogData.banners.b1Sub") };
  }
  if (banner.titleEn === "Talk to Our Pharmacists") {
    return { title: t("catalogData.banners.b2Title"), subtitle: t("catalogData.banners.b2Sub") };
  }
  return { title, subtitle };
}

/**
 * Translate role names & permission descriptions via catalogData.
 */
export function localizeRoleName(code: string, fallback: string, tryT: TryTFunc): string {
  return tryT(`catalogData.roles.${code}`, fallback);
}

export function localizePermissionDesc(code: string, fallback: string, tryT: TryTFunc): string {
  return tryT(`catalogData.permissions.${code.replace(/\./g, "_")}`, fallback);
}

/**
 * Translate report headers / KPI labels / P&L line names safely.
 */
export function localizeReportLabel(label: string, tryT: TryTFunc): string {
  return tryT(`reportsAdmin.labels.${label}`, label);
}

/** Exact-match mapping from common API English error strings to i18n message keys. */
const EXACT_ERROR_MAP: Record<string, TKey> = {
  "Invalid email/phone or password": "messages.invalidCredentials",
  "This account has been suspended. Please contact the pharmacy.": "messages.accountSuspended",
  "This account does not have staff access": "messages.noStaffAccess",
  "Too many login attempts. Please try again later.": "messages.rateLimited",
  "Email already registered": "messages.emailRegistered",
  "Phone number already registered": "messages.phoneRegistered",
  "Phone number is already used by another account": "messages.phoneInUse",
  "Email or phone already in use": "messages.emailOrPhoneInUse",
  "Invalid discount code": "messages.invalidDiscount",
  "This discount code is not active yet": "messages.discountNotActive",
  "This discount code has expired": "messages.discountExpired",
  "This discount code has reached its usage limit": "messages.discountLimit",
  "Cart is empty": "messages.cartEmpty",
  "Some products are no longer available": "messages.productsUnavailable",
  "Prescription image is required for prescription medicines": "messages.rxRequiredOnline",
  "Prescription medicines must be dispensed by a pharmacist": "messages.rxPharmacistOnly",
  "Order not found": "messages.orderNotFound",
  "Payment not found": "messages.paymentNotFound",
  "Authentication required": "messages.authRequired",
  "You do not have permission to perform this action": "messages.permissionDenied",
  "Not found": "messages.notFound",
  "File too large": "messages.fileTooLarge",
  "File too large (max 5 MB)": "messages.fileTooLarge",
  "No file uploaded": "messages.noFileUploaded",
  "Human verification required": "security.required",
  "Human verification failed": "security.required",
  "Enter a valid Cambodia phone number": "checkout.invalidPhone",
};

/**
 * Translate common server/API error messages into the active locale.
 */
export function translateApiError(msg: string | null | undefined, t: TFunc): string {
  if (!msg) return t("common.error");
  const trimmed = msg.trim();
  const exact = EXACT_ERROR_MAP[trimmed];
  if (exact) return t(exact);

  const minOrderMatch = trimmed.match(/^Minimum order of \$([0-9.]+) required for this code$/);
  if (minOrderMatch) {
    return t("messages.discountMinOrder", { amount: minOrderMatch[1]! });
  }
  const stockMatch = trimmed.match(/^Insufficient stock for (.+): requested (\d+), available (\d+)$/);
  if (stockMatch) {
    return t("messages.insufficientStock", { item: stockMatch[1]!, req: stockMatch[2]!, avail: stockMatch[3]! });
  }
  return trimmed;
}
