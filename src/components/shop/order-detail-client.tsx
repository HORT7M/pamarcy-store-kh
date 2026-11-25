"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, Download, Loader2, RotateCcw, CreditCard, XCircle } from "lucide-react";
import { toast } from "sonner";
import { useI18n } from "@/components/providers/i18n-provider";
import { useCart } from "@/components/providers/cart-provider";
import { StatusBadge } from "@/components/common/status-badge";
import { Button } from "@/components/ui/button";
import { formatDateTime, formatDate } from "@/lib/date";
import { formatKhPhone } from "@/lib/phone";
import { api } from "@/lib/fetcher";
import { cn } from "@/lib/utils";

type Order = {
  id: string; number: string; channel?: string; status: string; paymentStatus: string; fulfillmentStatus: string; prescriptionStatus: string; prescriptionNote: string | null; createdAt: string;
  subtotal: string; discountAmount: string; deliveryFee: string; total: string; fullName: string; phone: string; address: string; instructions: string | null; cancelReason: string | null;
  items: { id: string; nameEn: string; nameKm: string; sku: string; quantity: number; fulfilledQuantity: number; unitPrice: string; lineTotal: string; medicineId: string }[];
  history: { id: string; status: string; note: string | null; createdAt: string }[];
  payments: { id: string; reference: string; method: string; status: string; currency: string; amount: string; createdAt: string; paidAt: string | null; providerTxnId: string | null }[];
};

const STEPS = ["PENDING", "CONFIRMED", "PROCESSING", "READY_FOR_DELIVERY", "SHIPPING", "DELIVERED"];

