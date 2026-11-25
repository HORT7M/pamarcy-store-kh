"use client";

import { PROVINCES } from "@/lib/cambodia";
import { useI18n } from "@/components/providers/i18n-provider";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type AddressValue = { province: string; district: string; commune: string; village: string; street: string };

export function AddressFields({ value, onChange, errors = {} }: { value: AddressValue; onChange: (v: AddressValue) => void; errors?: Record<string, string | undefined> }) {
  const { t, locale } = useI18n();
  const prov = PROVINCES.find((p) => p.en === value.province);
  const set = (patch: Partial<AddressValue>) => onChange({ ...value, ...patch });
  const sel = "h-9 w-full rounded-md border bg-white px-3 text-sm shadow-xs outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/50 aria-invalid:border-destructive";
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor="province">{t("checkout.province")} *</Label>
        <select id="province" className={sel} value={value.province} aria-invalid={!!errors.province} onChange={(e) => set({ province: e.target.value, district: "" })}>
          <option value="">{t("checkout.selectProvince")}</option>
          {PROVINCES.map((p) => <option key={p.code} value={p.en}>{locale === "km" ? `${p.km} (${p.en})` : p.en}</option>)}
        </select>
        {errors.province && <p className="text-xs text-red-600">{errors.province}</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="district">{t("checkout.district")} *</Label>
        <select id="district" className={sel} value={value.district} disabled={!prov} aria-invalid={!!errors.district} onChange={(e) => set({ district: e.target.value })}>
          <option value="">{t("checkout.selectDistrict")}</option>
          {prov?.districts.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        {errors.district && <p className="text-xs text-red-600">{errors.district}</p>}
      </div>
      <div className="space-y-1.5"><Label htmlFor="commune">{t("checkout.commune")}</Label><Input id="commune" value={value.commune} maxLength={60} onChange={(e) => set({ commune: e.target.value })} /></div>
      <div className="space-y-1.5"><Label htmlFor="village">{t("checkout.village")}</Label><Input id="village" value={value.village} maxLength={60} onChange={(e) => set({ village: e.target.value })} /></div>
      <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="street">{t("checkout.street")}</Label><Input id="street" value={value.street} maxLength={200} onChange={(e) => set({ street: e.target.value })} /></div>
    </div>
  );
}
