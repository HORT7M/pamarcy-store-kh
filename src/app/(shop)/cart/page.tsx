"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Minus, Plus, Trash2, ShoppingBag, AlertTriangle, Tag } from "lucide-react";
import { toast } from "sonner";
import { useCart } from "@/components/providers/cart-provider";
import { useI18n } from "@/components/providers/i18n-provider";
import { ProductImage } from "@/components/common/product-image";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { BotProtectionWidget, HoneypotField, useBotProtection } from "@/components/security/bot-protection";
import { useQuote } from "@/components/shop/use-quote";
import { OrderSummary } from "@/components/shop/order-summary";
import type { FetchError } from "@/lib/fetcher";
import type { ClientBotPayload } from "@/lib/bot-client";

export default function CartPage() {
  const { items, setQty, remove, ready, discountCode, setDiscountCode } = useCart();
  const { t, tError, pick, money } = useI18n();
  const [code, setCode] = useState(discountCode);
  useEffect(() => {
    if (ready) setCode(discountCode);
  }, [ready, discountCode]);
  const [attemptKey, setAttemptKey] = useState(0);
  const [pendingBotPayload, setPendingBotPayload] = useState<ClientBotPayload | undefined>(undefined);
  const promoBot = useBotProtection("promo_code", { autoLoad: false });

  const onPromoError = useCallback(
    (err: FetchError) => {
      promoBot.handleError(err);
    },
    [promoBot],
  );

  const { quote, loading, error } = useQuote(items, discountCode, null, ready, {
    botPayload: pendingBotPayload,
    attemptKey,
    onPromoError,
  });

  if (!ready) return <div className="mx-auto max-w-7xl space-y-3 px-4 py-8"><Skeleton className="h-8 w-48" /><Skeleton className="h-28" /><Skeleton className="h-28" /></div>;
  if (!items.length) return <div className="mx-auto max-w-3xl px-4 py-12"><EmptyState icon={ShoppingBag} title={t("cart.empty")} action={<Button asChild className="rounded-full"><Link href="/shop">{t("cart.continue")}</Link></Button>} /></div>;

  function applyDiscount(e: React.FormEvent) {
    e.preventDefault();
    if (promoBot.visible && !promoBot.ready) {
      toast.error(t("security.required"));
      return;
    }
    setPendingBotPayload(promoBot.getPayload());
    setDiscountCode(code.trim().toUpperCase());
    setAttemptKey((k) => k + 1);
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-bold">{t("cart.title")}</h1>
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-3">
          {items.map((i) => {
            const line = quote?.lines.find((l) => l.medicineId === i.medicineId);
            const short = line && line.available < i.quantity;
            const slug = line?.slug || i.slug;
            const imageUrl = line?.imageUrl ?? i.imageUrl;
            const requiresRx = line?.requiresPrescription ?? i.requiresPrescription;
            const productHref = slug ? `/product/${encodeURIComponent(slug)}` : null;
            return (
              <div key={i.medicineId} className="flex gap-4 rounded-2xl border bg-white p-3 shadow-sm">
                {productHref ? (
                  <Link href={productHref}><ProductImage src={imageUrl} alt={i.nameEn} className="size-20 shrink-0 rounded-xl sm:size-24" sizes="96px" /></Link>
                ) : (
                  <ProductImage src={imageUrl} alt={i.nameEn} className="size-20 shrink-0 rounded-xl sm:size-24" sizes="96px" />
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  {productHref ? (
                    <Link href={productHref} className="line-clamp-2 text-sm font-semibold hover:text-primary">{pick(i, "name")}</Link>
                  ) : (
                    <span className="line-clamp-2 text-sm font-semibold">{pick(i, "name")}</span>
                  )}
                  {requiresRx && <span className="flex items-center gap-1 text-xs text-amber-700"><AlertTriangle className="size-3" /> {t("product.rxRequired")}</span>}
                  <div className="text-sm text-muted-foreground">{money(line?.unitPrice ?? i.price)}</div>
                  {short && <div className="text-xs font-medium text-red-600">{line.available === 0 ? t("common.outOfStock") : t("cart.stockIssue", { n: line.available })}</div>}
                  <div className="mt-auto flex items-center justify-between gap-2">
                    <div className="flex items-center rounded-full border">
                      <button className="p-1.5 disabled:opacity-40" disabled={i.quantity <= 1} onClick={() => setQty(i.medicineId, i.quantity - 1)} aria-label="-"><Minus className="size-3.5" /></button>
                      <span className="w-8 text-center text-sm">{i.quantity}</span>
                      <button className="p-1.5 disabled:opacity-40" disabled={line ? i.quantity >= line.available : false} onClick={() => setQty(i.medicineId, i.quantity + 1)} aria-label="+"><Plus className="size-3.5" /></button>
                    </div>
                    <div className="font-semibold">{money(line?.lineTotal ?? i.price * i.quantity)}</div>
                    <button onClick={() => remove(i.medicineId)} className="rounded-full p-2 text-muted-foreground hover:bg-red-50 hover:text-red-600" aria-label={t("cart.remove")}><Trash2 className="size-4" /></button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="space-y-4">
          <form className="space-y-3 rounded-2xl border bg-white p-4 shadow-sm" onSubmit={applyDiscount}>
            <HoneypotField value={promoBot.hp} onChange={promoBot.setHp} />
            <div className="flex gap-2">
              <div className="relative flex-1"><Tag className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" /><Input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t("cart.code")} className="pl-8 uppercase" maxLength={40} /></div>
              <Button type="submit" variant="secondary" disabled={promoBot.visible && promoBot.solving}>{t("cart.applyCode")}</Button>
            </div>
            <BotProtectionWidget bot={promoBot} compact />
          </form>
          {quote?.discountError && <p className="-mt-2 px-1 text-xs text-red-600">{tError(quote.discountError)}</p>}
          {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{tError(error)}</p>}
          <OrderSummary quote={quote} loading={loading} deliveryKnown={false}>
            {quote?.stockOk ? (
              <Button asChild size="lg" className="w-full rounded-full">
                <Link href="/checkout">{t("cart.checkout")}</Link>
              </Button>
            ) : (
              <Button size="lg" className="w-full rounded-full" disabled>
                {t("cart.checkout")}
              </Button>
            )}
            {quote && !quote.stockOk && <p className="text-center text-xs text-red-600">{t("common.outOfStock")}</p>}
            <Link href="/shop" className="block text-center text-sm text-primary hover:underline">{t("cart.continue")}</Link>
          </OrderSummary>
        </div>
      </div>
    </div>
  );
}
