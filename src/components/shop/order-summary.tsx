"use client";

import { Loader2 } from "lucide-react";
import { useI18n } from "@/components/providers/i18n-provider";
import type { Quote } from "./use-quote";

export function OrderSummary({ quote, loading, deliveryKnown = true, children }: { quote: Quote | null; loading?: boolean; deliveryKnown?: boolean; children?: React.ReactNode }) {
  const { t, money, dual } = useI18n();
  const total = quote ? dual(quote.total) : null;
  return (
    <div className="space-y-3 rounded-2xl border bg-white p-5 shadow-sm">
      <h2 className="flex items-center justify-between font-semibold">{t("checkout.review")} {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}</h2>
      {quote && (
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between"><dt className="text-muted-foreground">{t("cart.subtotal")}</dt><dd>{money(quote.subtotal)}</dd></div>
          {quote.discountAmount > 0 && <div className="flex justify-between text-primary"><dt>{t("cart.discount")} {quote.discountCode && `(${quote.discountCode})`}</dt><dd>−{money(quote.discountAmount)}</dd></div>}
          <div className="flex justify-between"><dt className="text-muted-foreground">{t("cart.delivery")}</dt><dd>{!deliveryKnown ? <span className="text-xs text-muted-foreground">{t("cart.deliveryCalc")}</span> : quote.deliveryFee === 0 ? <span className="font-medium text-primary">{t("cart.free")}</span> : money(quote.deliveryFee)}</dd></div>
          <div className="flex items-end justify-between border-t pt-3"><dt className="font-semibold">{t("cart.total")}</dt><dd className="text-right"><div className="text-xl font-bold text-primary">{total!.primary}</div><div className="text-xs text-muted-foreground">≈ {total!.secondary}</div></dd></div>
          {quote.freeDeliveryThreshold > 0 && quote.subtotal - quote.discountAmount < quote.freeDeliveryThreshold && <p className="rounded-lg bg-secondary p-2 text-xs text-secondary-foreground">{t("cart.freeOver", { amount: money(quote.freeDeliveryThreshold) })}</p>}
        </dl>
      )}
      {children}
    </div>
  );
}
