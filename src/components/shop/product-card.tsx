"use client";

import Link from "next/link";
import { ShoppingCart, FileWarning, Check } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useCart } from "@/components/providers/cart-provider";
import { useI18n } from "@/components/providers/i18n-provider";
import { ProductImage } from "@/components/common/product-image";
import { Price } from "@/components/common/price";
import type { ProductCard as Card } from "@/lib/catalog";

export function ProductCard({ p }: { p: Card }) {
  const { add } = useCart();
  const { t, pick, catName } = useI18n();
  const [added, setAdded] = useState(false);
  const name = pick(p as unknown as Record<string, unknown>, "name");
  const out = p.available <= 0;
  const discount = p.compareAtPrice && p.compareAtPrice > p.price ? Math.round((1 - p.price / p.compareAtPrice) * 100) : 0;

  function onAdd() {
    add({ medicineId: p.id, slug: p.slug, nameEn: p.nameEn, nameKm: p.nameKm, imageUrl: p.imageUrl, price: p.price, maxQty: p.available, requiresPrescription: p.requiresPrescription });
    setAdded(true);
    setTimeout(() => setAdded(false), 1200);
    toast.success(t("common.added"), { description: name });
  }

  return (
    <div className="group flex flex-col overflow-hidden rounded-2xl border bg-card shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
      <Link href={`/product/${encodeURIComponent(p.slug)}`} className="relative block">
        <ProductImage src={p.imageUrl} alt={name} className="aspect-[4/3] w-full" />
        <div className="absolute left-2 top-2 flex flex-col gap-1">
          {discount > 0 && <Badge className="bg-red-500 text-white">-{discount}%</Badge>}
          {p.requiresPrescription && (
            <Badge className="bg-amber-500 text-white"><FileWarning className="size-3" /> Rx</Badge>
          )}
        </div>
      </Link>
      <div className="flex flex-1 flex-col gap-2 p-3.5">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{p.brand ?? catName({ slug: p.categorySlug, nameEn: p.categoryEn, nameKm: p.categoryKm })}</div>
        <Link href={`/product/${encodeURIComponent(p.slug)}`} className="line-clamp-2 min-h-[2.6em] text-sm font-semibold leading-snug hover:text-primary">{name}</Link>
        <div className="mt-auto flex items-end justify-between gap-2">
          <Price usd={p.price} compareAt={p.compareAtPrice} size="sm" />
          <Button size="icon" onClick={onAdd} disabled={out} aria-label={t("common.addToCart")} className="shrink-0 rounded-full">
            {added ? <Check className="size-4" /> : <ShoppingCart className="size-4" />}
          </Button>
        </div>
        <div className="text-xs">
          {out ? <span className="text-red-600">{t("common.outOfStock")}</span> : p.available <= 10 ? <span className="text-amber-600">{t("common.lowStock", { n: p.available })}</span> : <span className="text-primary">{t("common.inStock")}</span>}
        </div>
      </div>
    </div>
  );
}
