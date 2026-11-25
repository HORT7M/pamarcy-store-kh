"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageHeader, Pagination } from "./common";
import { useI18n } from "@/components/providers/i18n-provider";
import { formatDateTime } from "@/lib/date";
import { api } from "@/lib/fetcher";

type Mv = { id: string; type: string; quantity: number; balanceAfter: number | null; unitCost: string | null; reference: string | null; reason: string | null; createdAt: string; userName: string | null; medicine: { nameEn: string; sku: string }; batch: { batchNumber: string } | null };

export function MovementsClient() {
  const { t, tryT } = useI18n();
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; pageSize: number; items: Mv[] } | null>(null);

  const load = useCallback(() => {
    const sp = new URLSearchParams({ page: String(page), pageSize: "30" });
    if (q) sp.set("q", q);
    if (type) sp.set("type", type);
    api<typeof data>(`/api/admin/inventory/movements?${sp}`).then(setData);
  }, [q, type, page]);
  useEffect(() => { const id = setTimeout(load, 200); return () => clearTimeout(id); }, [load]);

  return (
    <div className="space-y-4">
      <Link href="/admin/inventory" className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"><ArrowLeft className="size-4" /> {t("inventoryAdmin.backToInventory")}</Link>
      <PageHeader title={t("inventoryAdmin.movementsTitle")} subtitle={t("inventoryAdmin.movementsSubtitle")} />
      <div className="flex flex-wrap gap-2 rounded-2xl border bg-white p-3 shadow-sm">
        <div className="relative min-w-56 flex-1"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder={t("inventoryAdmin.movementsSearchPh")} className="pl-9" /></div>
        <select className="h-9 rounded-md border bg-white px-3 text-sm" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}>
          <option value="">{t("inventoryAdmin.allMovements")}</option>
          {["STOCK_IN", "STOCK_OUT", "PURCHASE_RECEIVE", "SALE", "ADJUSTMENT", "RETURN", "EXPIRED_WRITE_OFF"].map((ty) => <option key={ty} value={ty}>{tryT(`status.${ty}`, ty.replace(/_/g, " "))}</option>)}
        </select>
      </div>
      <div className="overflow-x-auto rounded-2xl border bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-3">{t("common.date")}</th>
              <th className="p-3">{t("inventoryAdmin.colMedicine")}</th>
              <th className="p-3">{t("medicinesAdmin.colBatchNo")}</th>
              <th className="p-3">{t("medicinesAdmin.colType")}</th>
              <th className="p-3 text-right">{t("common.qty")}</th>
              <th className="p-3 text-right">{t("inventoryAdmin.colBalance")}</th>
              <th className="p-3">{t("inventoryAdmin.colRefReason")}</th>
              <th className="p-3">{t("inventoryAdmin.colStaff")}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {data?.items.map((m) => (
              <tr key={m.id}>
                <td className="whitespace-nowrap p-3 text-xs">{formatDateTime(m.createdAt)}</td>
                <td className="p-3"><div className="font-medium">{m.medicine.nameEn}</div><div className="font-mono text-xs text-muted-foreground">{m.medicine.sku}</div></td>
                <td className="p-3 font-mono text-xs">{m.batch?.batchNumber ?? "—"}</td>
                <td className="p-3"><Badge variant="outline" className="text-[11px]">{tryT(`status.${m.type}`, m.type.replace(/_/g, " "))}</Badge></td>
                <td className={`p-3 text-right font-bold ${m.quantity > 0 ? "text-primary" : "text-red-600"}`}>{m.quantity > 0 ? `+${m.quantity}` : m.quantity}</td>
                <td className="p-3 text-right text-xs">{m.balanceAfter ?? "—"}</td>
                <td className="p-3 text-xs text-muted-foreground">{[m.reference, m.reason].filter(Boolean).join(" · ") || "—"}</td>
                <td className="p-3 text-xs">{m.userName ?? t("common.system")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && <Pagination page={page} pageSize={data.pageSize} total={data.total} onChange={setPage} />}
    </div>
  );
}
