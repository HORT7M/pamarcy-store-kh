"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Trash2, CalendarX2, Clock, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader, StatCard } from "./common";
import { useI18n } from "@/components/providers/i18n-provider";
import { formatDate } from "@/lib/date";
import { api } from "@/lib/fetcher";

type ExBatch = { id: string; batchNumber: string; expiryDate: string; quantity: number; reserved: number; costPrice: string; medicine: { id: string; nameEn: string; nameKm: string; sku: string }; supplier: { name: string } | null };
type Data = { expired: ExBatch[]; within7: ExBatch[]; within30: ExBatch[]; within90: ExBatch[] };

export function ExpiryClient({ canWrite }: { canWrite: boolean }) {
  const { locale, t, tError } = useI18n();
  const km = locale === "km";
  const [data, setData] = useState<Data | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const load = useCallback(() => { api<Data>("/api/admin/inventory/expiry").then(setData); }, []);
  useEffect(load, [load]);

  async function writeOff(b: ExBatch) {
    const medName = km ? b.medicine.nameKm : b.medicine.nameEn;
    if (!confirm(t("inventoryAdmin.confirmWriteOff", { n: b.quantity, name: medName, batch: b.batchNumber }))) return;
    setBusyId(b.id);
    try {
      await api(`/api/admin/inventory/batches/${b.id}`, { method: "POST", body: { mode: "out", quantity: b.quantity - b.reserved, reason: "Expired stock write-off", type: "EXPIRED_WRITE_OFF" } });
      toast.success(t("inventoryAdmin.writtenOffToast"));
      load();
    } catch (e) {
      toast.error(tError((e as Error).message));
    } finally {
      setBusyId(null);
    }
  }

  function renderTable(rows: ExBatch[], expired?: boolean) {
    if (!rows.length) return <div className="rounded-2xl border bg-white p-8 text-center text-sm text-muted-foreground">{t("inventoryAdmin.noBatchesWindow")}</div>;
    return (
      <div className="overflow-x-auto rounded-2xl border bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-3">{t("inventoryAdmin.colMedicine")}</th>
              <th className="p-3">{t("medicinesAdmin.colBatchNo")}</th>
              <th className="p-3">{t("medicinesAdmin.colSupplier")}</th>
              <th className="p-3">{t("medicinesAdmin.colExpiry")}</th>
              <th className="p-3 text-right">{t("common.qty")}</th>
              <th className="p-3 text-right">{t("inventoryAdmin.colCostAtRisk")}</th>
              {expired && canWrite && <th className="p-3 text-right">{t("inventoryAdmin.action")}</th>}
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((b) => (
              <tr key={b.id}>
                <td className="p-3"><Link href={`/admin/medicines/${b.medicine.id}`} className="font-medium hover:text-primary">{km ? b.medicine.nameKm : b.medicine.nameEn}</Link><div className="font-mono text-xs text-muted-foreground">{b.medicine.sku}</div></td>
                <td className="p-3 font-mono text-xs">{b.batchNumber}</td>
                <td className="p-3 text-xs text-muted-foreground">{b.supplier?.name ?? "—"}</td>
                <td className="p-3"><Badge variant={expired ? "destructive" : "outline"}>{formatDate(b.expiryDate)}</Badge></td>
                <td className="p-3 text-right font-semibold">{b.quantity}</td>
                <td className="p-3 text-right">${(b.quantity * Number(b.costPrice)).toFixed(2)}</td>
                {expired && canWrite && (
                  <td className="p-3 text-right">
                    <Button size="sm" variant="destructive" onClick={() => writeOff(b)} disabled={busyId === b.id || b.quantity - b.reserved <= 0}>
                      {busyId === b.id ? <Loader2 className="animate-spin" /> : <Trash2 className="size-3.5" />} {t("inventoryAdmin.writeOff")}
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader title={t("inventoryAdmin.expiryTitle")} subtitle={t("inventoryAdmin.expirySubtitle")} />
      <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        <AlertTriangle className="size-4 shrink-0" /> {t("inventoryAdmin.expiryNotice")}
      </div>
      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard icon={CalendarX2} tone="red" label={t("inventoryAdmin.expiredBlocked")} value={data.expired.length} sub={t("inventoryAdmin.unitsSub", { n: data.expired.reduce((s, b) => s + b.quantity, 0) })} />
            <StatCard icon={AlertTriangle} tone="amber" label={t("inventoryAdmin.expiring7")} value={data.within7.length} sub={t("inventoryAdmin.unitsSub", { n: data.within7.reduce((s, b) => s + b.quantity, 0) })} />
            <StatCard icon={Clock} tone="amber" label={t("inventoryAdmin.expiring30")} value={data.within30.length} sub={t("inventoryAdmin.unitsSub", { n: data.within30.reduce((s, b) => s + b.quantity, 0) })} />
            <StatCard icon={Clock} tone="blue" label={t("inventoryAdmin.expiring90")} value={data.within90.length} sub={t("inventoryAdmin.unitsSub", { n: data.within90.reduce((s, b) => s + b.quantity, 0) })} />
          </div>
          <Tabs defaultValue={data.expired.length ? "expired" : "w7"}>
            <TabsList>
              <TabsTrigger value="expired">{t("inventoryAdmin.tabExpired", { n: data.expired.length })}</TabsTrigger>
              <TabsTrigger value="w7">{t("inventoryAdmin.tab7d", { n: data.within7.length })}</TabsTrigger>
              <TabsTrigger value="w30">{t("inventoryAdmin.tab30d", { n: data.within30.length })}</TabsTrigger>
              <TabsTrigger value="w90">{t("inventoryAdmin.tab90d", { n: data.within90.length })}</TabsTrigger>
            </TabsList>
            <TabsContent value="expired" className="mt-4">{renderTable(data.expired, true)}</TabsContent>
            <TabsContent value="w7" className="mt-4">{renderTable(data.within7)}</TabsContent>
            <TabsContent value="w30" className="mt-4">{renderTable(data.within30)}</TabsContent>
            <TabsContent value="w90" className="mt-4">{renderTable(data.within90)}</TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
