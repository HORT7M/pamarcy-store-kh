"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Trash2, CalendarX2, Clock, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader, StatCard } from "./common";
import { formatDate } from "@/lib/date";
import { api } from "@/lib/fetcher";

type ExBatch = { id: string; batchNumber: string; expiryDate: string; quantity: number; reserved: number; costPrice: string; medicine: { id: string; nameEn: string; nameKm: string; sku: string }; supplier: { name: string } | null };
type Data = { expired: ExBatch[]; within7: ExBatch[]; within30: ExBatch[]; within90: ExBatch[] };

export function ExpiryClient({ canWrite }: { canWrite: boolean }) {
  const [data, setData] = useState<Data | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const load = useCallback(() => { api<Data>("/api/admin/inventory/expiry").then(setData); }, []);
  useEffect(load, [load]);

  async function writeOff(b: ExBatch) {
    if (!confirm(`Write off all ${b.quantity} expired units of ${b.medicine.nameEn} (Batch ${b.batchNumber})?`)) return;
    setBusyId(b.id);
    try {
      await api(`/api/admin/inventory/batches/${b.id}`, { method: "POST", body: { mode: "out", quantity: b.quantity - b.reserved, reason: "Expired stock write-off", type: "EXPIRED_WRITE_OFF" } });
      toast.success("Expired batch written off");
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  function renderTable(rows: ExBatch[], expired?: boolean) {
    if (!rows.length) return <div className="rounded-2xl border bg-white p-8 text-center text-sm text-muted-foreground">No batches in this window.</div>;
    return (
      <div className="overflow-x-auto rounded-2xl border bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <tr><th className="p-3">Medicine</th><th className="p-3">Batch</th><th className="p-3">Supplier</th><th className="p-3">Expiry</th><th className="p-3 text-right">Qty</th><th className="p-3 text-right">Cost at risk</th>{expired && canWrite && <th className="p-3 text-right">Action</th>}</tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((b) => (
              <tr key={b.id}>
                <td className="p-3"><Link href={`/admin/medicines/${b.medicine.id}`} className="font-medium hover:text-primary">{b.medicine.nameEn}</Link><div className="font-mono text-xs text-muted-foreground">{b.medicine.sku}</div></td>
                <td className="p-3 font-mono text-xs">{b.batchNumber}</td>
                <td className="p-3 text-xs text-muted-foreground">{b.supplier?.name ?? "—"}</td>
                <td className="p-3"><Badge variant={expired ? "destructive" : "outline"}>{formatDate(b.expiryDate)}</Badge></td>
                <td className="p-3 text-right font-semibold">{b.quantity}</td>
                <td className="p-3 text-right">${(b.quantity * Number(b.costPrice)).toFixed(2)}</td>
                {expired && canWrite && (
                  <td className="p-3 text-right">
                    <Button size="sm" variant="destructive" onClick={() => writeOff(b)} disabled={busyId === b.id || b.quantity - b.reserved <= 0}>
                      {busyId === b.id ? <Loader2 className="animate-spin" /> : <Trash2 className="size-3.5" />} Write off
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
      <PageHeader title="Expiration Date Management" subtitle="FEFO picks earliest valid batches first; expired batches are automatically blocked from checkout and POS" />
      <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        <AlertTriangle className="size-4 shrink-0" /> Expired batches are never selectable for online orders or POS sales. Write them off to keep inventory valuation accurate.
      </div>
      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard icon={CalendarX2} tone="red" label="Expired (Blocked)" value={data.expired.length} sub={`${data.expired.reduce((s, b) => s + b.quantity, 0)} units`} />
            <StatCard icon={AlertTriangle} tone="amber" label="Expiring ≤ 7 days" value={data.within7.length} sub={`${data.within7.reduce((s, b) => s + b.quantity, 0)} units`} />
            <StatCard icon={Clock} tone="amber" label="Expiring 8–30 days" value={data.within30.length} sub={`${data.within30.reduce((s, b) => s + b.quantity, 0)} units`} />
            <StatCard icon={Clock} tone="blue" label="Expiring 31–90 days" value={data.within90.length} sub={`${data.within90.reduce((s, b) => s + b.quantity, 0)} units`} />
          </div>
          <Tabs defaultValue={data.expired.length ? "expired" : "w7"}>
            <TabsList>
              <TabsTrigger value="expired">Expired ({data.expired.length})</TabsTrigger>
              <TabsTrigger value="w7">≤ 7 Days ({data.within7.length})</TabsTrigger>
              <TabsTrigger value="w30">8–30 Days ({data.within30.length})</TabsTrigger>
              <TabsTrigger value="w90">31–90 Days ({data.within90.length})</TabsTrigger>
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
