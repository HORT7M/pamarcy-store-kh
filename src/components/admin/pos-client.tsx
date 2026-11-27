"use client";

import { useEffect, useRef, useState } from "react";
import { Barcode, Search, Plus, Minus, Trash2, CheckCircle2, Printer, Banknote, QrCode, Wallet, CreditCard, AlertTriangle, Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ProductImage } from "@/components/common/product-image";
import { PaymentPanel } from "@/components/payment/payment-panel";
import type { MethodDto, PaymentViewDto } from "@/components/payment/types";
import type { ProductCard } from "@/lib/catalog";
import { useI18n } from "@/components/providers/i18n-provider";
import { formatKHR, round2, usdToKhr } from "@/lib/money";
import { api } from "@/lib/fetcher";
import { cn } from "@/lib/utils";

type Line = ProductCard & { qty: number };
type ActiveSale = { order: { id: string; number: string; total: string; exchangeRate: number }; payment: PaymentViewDto };

export function PosClient({ initialProducts, categories, methods, exchangeRate, canDispenseRx, canManualDiscount }: {
  initialProducts: ProductCard[]; categories: { slug: string; nameEn: string; nameKm: string }[]; methods: MethodDto[];
  exchangeRate: number; canDispenseRx: boolean; canManualDiscount: boolean;
}) {
  const { locale, t, tryT, tError, catName } = useI18n();
  const km = locale === "km";
  const scanRef = useRef<HTMLInputElement>(null);
  const [products, setProducts] = useState(initialProducts);
  const [cat, setCat] = useState("");
  const [scan, setScan] = useState("");
  const [cart, setCart] = useState<Line[]>([]);
  const [discountCode, setDiscountCode] = useState("");
  const [manualDiscount, setManualDiscount] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [method, setMethod] = useState<MethodDto["code"]>("CASH");
  const [khqrCurrency, setKhqrCurrency] = useState<"USD" | "KHR">("USD");
  const [usdtNetwork, setUsdtNetwork] = useState<string>(methods.find((m) => m.code === "USDT")?.networks?.[0]?.code ?? "TRC20");
  const [sale, setSale] = useState<ActiveSale | null>(null);
  const [tendered, setTendered] = useState("");
  const [changeDue, setChangeDue] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { scanRef.current?.focus(); }, []);

  function addItem(p: ProductCard) {
    if (p.available <= 0) return toast.error(t("pos.outOfStockToast", { name: km ? p.nameKm : p.nameEn }));
    if (p.requiresPrescription && !canDispenseRx) return toast.error(t("pos.rxOnlyToast"));
    setCart((prev) => {
      const ex = prev.find((l) => l.id === p.id);
      if (ex) {
        if (ex.qty >= p.available) { toast.error(t("pos.onlyAvailableToast", { n: p.available })); return prev; }
        return prev.map((l) => (l.id === p.id ? { ...l, qty: l.qty + 1 } : l));
      }
      return [...prev, { ...p, qty: 1 }];
    });
  }

  async function onScanSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = scan.trim();
    if (!q) return;
    try {
      const r = await api<{ exact: boolean; items: ProductCard[] }>(`/api/admin/pos/lookup?q=${encodeURIComponent(q)}`);
      if (r.exact && r.items[0]) {
        addItem(r.items[0]);
        setScan("");
      } else {
        setProducts(r.items);
        if (!r.items.length) toast.info(t("pos.noMatchToast"));
      }
    } catch (err) {
      toast.error(tError((err as Error).message));
    }
  }

  const visibleProducts = cat ? products.filter((p) => p.categorySlug === cat) : products;
  const subtotal = round2(cart.reduce((s, l) => s + l.price * l.qty, 0));
  const manDisc = canManualDiscount ? Math.min(subtotal, Math.max(0, Number(manualDiscount) || 0)) : 0;
  const estTotal = round2(Math.max(0, subtotal - manDisc));

  async function startCheckout() {
    if (!cart.length) return;
    setBusy(true);
    setChangeDue(null);
    try {
      const r = await api<ActiveSale>("/api/admin/pos/sale", {
        method: "POST",
        body: {
          items: cart.map((l) => ({ medicineId: l.id, quantity: l.qty })),
          discountCode: discountCode.trim() || null,
          manualDiscount: manDisc || undefined,
          customerName: customerName.trim() || null,
          customerPhone: customerPhone.trim() || "",
          method,
          currency: method === "KHQR" ? khqrCurrency : undefined,
          network: method === "USDT" ? usdtNetwork : undefined,
        },
      });
      setSale(r);
      setTendered(Number(r.order.total).toFixed(2));
    } catch (err) {
      toast.error(tError((err as Error).message));
    } finally {
      setBusy(false);
    }
  }

  async function completeCash() {
    if (!sale) return;
    const due = Number(sale.order.total);
    const cash = Number(tendered);
    if (isNaN(cash) || cash + 0.001 < due) return toast.error(t("pos.insufficientCashToast"));
    setBusy(true);
    try {
      const p = await api<PaymentViewDto>(`/api/admin/payments/${sale.payment.id}/cash`, { method: "POST", body: { tendered: cash } });
      setChangeDue(round2(cash - due));
      setSale({ ...sale, payment: p });
      toast.success(t("pos.saleCompletedToast"));
    } catch (err) {
      toast.error(tError((err as Error).message));
    } finally {
      setBusy(false);
    }
  }

  async function cancelActiveSale() {
    if (!sale) return;
    setBusy(true);
    try {
      await api("/api/admin/pos/cancel", { method: "POST", body: { orderId: sale.order.id } });
      setSale(null);
      toast.info(t("pos.saleCancelledToast"));
    } catch (err) {
      toast.error(tError((err as Error).message));
    } finally {
      setBusy(false);
    }
  }

  function finishAndReset() {
    setSale(null);
    setCart([]);
    setDiscountCode("");
    setManualDiscount("");
    setCustomerName("");
    setCustomerPhone("");
    setChangeDue(null);
    api<{ items: ProductCard[] }>("/api/products?pageSize=48&sort=popular").then((r) => setProducts(r.items)).catch(() => {});
    setTimeout(() => scanRef.current?.focus(), 100);
  }

  const methodIcons = { CASH: Banknote, KHQR: QrCode, USDT: Wallet, PAYPAL: CreditCard };
  const methodShortLabel = (code: MethodDto["code"]) => (code === "CASH" ? tryT("catalogData.paymentMethods.CASH", code) : code === "PAYPAL" ? "PayPal" : code);

  return (
    <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
      {/* Left: Scanner & Product Grid */}
      <div className="min-w-0 space-y-4">
        <form onSubmit={onScanSubmit} className="flex gap-2 rounded-2xl border bg-white p-3 shadow-sm">
          <div className="relative flex-1">
            <Barcode className="absolute left-3 top-2.5 size-4 text-primary" />
            <Input ref={scanRef} value={scan} onChange={(e) => setScan(e.target.value)} placeholder={t("pos.scanPlaceholder")} className="pl-9" />
          </div>
          <Button type="submit" variant="secondary"><Search className="size-4" /> {t("pos.lookup")}</Button>
          {scan && <Button type="button" variant="ghost" onClick={() => { setScan(""); setProducts(initialProducts); }}>{t("common.reset")}</Button>}
        </form>

        <div className="flex gap-1.5 overflow-x-auto pb-1">
          <Button size="sm" variant={cat === "" ? "default" : "outline"} className="rounded-full shrink-0" onClick={() => setCat("")}>{t("common.all")}</Button>
          {categories.map((c) => (
            <Button key={c.slug} size="sm" variant={cat === c.slug ? "default" : "outline"} className="rounded-full shrink-0" onClick={() => setCat(c.slug)}>
              {catName(c)}
            </Button>
          ))}
        </div>

        <div className="grid min-w-0 grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4">
          {visibleProducts.map((p) => {
            const out = p.available <= 0;
            return (
              <button
                key={p.id}
                type="button"
                disabled={out}
                onClick={() => addItem(p)}
                className="flex flex-col overflow-hidden rounded-xl border bg-white text-left shadow-xs transition hover:border-primary disabled:opacity-45"
              >
                <div className="relative">
                  <ProductImage src={p.imageUrl} alt={km ? p.nameKm : p.nameEn} className="aspect-[4/3] w-full" sizes="180px" />
                  {p.requiresPrescription && <Badge className="absolute left-1.5 top-1.5 bg-amber-500 text-[10px] text-white">Rx</Badge>}
                </div>
                <div className="flex flex-1 flex-col p-2.5">
                  <div className="line-clamp-2 text-xs font-semibold leading-snug">{km ? p.nameKm : p.nameEn}</div>
                  <div className="mt-auto flex items-baseline justify-between pt-2">
                    <span className="text-sm font-bold text-primary">${p.price.toFixed(2)}</span>
                    <span className="text-[10px] text-muted-foreground">{t("pos.inStockCount", { n: p.available })}</span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Right: POS Cart & Payment */}
      <div className="flex h-fit min-w-0 flex-col space-y-4 rounded-2xl border bg-white p-4 shadow-sm lg:sticky lg:top-20">
        <div className="flex items-center justify-between border-b pb-2.5">
          <h2 className="font-bold">{t("pos.counterSale")}</h2>
          {cart.length > 0 && <button onClick={() => setCart([])} className="text-xs text-red-600 hover:underline">{t("common.clear")}</button>}
        </div>

        {!canDispenseRx && (
          <div className="flex items-center gap-2 rounded-lg bg-amber-50 p-2 text-[11px] text-amber-900">
            <AlertTriangle className="size-3.5 shrink-0" /> {t("pos.otcOnlyNotice")}
          </div>
        )}

        <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
          {cart.length === 0 ? (
            <div className="py-10 text-center text-xs text-muted-foreground">{t("pos.emptyHint")}</div>
          ) : (
            cart.map((l) => (
              <div key={l.id} className="flex items-center gap-2 rounded-xl border p-2 text-xs">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{km ? l.nameKm : l.nameEn}</div>
                  <div className="text-muted-foreground">${l.price.toFixed(2)} × {l.qty} = <b>${(l.price * l.qty).toFixed(2)}</b></div>
                </div>
                <div className="flex items-center rounded-full border">
                  <button type="button" className="p-1" onClick={() => setCart((c) => c.map((x) => (x.id === l.id ? { ...x, qty: Math.max(1, x.qty - 1) } : x)))}><Minus className="size-3" /></button>
                  <span className="w-6 text-center font-medium">{l.qty}</span>
                  <button type="button" className="p-1" onClick={() => setCart((c) => c.map((x) => (x.id === l.id ? { ...x, qty: Math.min(l.available, x.qty + 1) } : x)))}><Plus className="size-3" /></button>
                </div>
                <button type="button" className="p-1 text-red-600" onClick={() => setCart((c) => c.filter((x) => x.id !== l.id))}><Trash2 className="size-3.5" /></button>
              </div>
            ))
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 border-t pt-3">
          <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder={t("pos.customerNamePh")} className="h-8 text-xs" />
          <Input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} placeholder={t("pos.phonePh")} className="h-8 text-xs" />
          <Input value={discountCode} onChange={(e) => setDiscountCode(e.target.value.toUpperCase())} placeholder={t("pos.promoCodePh")} className="h-8 text-xs uppercase" />
          {canManualDiscount && <Input type="number" min={0} step="0.01" value={manualDiscount} onChange={(e) => setManualDiscount(e.target.value)} placeholder={t("pos.manualDiscPh")} className="h-8 text-xs" />}
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">{t("pos.paymentMethod")}</Label>
          <div className="grid grid-cols-4 gap-1.5">
            {methods.map((m) => {
              const Icon = methodIcons[m.code];
              return (
                <button
                  key={m.code}
                  type="button"
                  disabled={!m.ready}
                  title={m.reason ? tError(m.reason) : undefined}
                  onClick={() => setMethod(m.code)}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-xl border p-2 text-[11px] font-semibold transition disabled:opacity-40",
                    method === m.code ? "border-primary bg-secondary text-primary" : "hover:border-primary/40",
                  )}
                >
                  <Icon className="size-4" />
                  <span className="truncate max-w-full">{methodShortLabel(m.code)}</span>
                </button>
              );
            })}
          </div>
          {method === "KHQR" && (
            <div className="flex gap-1.5 pt-1">
              {(methods.find((m) => m.code === "KHQR")?.currencies ?? ["USD", "KHR"]).map((c) => (
                <button key={c} type="button" onClick={() => setKhqrCurrency(c as "USD" | "KHR")} className={cn("rounded-full border px-2.5 py-0.5 text-xs", khqrCurrency === c ? "bg-primary text-white" : "")}>{c}</button>
              ))}
            </div>
          )}
          {method === "USDT" && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {(methods.find((m) => m.code === "USDT")?.networks ?? []).map((n) => (
                <button key={n.code} type="button" onClick={() => setUsdtNetwork(n.code)} className={cn("rounded-full border px-2.5 py-0.5 text-xs", usdtNetwork === n.code ? "bg-[#26a17b] text-white" : "")}>{n.code}</button>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-1 rounded-xl bg-muted/60 p-3 text-sm">
          <div className="flex justify-between text-xs text-muted-foreground"><span>{t("pos.subtotal")}</span><span>${subtotal.toFixed(2)}</span></div>
          {manDisc > 0 && <div className="flex justify-between text-xs text-primary"><span>{t("pos.manualDiscount")}</span><span>−${manDisc.toFixed(2)}</span></div>}
          <div className="flex items-baseline justify-between border-t pt-1.5">
            <span className="font-bold">{t("pos.total")}</span>
            <div className="text-right">
              <div className="text-xl font-extrabold text-primary">${estTotal.toFixed(2)}</div>
              <div className="text-xs text-muted-foreground">≈ {formatKHR(usdToKhr(estTotal, exchangeRate))}</div>
            </div>
          </div>
        </div>

        <Button size="lg" className="w-full rounded-xl" disabled={!cart.length || busy} onClick={startCheckout}>
          {busy && <Loader2 className="animate-spin" />} {t("pos.chargeBtn", { amount: estTotal.toFixed(2), method: methodShortLabel(method) })}
        </Button>
      </div>

      {/* POS Payment / Receipt Modal */}
      <Dialog open={!!sale} onOpenChange={() => {}}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-md" onInteractOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between">
              <span>{t("pos.posSaleTitle", { number: sale?.order.number ?? "" })}</span>
              <span className="font-mono text-primary">${sale ? Number(sale.order.total).toFixed(2) : "0.00"}</span>
            </DialogTitle>
          </DialogHeader>

          {sale && sale.payment.status === "PAID" ? (
            <div className="space-y-4 py-2 text-center">
              <CheckCircle2 className="mx-auto size-14 text-emerald-600" />
              <div className="text-xl font-bold text-emerald-800">{t("pos.paymentVerified")}</div>
              {changeDue !== null && changeDue > 0 && (
                <div className="rounded-xl bg-secondary p-3">
                  <div className="text-xs text-muted-foreground">{t("pos.changeDue")}</div>
                  <div className="text-2xl font-extrabold text-primary">${changeDue.toFixed(2)}</div>
                  <div className="text-xs text-muted-foreground">≈ {formatKHR(usdToKhr(changeDue, sale.order.exchangeRate))}</div>
                </div>
              )}
              <div className="flex justify-center gap-2 pt-2">
                <Button asChild variant="outline"><a href={`/invoice/${encodeURIComponent(sale.order.id)}?format=receipt`} target="_blank" rel="noopener noreferrer"><Printer /> {t("pos.printReceipt")}</a></Button>
                <Button onClick={finishAndReset}>{t("pos.newSale")}</Button>
              </div>
            </div>
          ) : sale && sale.payment.method === "CASH" ? (
            <div className="space-y-4">
              <div className="rounded-xl bg-accent p-3 text-center">
                <div className="text-xs text-accent-foreground">{t("pos.amountDue")}</div>
                <div className="text-2xl font-extrabold">${Number(sale.order.total).toFixed(2)}</div>
                <div className="text-xs text-muted-foreground">{formatKHR(usdToKhr(sale.order.total, sale.order.exchangeRate))}</div>
              </div>
              <div className="space-y-1.5">
                <Label>{t("pos.cashTendered")}</Label>
                <Input type="number" step="0.01" value={tendered} onChange={(e) => setTendered(e.target.value)} className="text-lg font-bold" />
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {[Number(sale.order.total), 5, 10, 20, 50, 100].filter((v, i, a) => v >= Number(sale.order.total) && a.indexOf(v) === i).map((v) => (
                    <Button key={v} type="button" size="sm" variant="outline" onClick={() => setTendered(v.toFixed(2))}>${v.toFixed(2)}</Button>
                  ))}
                </div>
              </div>
              {Number(tendered) >= Number(sale.order.total) && (
                <div className="flex justify-between rounded-lg bg-secondary px-3 py-2 text-sm font-semibold">
                  <span>{t("pos.change")}</span><span className="text-primary">${(Number(tendered) - Number(sale.order.total)).toFixed(2)}</span>
                </div>
              )}
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1 text-red-600" onClick={cancelActiveSale} disabled={busy}><XCircle /> {t("common.cancel")}</Button>
                <Button className="flex-1" onClick={completeCash} disabled={busy}>{busy && <Loader2 className="animate-spin" />} {t("pos.confirmCashPaid")}</Button>
              </div>
            </div>
          ) : sale ? (
            <div className="space-y-3">
              <PaymentPanel
                compact
                payment={sale.payment}
                checkUrl={`/api/admin/payments/${sale.payment.id}/check`}
                hashUrl={`/api/payments/${sale.payment.id}/usdt-hash`}
                onPaid={(p) => setSale((prev) => (prev ? { ...prev, payment: p } : null))}
              />
              <Button variant="outline" className="w-full text-red-600" onClick={cancelActiveSale} disabled={busy}><XCircle /> {t("pos.cancelUnpaidSale")}</Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
