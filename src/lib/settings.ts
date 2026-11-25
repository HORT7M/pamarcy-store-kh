import "server-only";
import { prisma } from "./db";
import { pickAllowed, STORE_SETTINGS_FIELDS } from "./allowlist";

export type StoreSettings = {
  storeNameEn: string;
  storeNameKm: string;
  phone: string;
  email: string;
  addressEn: string;
  addressKm: string;
  openingHours: string;
  licenseNo: string;
  exchangeRate: number; // KHR per 1 USD
  deliveryFeePhnomPenh: number;
  deliveryFeeProvince: number;
  freeDeliveryThreshold: number;
  reservationMinutes: number; // stock reservation for unpaid online orders
  lowStockDefault: number;
  emailNotifications: boolean;
  notificationEmail: string;
  facebook: string;
  telegram: string;
};

export const DEFAULT_SETTINGS: StoreSettings = {
  storeNameEn: "Pamarcy Store",
  storeNameKm: "ឱសថស្ថាន ផាម៉ាស៊ី",
  phone: "+85523900888",
  email: "hello@pamarcy.com.kh",
  addressEn: "No. 88, Preah Monivong Blvd, Sangkat Boeng Raing, Khan Doun Penh, Phnom Penh",
  addressKm: "ផ្ទះលេខ ៨៨ មហាវិថីព្រះមុនីវង្ស សង្កាត់បឹងរាំង ខណ្ឌដូនពេញ រាជធានីភ្នំពេញ",
  openingHours: "07:00 – 21:00",
  licenseNo: "MOH-PH-000000",
  exchangeRate: 4100,
  deliveryFeePhnomPenh: 1.5,
  deliveryFeeProvince: 3,
  freeDeliveryThreshold: 30,
  reservationMinutes: 30,
  lowStockDefault: 10,
  emailNotifications: false,
  notificationEmail: "",
  facebook: "",
  telegram: "",
};

export async function getSettings(): Promise<StoreSettings> {
  const row = await prisma.systemSetting.findUnique({ where: { key: "store" } });
  const stored = (row?.value as Partial<StoreSettings> | null) ?? {};
  return { ...DEFAULT_SETTINGS, ...(pickAllowed(stored as Record<string, unknown>, STORE_SETTINGS_FIELDS, { omitUndefined: true }) as Partial<StoreSettings>) };
}

export async function saveSettings(patch: Partial<StoreSettings>) {
  const current = await getSettings();
  const safePatch = pickAllowed(patch as Record<string, unknown>, STORE_SETTINGS_FIELDS, { omitUndefined: true }) as Partial<StoreSettings>;
  const value: StoreSettings = { ...current, ...(safePatch as Partial<StoreSettings>) };
  await prisma.systemSetting.upsert({ where: { key: "store" }, update: { value }, create: { key: "store", value } });
  return value;
}

/** Delivery fee rule: free over threshold, else Phnom Penh vs province flat fee. */
export function computeDeliveryFee(s: StoreSettings, province: string | null | undefined, subtotalAfterDiscount: number) {
  if (subtotalAfterDiscount >= s.freeDeliveryThreshold && s.freeDeliveryThreshold > 0) return 0;
  if (!province) return s.deliveryFeePhnomPenh;
  return province === "Phnom Penh" ? s.deliveryFeePhnomPenh : s.deliveryFeeProvince;
}
