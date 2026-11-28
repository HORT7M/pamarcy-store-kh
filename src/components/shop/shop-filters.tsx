"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { useI18n } from "@/components/providers/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

export function ShopFilters({ categories, brands }: { categories: { slug: string; nameEn: string; nameKm: string }[]; brands: { slug: string; name: string }[] }) {
  const { t, catName } = useI18n();
  const router = useRouter();
  const sp = useSearchParams();
  const [open, setOpen] = useState(false);
  const urlMin = sp.get("min") ?? "";
  const urlMax = sp.get("max") ?? "";
  const [min, setMin] = useState(urlMin);
  const [max, setMax] = useState(urlMax);
  const selectedBrands = (sp.get("brand") ?? "").split(",").filter(Boolean);

  useEffect(() => {
    setMin(urlMin);
    setMax(urlMax);
  }, [urlMin, urlMax]);

  function update(patch: Record<string, string | null>) {
    const u = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) u.set(k, v);
      else u.delete(k);
    }
    u.delete("page");
    router.push(`/shop?${u}`);
  }

  const sorts = [
    ["popular", t("shop.sortPopular")], ["newest", t("shop.sortNewest")], ["price_asc", t("shop.sortPriceAsc")], ["price_desc", t("shop.sortPriceDesc")], ["name", t("shop.sortName")],
  ];

  return (
    <aside>
      <Button variant="outline" className="mb-3 w-full lg:hidden" onClick={() => setOpen((o) => !o)}><SlidersHorizontal /> {t("common.filter")}</Button>
      <div className={cn("space-y-6 rounded-2xl border bg-white p-4 shadow-sm lg:block", open ? "block" : "hidden")}>
        <div>
          <h3 className="mb-2 text-sm font-semibold">{t("common.sortBy")}</h3>
          <select className="h-9 w-full rounded-md border bg-white px-2 text-sm" value={sp.get("sort") ?? "popular"} onChange={(e) => update({ sort: e.target.value })}>
            {sorts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div>
          <h3 className="mb-2 text-sm font-semibold">{t("common.categories")}</h3>
          <div className="space-y-0.5">
            <button onClick={() => update({ category: null })} className={cn("block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-secondary", !sp.get("category") && "bg-secondary font-medium text-secondary-foreground")}>{t("common.all")}</button>
            {categories.map((c) => (
              <button key={c.slug} onClick={() => update({ category: c.slug })} className={cn("block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-secondary", sp.get("category") === c.slug && "bg-secondary font-medium text-secondary-foreground")}>{catName(c)}</button>
            ))}
          </div>
        </div>
        <div>
          <h3 className="mb-2 text-sm font-semibold">{t("shop.priceRange")} (USD)</h3>
          <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); update({ min: min || null, max: max || null }); }}>
            <Input type="number" min={0} step="0.01" placeholder={t("shop.min")} value={min} onChange={(e) => setMin(e.target.value)} className="h-9" />
            <span>–</span>
            <Input type="number" min={0} step="0.01" placeholder={t("shop.max")} value={max} onChange={(e) => setMax(e.target.value)} className="h-9" />
            <Button type="submit" size="sm" variant="secondary">{t("common.apply")}</Button>
          </form>
        </div>
        <div>
          <h3 className="mb-2 text-sm font-semibold">{t("shop.brands")}</h3>
          <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
            {brands.map((b) => (
              <label key={b.slug} className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox checked={selectedBrands.includes(b.slug)} onCheckedChange={(v) => update({ brand: (v ? [...selectedBrands, b.slug] : selectedBrands.filter((x) => x !== b.slug)).join(",") || null })} />
                {b.name}
              </label>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm"><Checkbox checked={sp.get("stock") === "1"} onCheckedChange={(v) => update({ stock: v ? "1" : null })} />{t("shop.inStockOnly")}</label>
          <label className="flex cursor-pointer items-center gap-2 text-sm"><Checkbox checked={sp.get("rx") === "otc"} onCheckedChange={(v) => update({ rx: v ? "otc" : null })} />{t("shop.otcOnly")}</label>
          <label className="flex cursor-pointer items-center gap-2 text-sm"><Checkbox checked={sp.get("rx") === "rx"} onCheckedChange={(v) => update({ rx: v ? "rx" : null })} />{t("shop.rxOnly")}</label>
        </div>
        <Button variant="ghost" className="w-full" onClick={() => router.push(sp.get("q") ? `/shop?q=${encodeURIComponent(sp.get("q")!)}` : "/shop")}>{t("common.reset")}</Button>
      </div>
    </aside>
  );
}
