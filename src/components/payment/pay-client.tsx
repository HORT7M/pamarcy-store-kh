"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, QrCode, Wallet, CreditCard, FileClock, CheckCircle2, XCircle, Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/providers/i18n-provider";
import { StatusBadge } from "@/components/common/status-badge";
import { PaymentPanel } from "./payment-panel";
import { api } from "@/lib/fetcher";
import { formatKHR, usdToKhr } from "@/lib/money";
import type { MethodDto, PaymentViewDto } from "./types";
import { cn } from "@/lib/utils";

type OrderDto = {
  id: string; number: string; status: string; paymentStatus: string; prescriptionStatus: string; prescriptionNote: string | null; total: string; subtotal: string; discountAmount: string; deliveryFee: string;
  exchangeRate: number; reservationExpiresAt: string | null; customerId: string | null; items: { id: string; nameEn: string; nameKm: string; quantity: number; lineTotal: string }[];
};

const ICONS = { KHQR: QrCode, USDT: Wallet, PAYPAL: CreditCard, CASH: CreditCard };

export function PayClient({ order, token, methods, initialPayment, paypalReturn }: { order: OrderDto; token: string; methods: MethodDto[]; initialPayment: PaymentViewDto | null; paypalReturn: "return" | "cancel" | null }) {
  const { t, pick, money, locale } = useI18n();
  const router = useRouter();
  const [payment, setPayment] = useState<PaymentViewDto | null>(initialPayment);
  const [method, setMethod] = useState<MethodDto["code"] | null>(initialPayment?.method ?? null);
  const [currency, setCurrency] = useState<"USD" | "KHR">(initialPayment?.currency === "KHR" ? "KHR" : "USD");
  const [network, setNetwork] = useState<string | null>(initialPayment?.network?.code ?? null);
  const [creating, setCreating] = useState(false);
  const [paid, setPaid] = useState(order.paymentStatus === "PAID");
  const captured = useRef(false);
  const q = `?token=${encodeURIComponent(token)}`;

  // PayPal return: capture on the server (never trust the redirect alone)
  useEffect(() => {
    if (paypalReturn === "cancel") toast.info(t("pay.cancelled"));
    if (paypalReturn === "return" && payment?.method === "PAYPAL" && payment.status !== "PAID" && !captured.current) {
      captured.current = true;
      api<PaymentViewDto>(`/api/payments/${payment.id}/paypal-capture${q}`, { method: "POST" })
        .then(setPayment)
        .catch((e) => toast.error(e.message))
        .finally(() => router.replace(`/checkout/pay/${order.id}${q}`));
    }
  }, [paypalReturn, payment, q, order.id, router, t]);

  const create = useCallback(async (m: MethodDto["code"], opts: { currency?: "USD" | "KHR"; network?: string | null } = {}) => {
    setCreating(true);
    try {
      const p = await api<PaymentViewDto>(`/api/orders/${order.id}/pay${q}`, { method: "POST", body: { method: m, currency: m === "KHQR" ? opts.currency ?? currency : undefined, network: m === "USDT" ? opts.network ?? network : undefined } });
      setPayment(p);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCreating(false);
    }
  }, [order.id, q, currency, network]);

  const rxBlocked = order.prescriptionStatus === "PENDING_REVIEW";
  const rejected = order.prescriptionStatus === "REJECTED";
  const cancelled = order.status === "CANCELLED";
  const totalKhr = usdToKhr(order.total, order.exchangeRate);

  function choose(m: MethodDto) {
    if (!m.ready) return;
    setMethod(m.code);
    if (m.code === "USDT") {
      const n = network ?? m.networks?.[0]?.code ?? null;
      setNetwork(n);
      if (payment?.method !== "USDT" || payment.network?.code !== n) create("USDT", { network: n });
    } else if (m.code === "KHQR") {
      if (payment?.method !== "KHQR" || payment.currency !== currency) create("KHQR", { currency });
    } else if (payment?.method !== m.code) create(m.code);
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{paid ? t("pay.paid") : t("pay.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("pay.order")} <span className="font-mono font-semibold text-foreground">{order.number}</span></p>
        </div>
        <div className="flex gap-2"><StatusBadge status={order.status} /><StatusBadge status={paid ? "PAID" : order.paymentStatus} /></div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-5">
          {cancelled || rejected ? (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-red-200 bg-red-50 p-8 text-center">
              <XCircle className="size-12 text-red-600" />
              <h2 className="text-lg font-bold">{t("status.CANCELLED")}</h2>
              {order.prescriptionNote && <p className="text-sm">{order.prescriptionNote}</p>}
              <Button asChild className="rounded-full"><Link href="/shop">{t("cart.continue")}</Link></Button>
            </div>
          ) : rxBlocked ? (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-8 text-center">
              <FileClock className="size-12 text-amber-600" />
              <h2 className="text-lg font-bold">{t("status.PENDING_REVIEW")}</h2>
              <p className="max-w-md text-sm text-amber-900">{t("pay.rxPending")}</p>
              <Button variant="outline" onClick={() => router.refresh()}>{t("pay.checkStatus")}</Button>
            </div>
          ) : paid ? (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-8 text-center">
              <CheckCircle2 className="size-14 text-emerald-600" />
              <p className="text-emerald-900">{t("pay.paidDesc")}</p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button asChild variant="outline"><a href={`/invoice/${encodeURIComponent(order.id)}${q}`} target="_blank" rel="noopener noreferrer"><Download /> {t("pay.receipt")}</a></Button>
                {order.customerId && <Button asChild><Link href={`/account/orders/${order.id}`}>{t("pay.viewOrder")}</Link></Button>}
              </div>
            </div>
          ) : (
            <>
              <section className="rounded-2xl border bg-white p-5 shadow-sm">
                <h2 className="mb-3 font-semibold">{t("pay.choose")}</h2>
                <div className="grid gap-3 sm:grid-cols-3">
                  {methods.map((m) => {
                    const Icon = ICONS[m.code];
                    return (
                      <button key={m.code} type="button" disabled={!m.ready || creating} onClick={() => choose(m)} title={m.reason}
                        className={cn("flex flex-col items-start gap-1 rounded-xl border p-4 text-left transition disabled:cursor-not-allowed disabled:opacity-50", method === m.code ? "border-primary bg-secondary ring-2 ring-primary/20" : "hover:border-primary/50")}>
                        <Icon className="size-6 text-primary" />
                        <span className="font-semibold">{locale === "km" ? m.nameKm : m.nameEn}</span>
                        {!m.ready && <span className="text-[11px] text-muted-foreground">{t("pay.unavailable")}{m.reason ? ` – ${m.reason}` : ""}</span>}
                      </button>
                    );
                  })}
                </div>
                {method === "KHQR" && (
                  <div className="mt-4 flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground">{t("pay.currencyLabel")}:</span>
                    {(methods.find((m) => m.code === "KHQR")?.currencies ?? ["USD"]).map((c) => (
                      <button key={c} onClick={() => { setCurrency(c as "USD" | "KHR"); create("KHQR", { currency: c as "USD" | "KHR" }); }} disabled={creating}
                        className={cn("rounded-full border px-3 py-1 font-medium", currency === c ? "border-primary bg-primary text-white" : "hover:border-primary")}>{c === "USD" ? `USD $${Number(order.total).toFixed(2)}` : `KHR ${formatKHR(totalKhr)}`}</button>
                    ))}
                  </div>
                )}
                {method === "USDT" && (methods.find((m) => m.code === "USDT")?.networks?.length ?? 0) > 0 && (
                  <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-muted-foreground">{t("pay.network")}:</span>
                    {methods.find((m) => m.code === "USDT")!.networks!.map((n) => (
                      <button key={n.code} onClick={() => { setNetwork(n.code); create("USDT", { network: n.code }); }} disabled={creating}
                        className={cn("rounded-full border px-3 py-1 font-medium", network === n.code ? "border-[#26a17b] bg-[#26a17b] text-white" : "hover:border-[#26a17b]")}>{n.label}</button>
                    ))}
                  </div>
                )}
              </section>
              <section className="rounded-2xl border bg-white p-5 shadow-sm">
                {creating ? <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground"><Loader2 className="animate-spin" /> {t("common.loading")}</div>
                  : payment && payment.method === method ? (
                    <PaymentPanel payment={payment} checkUrl={`/api/payments/${payment.id}/check${q}`} hashUrl={`/api/payments/${payment.id}/usdt-hash${q}`} captureUrl={`/api/payments/${payment.id}/paypal-capture${q}`}
                      onPaid={() => { setPaid(true); router.refresh(); }} onRetry={() => method && create(method)} />
                  ) : <div className="py-12 text-center text-sm text-muted-foreground">{t("pay.choose")}</div>}
              </section>
            </>
          )}
        </div>

        <aside className="h-fit space-y-3 rounded-2xl border bg-white p-5 shadow-sm">
          <h2 className="font-semibold">{t("checkout.review")}</h2>
          <ul className="divide-y text-sm">
            {order.items.map((i) => <li key={i.id} className="flex justify-between gap-3 py-2"><span>{pick(i, "name")} × {i.quantity}</span><span className="font-medium">{money(i.lineTotal)}</span></li>)}
          </ul>
          <dl className="space-y-1.5 border-t pt-3 text-sm">
            <div className="flex justify-between"><dt className="text-muted-foreground">{t("cart.subtotal")}</dt><dd>{money(order.subtotal)}</dd></div>
            {Number(order.discountAmount) > 0 && <div className="flex justify-between text-primary"><dt>{t("cart.discount")}</dt><dd>−{money(order.discountAmount)}</dd></div>}
            <div className="flex justify-between"><dt className="text-muted-foreground">{t("cart.delivery")}</dt><dd>{Number(order.deliveryFee) === 0 ? t("cart.free") : money(order.deliveryFee)}</dd></div>
            <div className="flex justify-between border-t pt-2 text-base font-bold"><dt>{t("cart.total")}</dt><dd className="text-right text-primary">${Number(order.total).toFixed(2)}<div className="text-xs font-normal text-muted-foreground">≈ {formatKHR(totalKhr)}</div></dd></div>
          </dl>
        </aside>
      </div>
    </div>
  );
}
