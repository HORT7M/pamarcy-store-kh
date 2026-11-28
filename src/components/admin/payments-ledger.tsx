"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Search, RefreshCw, CheckCircle2, Clock, XCircle, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/common/status-badge";
import { PageHeader, StatCard, Pagination } from "./common";
import { useI18n } from "@/components/providers/i18n-provider";
import { formatDateTime } from "@/lib/date";
import { api } from "@/lib/fetcher";

type PayRow = {
  id: string; reference: string; status: string; currency: string; amount: string; amountUsd: string; network: string | null;
  providerTxnId: string | null; paidAt: string | null; createdAt: string;
  method: { code: string; nameEn: string }; order: { id: string; number: string; fullName: string; channel: string };
};

export function PaymentsLedgerClient() {
  const { money, t, tryT, tError } = useI18n();
  const [q, setQ] = useState("");
  const [method, setMethod] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; pageSize: number; items: PayRow[]; summary: Record<string, { count: number; amountUsd: number }> } | null>(null);
  const [checking, setChecking] = useState<string | null>(null);

  const load = useCallback(() => {
    const sp = new URLSearchParams({ page: String(page), pageSize: "25" });
    if (q) sp.set("q", q);
    if (method) sp.set("method", method);
    if (status) sp.set("status", status);
    api<typeof data>(`/api/admin/payments?${sp}`).then(setData).catch((e) => toast.error(tError((e as Error).message)));
  }, [q, method, status, page, tError]);
  useEffect(() => { const id = setTimeout(load, 200); return () => clearTimeout(id); }, [load]);

  async function check(id: string) {
    setChecking(id);
    try { await api(`/api/admin/payments/${id}/check`, { method: "POST" }); toast.success(t("paymentsAdmin.refreshedToast")); load(); }
    catch (e) { toast.error(tError((e as Error).message)); }
    finally { setChecking(null); }
  }

  const sel = "h-9 rounded-md border bg-white px-3 text-sm";

  return (
    <div className="space-y-5">
      <PageHeader title={t("paymentsAdmin.title")} subtitle={t("paymentsAdmin.subtitle")} />
      {data && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard icon={CheckCircle2} tone="green" label={t("paymentsAdmin.kpiPaid")} value={money(data.summary.PAID?.amountUsd ?? 0)} sub={t("paymentsAdmin.paymentsCountSub", { n: data.summary.PAID?.count ?? 0 })} />
          <StatCard icon={Clock} tone="amber" label={t("paymentsAdmin.kpiPending")} value={(data.summary.PENDING?.count ?? 0) + (data.summary.PROCESSING?.count ?? 0)} sub={money((data.summary.PENDING?.amountUsd ?? 0) + (data.summary.PROCESSING?.amountUsd ?? 0))} />
          <StatCard icon={XCircle} tone="red" label={t("paymentsAdmin.kpiFailedExpired")} value={(data.summary.FAILED?.count ?? 0) + (data.summary.EXPIRED?.count ?? 0)} />
          <StatCard icon={RotateCcw} tone="slate" label={t("paymentsAdmin.kpiRefunded")} value={money(data.summary.REFUNDED?.amountUsd ?? 0)} sub={t("paymentsAdmin.refundsCountSub", { n: data.summary.REFUNDED?.count ?? 0 })} />
        </div>
      )}
      <div className="flex flex-wrap gap-2 rounded-2xl border bg-white p-3 shadow-sm">
        <div className="relative min-w-56 flex-1"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder={t("paymentsAdmin.searchPh")} className="pl-9" /></div>
        <select className={sel} value={method} onChange={(e) => { setMethod(e.target.value); setPage(1); }}>
          <option value="">{t("paymentsAdmin.allMethods")}</option>
          {["KHQR", "USDT", "PAYPAL", "CASH"].map((m) => <option key={m} value={m}>{tryT(`catalogData.paymentMethods.${m}`, m)}</option>)}
        </select>
        <select className={sel} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">{t("paymentsAdmin.allStatuses")}</option>
          {["PENDING", "PROCESSING", "PAID", "FAILED", "EXPIRED", "REFUNDED"].map((s) => <option key={s} value={s}>{tryT(`status.${s}`, s)}</option>)}
        </select>
      </div>
      <div className="overflow-x-auto rounded-2xl border bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-3">{t("paymentsAdmin.colReference")}</th>
              <th className="p-3">{t("paymentsAdmin.colOrder")}</th>
              <th className="p-3">{t("paymentsAdmin.colMethod")}</th>
              <th className="p-3 text-right">{t("paymentsAdmin.colAmount")}</th>
              <th className="p-3">{t("common.status")}</th>
              <th className="p-3">{t("paymentsAdmin.colProviderTxn")}</th>
              <th className="p-3 text-right">{t("common.date")}</th>
              <th className="p-3 text-right">{t("inventoryAdmin.action")}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {data?.items.map((p) => (
              <tr key={p.id}>
                <td className="p-3 font-mono text-xs">{p.reference}</td>
                <td className="p-3"><Link href={`/admin/orders/${p.order.id}`} className="font-mono text-primary hover:underline">{p.order.number}</Link><div className="text-xs text-muted-foreground">{p.order.fullName}</div></td>
                <td className="p-3 text-xs font-medium">{tryT(`catalogData.paymentMethods.${p.method.code}`, p.method.code)}{p.network ? ` · ${p.network}` : ""}</td>
                <td className="whitespace-nowrap p-3 text-right font-semibold">{p.currency} {p.currency === "USDT" ? Number(p.amount).toFixed(4) : Number(p.amount).toFixed(p.currency === "KHR" ? 0 : 2)}<div className="text-[11px] font-normal text-muted-foreground">${Number(p.amountUsd).toFixed(2)}</div></td>
                <td className="p-3"><StatusBadge status={p.status} /></td>
                <td className="max-w-44 truncate p-3 font-mono text-[11px] text-muted-foreground" title={p.providerTxnId ?? ""}>{p.providerTxnId ?? "—"}</td>
                <td className="whitespace-nowrap p-3 text-right text-xs text-muted-foreground">{formatDateTime(p.paidAt ?? p.createdAt)}</td>
                <td className="p-3 text-right">
                  {(p.status === "PENDING" || p.status === "PROCESSING") && p.method.code !== "CASH" && (
                    <Button size="sm" variant="outline" onClick={() => check(p.id)} disabled={checking === p.id}><RefreshCw className={`size-3.5 ${checking === p.id ? "animate-spin" : ""}`} /></Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && <Pagination page={page} pageSize={data.pageSize} total={data.total} onChange={setPage} />}
    </div>
  );
}
