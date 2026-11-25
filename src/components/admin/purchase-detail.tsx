"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, PackageCheck, XCircle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/common/status-badge";
import { formatDate } from "@/lib/date";
import { useI18n } from "@/components/providers/i18n-provider";
import { api } from "@/lib/fetcher";

type PoDetail = {
  id: string; number: string; status: string; orderedAt: string; receivedAt: string | null; subtotal: string; shippingCost: string; total: string; notes: string | null;
  supplier: { name: string; phone: string | null; contactName: string | null };
  items: { id: string; medicineId: string; quantity: number; receivedQuantity: number; unitCost: string; lineTotal: string; medicine: { nameEn: string; sku: string; tracksExpiry: boolean }; batches: { id: string; batchNumber: string; quantity: number; expiryDate: string | null }[] }[];
};

export function PurchaseDetailClient({ id, canWrite }: { id: string; canWrite: boolean }) {
  const { money } = useI18n();
  const [po, setPo] = useState<PoDetail | null>(null);
  const [rows, setRows] = useState<Record<string, { quantity: string; batchNumber: string; lotNumber: string; expiryDate: string }>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<PoDetail>(`/api/admin/purchases/${id}`).then((d) => {
      setPo(d);
      setRows(Object.fromEntries(d.items.map((i, idx) => [i.id, { quantity: String(Math.max(0, i.quantity - i.receivedQuantity)), batchNumber: `B-${d.number.slice(-4)}-${idx + 1}`, lotNumber: "", expiryDate: "" }])));
    });
  }, [id]);
  useEffect(load, [load]);

  if (!po) return <div className="py-20 text-center"><Loader2 className="mx-auto animate-spin" /></div>;

  const canReceive = canWrite && (po.status === "ORDERED" || po.status === "PARTIALLY_RECEIVED");

  async function receive(e: React.FormEvent) {
    e.preventDefault();
    if (!po) return;
    setBusy(true);
    try {
      const items = po.items
        .map((i) => ({ purchaseItemId: i.id, quantity: Number(rows[i.id]?.quantity || 0), batchNumber: rows[i.id]?.batchNumber ?? "", lotNumber: rows[i.id]?.lotNumber || null, expiryDate: rows[i.id]?.expiryDate || null }))
        .filter((x) => x.quantity > 0);
      await api(`/api/admin/purchases/${id}/receive`, { method: "POST", body: { items } });
      toast.success("Received stock into inventory batches");
      load();
    } catch (err) { toast.error((err as Error).message); }
    finally { setBusy(false); }
  }

  async function cancelPo() {
    if (!confirm("Cancel this purchase order?")) return;
    setBusy(true);
    try { await api(`/api/admin/purchases/${id}`, { method: "DELETE" }); toast.success("Purchase order cancelled"); load(); }
    catch (err) { toast.error((err as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={receive} className="space-y-5">
      <Link href="/admin/purchases" className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"><ArrowLeft className="size-4" /> Back to purchases</Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-mono text-2xl font-bold">{po.number}</h1>
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span>{po.supplier.name}</span> · <span>Ordered {formatDate(po.orderedAt)}</span>
            <StatusBadge status={po.status} />
          </div>
        </div>
        <div className="flex gap-2">
          {canWrite && po.status === "ORDERED" && <Button type="button" variant="destructive" size="sm" onClick={cancelPo} disabled={busy}><XCircle /> Cancel PO</Button>}
          {canReceive && <Button type="submit" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <PackageCheck />} Record Received Stock</Button>}
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border bg-white p-5 shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b text-left text-xs text-muted-foreground">
            <tr>
              <th className="py-2">Medicine</th><th className="py-2 text-right">Ordered</th><th className="py-2 text-right">Received</th><th className="py-2 text-right">Unit Cost</th><th className="py-2 text-right">Line Total</th>
              {canReceive && <><th className="py-2 pl-3">Receive Qty</th><th className="py-2">Batch # *</th><th className="py-2">Expiry Date</th></>}
            </tr>
          </thead>
          <tbody className="divide-y">
            {po.items.map((i) => {
              const rem = i.quantity - i.receivedQuantity;
              const r = rows[i.id] ?? { quantity: "0", batchNumber: "", lotNumber: "", expiryDate: "" };
              return (
                <tr key={i.id}>
                  <td className="py-2.5">
                    <div className="font-medium">{i.medicine.nameEn}</div>
                    <div className="font-mono text-xs text-muted-foreground">{i.medicine.sku}</div>
                    {i.batches.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{i.batches.map((b) => <span key={b.id} className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-primary">{b.batchNumber} ({b.quantity}, exp {formatDate(b.expiryDate)})</span>)}</div>}
                  </td>
                  <td className="py-2.5 text-right">{i.quantity}</td>
                  <td className="py-2.5 text-right font-semibold">{i.receivedQuantity}</td>
                  <td className="py-2.5 text-right">{money(i.unitCost)}</td>
                  <td className="py-2.5 text-right font-semibold">{money(i.lineTotal)}</td>
                  {canReceive && (
                    <>
                      <td className="py-2.5 pl-3"><Input type="number" min={0} max={rem} disabled={rem <= 0} value={r.quantity} onChange={(e) => setRows({ ...rows, [i.id]: { ...r, quantity: e.target.value } })} className="h-8 w-24" /></td>
                      <td className="py-2.5"><Input disabled={rem <= 0} value={r.batchNumber} onChange={(e) => setRows({ ...rows, [i.id]: { ...r, batchNumber: e.target.value } })} className="h-8 w-32 font-mono text-xs" /></td>
                      <td className="py-2.5"><Input type="date" disabled={rem <= 0} required={Number(r.quantity) > 0 && i.medicine.tracksExpiry} value={r.expiryDate} onChange={(e) => setRows({ ...rows, [i.id]: { ...r, expiryDate: e.target.value } })} className="h-8 w-36 text-xs" /></td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="ml-auto mt-4 w-64 space-y-1 border-t pt-3 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span>{money(po.subtotal)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Shipping</span><span>{money(po.shippingCost)}</span></div>
          <div className="flex justify-between font-bold"><span>Total Purchasing Cost</span><span className="text-primary">{money(po.total)}</span></div>
        </div>
      </div>
    </form>
  );
}
