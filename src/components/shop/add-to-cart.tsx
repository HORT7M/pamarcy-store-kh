"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Minus, Plus, ShoppingCart, Heart, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useCart } from "@/components/providers/cart-provider";
import { useI18n } from "@/components/providers/i18n-provider";
import { api } from "@/lib/fetcher";
import type { ProductCard } from "@/lib/catalog";
import { cn } from "@/lib/utils";

export function AddToCart({ product: p, wished: initialWished, canWish }: { product: ProductCard; wished: boolean; canWish: boolean }) {
  const { add } = useCart();
  const { t, tError } = useI18n();
  const router = useRouter();
  const [qty, setQty] = useState(1);
  const [wished, setWished] = useState(initialWished);
  const out = p.available <= 0;
  const item = { medicineId: p.id, slug: p.slug, nameEn: p.nameEn, nameKm: p.nameKm, imageUrl: p.imageUrl, price: p.price, maxQty: p.available, requiresPrescription: p.requiresPrescription };

  async function toggleWish() {
    if (!canWish) return router.push(`/login?next=${encodeURIComponent(`/product/${encodeURIComponent(p.slug)}`)}`);
    try {
      const r = await api<{ wished: boolean }>("/api/account/wishlist", { method: "POST", body: { medicineId: p.id } });
      setWished(r.wished);
    } catch (e) {
      toast.error(tError((e as Error).message));
    }
  }

  return (
    <div className="space-y-3">
      <div className="text-sm">
        {out ? <span className="font-medium text-red-600">{t("common.outOfStock")}</span> : <span className="font-medium text-primary">{t("product.available", { n: p.available })}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center rounded-full border">
          <button className="p-2.5 disabled:opacity-40" onClick={() => setQty((q) => Math.max(1, q - 1))} disabled={qty <= 1} aria-label="-"><Minus className="size-4" /></button>
          <input type="number" min={1} max={p.available} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(p.available || 1, Number(e.target.value) || 1)))} className="w-12 bg-transparent text-center outline-none" aria-label={t("common.quantity")} />
          <button className="p-2.5 disabled:opacity-40" onClick={() => setQty((q) => Math.min(p.available, q + 1))} disabled={qty >= p.available} aria-label="+"><Plus className="size-4" /></button>
        </div>
        <Button size="lg" className="flex-1 rounded-full" disabled={out} onClick={() => { add(item, qty); toast.success(t("common.added")); }}><ShoppingCart /> {t("common.addToCart")}</Button>
        <Button size="lg" variant="outline" className="rounded-full border-brand-blue text-brand-blue" disabled={out} onClick={() => { add(item, qty); router.push("/checkout"); }}><Zap /> {t("common.buyNow")}</Button>
        <Button size="icon" variant="outline" className="size-10 rounded-full" onClick={toggleWish} aria-label={t("common.wishlist")} aria-pressed={wished}>
          <Heart className={cn("size-5", wished && "fill-red-500 text-red-500")} />
        </Button>
      </div>
    </div>
  );
}