export function OrderDetailClient({ order: o }: { order: Order }) {
  const { t, tError, money, pick } = useI18n();
  const router = useRouter();
  const { add } = useCart();
  const [cancelling, setCancelling] = useState(false);
  const idx = STEPS.indexOf(o.status);
  const isOnline = !o.channel || o.channel === "ONLINE";
  const canPay = isOnline && o.status === "PENDING" && o.paymentStatus !== "PAID" && o.prescriptionStatus !== "REJECTED";
  const canCancel = isOnline && o.status === "PENDING" && !["PAID", "PROCESSING"].includes(o.paymentStatus);

  async function cancel() {
    if (!confirm(t("common.confirm") + "?")) return;
    setCancelling(true);
    try {
      await api(`/api/orders/${o.id}/cancel`, { method: "POST" });
      toast.success(t("status.CANCELLED"));
      router.refresh();
    } catch (e) {
      toast.error(tError((e as Error).message));
    } finally {
      setCancelling(false);
    }
  }

  function reorder() {
    for (const i of o.items) add({ medicineId: i.medicineId, slug: "", nameEn: i.nameEn, nameKm: i.nameKm, imageUrl: null, price: Number(i.unitPrice), maxQty: 999, requiresPrescription: false }, i.quantity);
    router.push("/cart");
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-mono text-xl font-bold">{o.number}</h1>
          <p className="text-sm text-muted-foreground">{formatDateTime(o.createdAt)}</p>
          <div className="mt-2 flex flex-wrap gap-2"><StatusBadge status={o.status} /><StatusBadge status={o.paymentStatus} />{o.prescriptionStatus !== "NOT_REQUIRED" && <StatusBadge status={o.prescriptionStatus} />}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          {canPay && <Button asChild><Link href={`/checkout/pay/${encodeURIComponent(o.id)}`}><CreditCard /> {t("checkout.payment")}</Link></Button>}
          <Button asChild variant="outline"><a href={`/invoice/${encodeURIComponent(o.id)}`} target="_blank" rel="noopener noreferrer"><Download /> {t("account.invoice")}</a></Button>
          <Button variant="outline" onClick={reorder}><RotateCcw /> {t("common.reorder")}</Button>
          {canCancel && <Button variant="outline" className="text-red-600" onClick={cancel} disabled={cancelling}>{cancelling ? <Loader2 className="animate-spin" /> : <XCircle />} {t("common.cancel")}</Button>}
        </div>
      </div>

      {o.status === "CANCELLED" ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{t("status.CANCELLED")}{o.cancelReason ? ` — ${o.cancelReason}` : ""}</div>
      ) : (
        <div className="rounded-2xl border bg-white p-5 shadow-sm">
          <h2 className="mb-4 font-semibold">{t("account.track")}</h2>
          <ol className="grid grid-cols-3 gap-y-4 sm:grid-cols-6">
            {STEPS.map((s, i) => {
              const h = o.history.find((x) => x.status === s);
              return (
                <li key={s} className="flex flex-col items-center text-center">
                  <div className="relative flex w-full items-center justify-center">
                    {i > 0 && <div className={cn("absolute right-1/2 h-0.5 w-full", i <= idx ? "bg-primary" : "bg-muted")} />}
                    <div className={cn("relative z-10 flex size-8 items-center justify-center rounded-full border-2 text-xs font-bold", i <= idx ? "border-primary bg-primary text-white" : "border-muted bg-white text-muted-foreground")}>{i <= idx ? <Check className="size-4" /> : i + 1}</div>
                  </div>
                  <div className={cn("mt-2 text-xs font-medium", i <= idx ? "text-foreground" : "text-muted-foreground")}>{t(`status.${s}` as never)}</div>
                  {h && <div className="text-[10px] text-muted-foreground">{formatDate(h.createdAt)}</div>}
                </li>
              );
            })}
          </ol>
          {o.prescriptionNote && <p className="mt-4 whitespace-pre-line break-words rounded-lg bg-muted p-3 text-sm">{t("checkout.prescription")}: {o.prescriptionNote}</p>}
        </div>
      )}

      <div className="grid gap-5 md:grid-cols-[1fr_300px]">
        <div className="rounded-2xl border bg-white p-5 shadow-sm">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground"><tr><th className="pb-2">{t("common.name")}</th><th className="pb-2 text-right">{t("common.qty")}</th><th className="pb-2 text-right">{t("common.total")}</th></tr></thead>
            <tbody className="divide-y">
              {o.items.map((i) => (
                <tr key={i.id}>
                  <td className="py-2">{pick(i, "name")}<div className="text-xs text-muted-foreground">{i.sku}{i.fulfilledQuantity > 0 && i.fulfilledQuantity < i.quantity && ` · ${i.fulfilledQuantity}/${i.quantity} ${t("status.FULFILLED").toLowerCase()}`}</div></td>
                  <td className="py-2 text-right">{i.quantity}</td>
                  <td className="py-2 text-right">{money(i.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="ml-auto mt-4 max-w-xs space-y-1 border-t pt-3 text-sm">
            <div className="flex justify-between"><dt className="text-muted-foreground">{t("cart.subtotal")}</dt><dd>{money(o.subtotal)}</dd></div>
            {Number(o.discountAmount) > 0 && <div className="flex justify-between text-primary"><dt>{t("cart.discount")}</dt><dd>−{money(o.discountAmount)}</dd></div>}
            <div className="flex justify-between"><dt className="text-muted-foreground">{t("cart.delivery")}</dt><dd>{money(o.deliveryFee)}</dd></div>
            <div className="flex justify-between font-bold"><dt>{t("cart.total")}</dt><dd>{money(o.total)}</dd></div>
          </dl>
        </div>
        <div className="space-y-4">
          <div className="rounded-2xl border bg-white p-5 text-sm shadow-sm">
            <h3 className="mb-2 font-semibold">{t("checkout.delivery")}</h3>
            <p className="font-medium">{o.fullName}</p><p>{formatKhPhone(o.phone)}</p><p className="text-muted-foreground">{o.address}</p>
            {o.instructions && <p className="mt-2 whitespace-pre-line break-words text-xs italic text-muted-foreground">{o.instructions}</p>}
          </div>
          <div className="rounded-2xl border bg-white p-5 text-sm shadow-sm">
            <h3 className="mb-2 font-semibold">{t("account.payments")}</h3>
            {o.payments.length === 0 ? <p className="text-muted-foreground">—</p> : o.payments.map((p) => (
              <div key={p.id} className="border-t py-2 first:border-0">
                <div className="flex items-center justify-between"><span className="font-medium">{p.method}</span><StatusBadge status={p.status} /></div>
                <div className="font-mono text-[11px] text-muted-foreground">{p.reference}</div>
                <div className="text-xs">{p.currency} {p.currency === "USDT" ? Number(p.amount).toFixed(4) : Number(p.amount).toFixed(p.currency === "KHR" ? 0 : 2)} · {formatDateTime(p.paidAt ?? p.createdAt)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
