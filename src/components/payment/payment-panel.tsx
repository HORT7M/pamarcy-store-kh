"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Loader2, CheckCircle2, XCircle, Clock, Copy, ExternalLink, AlertTriangle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/components/providers/i18n-provider";
import { api } from "@/lib/fetcher";
import { formatKHR } from "@/lib/money";
import { safeExplorerTxUrl, safeImageSrc, safePaypalApproveUrl } from "@/lib/sanitize";
import type { PaymentViewDto } from "./types";

function useCountdown(to: string | null) {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!to) return setLeft(null);
    const tick = () => setLeft(Math.max(0, new Date(to).getTime() - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [to]);
  return left;
}

function CopyRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
        <span className={mono ? "flex-1 break-all font-mono text-xs" : "flex-1 font-semibold"}>{value}</span>
        <button type="button" onClick={() => { navigator.clipboard.writeText(value); toast.success(t("common.copied")); }} className="rounded p-1 hover:bg-white" aria-label={t("common.copy")}><Copy className="size-4" /></button>
      </div>
    </div>
  );
}

/**
 * Renders a payment request (KHQR / USDT / PayPal) and polls the SERVER for status.
 * The UI never decides that a payment succeeded – it only displays what the backend verified.
 */
export function PaymentPanel({ payment: initial, checkUrl, hashUrl, captureUrl, requestHeaders, onPaid, onRetry, compact }: {
  payment: PaymentViewDto; checkUrl: string; hashUrl?: string; captureUrl?: string; requestHeaders?: Record<string, string>; onPaid?: (p: PaymentViewDto) => void; onRetry?: () => void; compact?: boolean;
}) {
  const { t, tError } = useI18n();
  const [p, setP] = useState(initial);
  const [hash, setHash] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(false);
  const left = useCountdown(p.status === "PENDING" ? p.expiresAt : null);
  const paidFired = useRef(false);

  useEffect(() => setP(initial), [initial]);
  useEffect(() => {
    if (p.status === "PAID" && !paidFired.current) { paidFired.current = true; onPaid?.(p); }
  }, [p, onPaid]);

  const check = useCallback(async (manual = false) => {
    if (manual) setChecking(true);
    try {
      setP(await api<PaymentViewDto>(checkUrl, { method: "POST", headers: requestHeaders }));
    } catch (e) {
      if (manual) toast.error(tError((e as Error).message));
    } finally {
      if (manual) setChecking(false);
    }
  }, [checkUrl, requestHeaders, tError]);

  useEffect(() => {
    if (p.status !== "PENDING" && p.status !== "PROCESSING") return;
    if (p.method === "CASH") return;
    const interval = p.method === "USDT" ? 15000 : 5000;
    const id = setInterval(() => document.visibilityState === "visible" && check(), interval);
    return () => clearInterval(id);
  }, [p.status, p.method, check]);

  async function submitHash(e: React.FormEvent) {
    e.preventDefault();
    if (!hashUrl) return;
    setSubmitting(true);
    try {
      setP(await api<PaymentViewDto>(hashUrl, { method: "POST", headers: requestHeaders, body: { txHash: hash } }));
    } catch (err) {
      toast.error(tError((err as Error).message));
    } finally {
      setSubmitting(false);
    }
  }

  const mm = left !== null ? `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}` : null;
  const amountLabel = p.currency === "KHR" ? formatKHR(Number(p.amount)) : p.currency === "USDT" ? `${p.amount} USDT` : `$${p.amount}`;
  const safeQrSrc = safeImageSrc(p.qrDataUrl, { allowQrPngDataUrl: true });
  const safePaypalUrl = safePaypalApproveUrl(p.paypalApproveUrl);
  const safeTxExplorerUrl = p.network && p.txHash ? safeExplorerTxUrl(p.network.explorer, p.txHash) : null;

  if (p.status === "PAID") {
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-8 text-center">
        <CheckCircle2 className="size-14 text-emerald-600" />
        <h3 className="text-xl font-bold text-emerald-800">{t("pay.paid")}</h3>
        <p className="text-sm text-emerald-900">{t("pay.paidDesc")}</p>
        <p className="font-mono text-xs text-emerald-800">{t("pay.reference")}: {p.reference}</p>
        {p.providerTxnId && <p className="break-all font-mono text-[11px] text-emerald-700">{p.providerTxnId}</p>}
      </div>
    );
  }
  if (p.status === "FAILED" || p.status === "EXPIRED" || (p.status === "PENDING" && left === 0)) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-red-200 bg-red-50 p-8 text-center">
        {p.status === "FAILED" ? <XCircle className="size-12 text-red-600" /> : <Clock className="size-12 text-slate-500" />}
        <h3 className="text-lg font-bold">{p.status === "FAILED" ? t("pay.failed") : t("pay.expired")}</h3>
        {p.failureReason && <p className="text-sm text-red-800">{p.failureReason}</p>}
        {onRetry && <Button onClick={onRetry} className="rounded-full"><RefreshCw /> {t("pay.newQr")}</Button>}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-accent px-4 py-3">
        <div>
          <div className="text-xs text-accent-foreground">{t("pay.amount")}</div>
          <div className="text-2xl font-extrabold text-foreground">{amountLabel}</div>
          {p.currency !== "USD" && <div className="text-xs text-muted-foreground">= ${p.amountUsd} USD</div>}
        </div>
        <div className="text-right text-sm">
          {p.status === "PROCESSING" ? <span className="flex items-center gap-1.5 font-medium text-indigo-700"><Loader2 className="size-4 animate-spin" />{t("pay.processing")}</span> : <span className="flex items-center gap-1.5 text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("pay.waiting")}</span>}
          {mm && <div className="mt-1 text-xs">{t("pay.expiresIn")} <span className="font-mono font-semibold">{mm}</span></div>}
        </div>
      </div>

      {p.method === "KHQR" && safeQrSrc && (
        <div className="flex flex-col items-center gap-3">
          <div className="w-full max-w-[300px] overflow-hidden rounded-2xl border-2 border-[#e1232e] bg-white shadow-md">
            <div className="flex items-center justify-between bg-[#e1232e] px-4 py-2.5 text-white"><span className="text-lg font-black tracking-wide">KHQR</span><span className="text-[10px] opacity-90">Bakong · NBC</span></div>
            <div className="border-b border-dashed px-4 py-2">
              <div className="text-xs text-muted-foreground">{p.merchant?.name}</div>
              <div className="text-xl font-bold">{amountLabel}</div>
            </div>
            <Image src={safeQrSrc} alt="KHQR payment code" width={320} height={320} className="h-auto w-full p-3" unoptimized />
          </div>
          <p className="max-w-sm text-center text-xs text-muted-foreground">{t("pay.scanKhqr")}</p>
          {p.merchant && !compact && (
            <div className="w-full max-w-sm rounded-lg border bg-white p-3 text-xs">
              <div className="flex justify-between"><span className="text-muted-foreground">{t("pay.merchant")}</span><span className="font-medium">{p.merchant.name}, {p.merchant.city}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Bakong ID</span><span className="font-mono">{p.merchant.account}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">{t("pay.reference")}</span><span className="font-mono">{p.reference}</span></div>
            </div>
          )}
        </div>
      )}

      {p.method === "USDT" && p.network && (
        <div className="space-y-4">
          <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"><AlertTriangle className="size-4 shrink-0" />{t("pay.usdtOnly")}</div>
          <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
            {safeQrSrc && <Image src={safeQrSrc} alt="USDT payment QR" width={180} height={180} className="mx-auto rounded-xl border bg-white p-2" unoptimized />}
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm"><span className="rounded-md bg-[#26a17b] px-2 py-0.5 text-xs font-bold text-white">USDT</span><span className="font-semibold">{p.network.label}</span></div>
              <CopyRow label={t("pay.amount")} value={p.amount} />
              {p.payTo && <CopyRow label={t("pay.wallet")} value={p.payTo} mono />}
            </div>
          </div>
          {!compact && <>
            <div className="space-y-1 text-xs"><div className="text-muted-foreground">{t("pay.contract")}</div><div className="break-all font-mono">{p.network.contract}</div></div>
            <div className="text-xs text-muted-foreground">{t("pay.confirmations")}: {p.network.confirmations} · {t("pay.exact")}</div>
            <p className="rounded-lg bg-muted p-3 text-xs leading-relaxed">{t("pay.usdtSteps")}</p>
          </>}
          {p.txHash ? (
            <div className="space-y-1 rounded-lg border bg-white p-3 text-xs">
              <div className="text-muted-foreground">{t("pay.txHash")}</div>
              {safeTxExplorerUrl ? (
                <a href={safeTxExplorerUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 break-all font-mono text-brand-blue hover:underline">{p.txHash} <ExternalLink className="size-3 shrink-0" /></a>
              ) : (
                <span className="break-all font-mono">{p.txHash}</span>
              )}
              {p.failureReason && <div className="text-indigo-700">{p.failureReason}</div>}
            </div>
          ) : (
            hashUrl && (
              <form onSubmit={submitHash} className="space-y-2">
                <label className="text-sm font-medium" htmlFor="txhash">{t("pay.txHash")}</label>
                <div className="flex gap-2">
                  <Input id="txhash" value={hash} onChange={(e) => setHash(e.target.value)} placeholder={p.network.code === "TRC20" ? "64-character hex" : "0x…"} className="font-mono text-xs" maxLength={100} />
                  <Button type="submit" disabled={submitting || hash.trim().length < 20}>{submitting ? <Loader2 className="animate-spin" /> : t("pay.submitHash")}</Button>
                </div>
                {p.failureReason && <p className="text-xs text-red-600">{p.failureReason}</p>}
              </form>
            )
          )}
        </div>
      )}

      {p.method === "PAYPAL" && (
        <div className="space-y-3 text-center">
          <p className="text-sm text-muted-foreground">{t("pay.paypalDesc")}</p>
          {safePaypalUrl && (
            <>
              <Button asChild size="lg" className="w-full rounded-full bg-[#ffc439] text-[#003087] hover:bg-[#f2ba36]">
                <a href={safePaypalUrl} rel="noopener noreferrer"><span className="font-extrabold italic">Pay</span><span className="-ml-1.5 font-extrabold italic text-[#009cde]">Pal</span> — {t("pay.payWithPaypal")}</a>
              </Button>
              {compact && safeQrSrc && <Image src={safeQrSrc} alt="PayPal link QR" width={180} height={180} className="mx-auto rounded-xl border p-2" unoptimized />}
            </>
          )}
          {captureUrl && <p className="text-xs text-muted-foreground">PayPal ID: <span className="font-mono">{p.paypalOrderId}</span></p>}
        </div>
      )}

      {p.method !== "CASH" && (
        <Button variant="outline" className="w-full" onClick={() => check(true)} disabled={checking}>
          {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />} {t("pay.checkStatus")}
        </Button>
      )}
    </div>
  );
}
