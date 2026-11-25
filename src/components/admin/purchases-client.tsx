"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, Search, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { StatusBadge } from "@/components/common/status-badge";
import { PageHeader, Pagination } from "./common";
import { formatDate } from "@/lib/date";
import { useI18n } from "@/components/providers/i18n-provider";
import { api } from "@/lib/fetcher";

type PoRow = { id: string; number: string; status: string; orderedAt: string; receivedAt: string | null; total: string; supplier: { name: string }; _count: { items: number } };
type MedOpt = { id: string; nameEn: string; sku: string; costPrice: string };

export function PurchasesClient({ suppliers, medicines, canWrite }: { suppliers: { id: string; name: string }[]; medicines: MedOpt[]; canWrite: boolean }) {
  const { money } = useI18n();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; pageSize: number; items: PoRow[] } | null>(null);
  const [open, setOpen] = useState(false);
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ?? "");
  const [shippingCost, setShippingCost] = useState("0");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<{ medicineId: string; quantity: string; unitCost: string }[]>([
    { medicineId: medicines[0]?.id ?? "", quantity: "50", unitCost: medicines[0]?.costPrice ?? "1" },
  ]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    const sp = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (q) sp.set("q", q);
    if (status) sp.set("status", status);
    api<typeof data>(`/api/admin/purchases?${sp}`).then(setData);
  }, [q, status, page]);
  useEffect(() => { const id = setTimeout(load, 200); return () => clearTimeout(id); }, [load]);

  const subtotal = lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unitCost) || 0), 0);
  const total = subtotal + (Number(shippingCost) || 0);

  async function createPo(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const po = await api<{ id: string }>("/api/admin/purchases", {
        method: "POST",
        body: { supplierId, shippingCost: Number(shippingCost || 0), notes: notes || null, items: lines.map((l) => ({ medicineId: l.medicineId, quantity: Number(l.quantity), unitCost: Number(l.unitCost) })) },
      });
      toast.success("Purchase order created");
      setOpen(false);
      router.push(`/admin/purchases/${po.id}`);
    } catch (err) { toast.error((err as Error).message); }
    finally { setBusy(false); }
  }

  const sel = "h-9 w-full rounded-md border bg-white px-3 text-sm";

  return (
    <div className="space-y-4">
      <PageHeader
        title="Purchase Management"
        subtitle="Create purchase orders to suppliers and receive stock into FEFO batches"
        actions={canWrite && <Button onClick={() => setOpen(true)}><Plus /> New Purchase Order</Button>}
      />
      <div className="flex flex-wrap gap-2 rounded-2xl border bg-white p-3 shadow-sm">
        <div className="relative min-w-56 flex-1"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search PO # or supplier…" className="pl-9" /></div>
        <select className="h-9 rounded-md border bg-white px-3 text-sm" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All statuses</option>
          {["ORDERED", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <div className="overflow-x-auto rounded-2xl border bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <tr><th className="p-3">PO #</th><th className="p-3">Supplier</th><th className="p-3">Ordered</th><th className="p-3">Received</th><th className="p-3">Status</th><th className="p-3 text-right">Items</th><th className="p-3 text-right">Total Cost</th></tr>
          </thead>
          <tbody className="divide-y">
            {data?.items.map((p) => (
              <tr key={p.id} className="hover:bg-muted/30">
                <td className="p-3"><Link href={`/admin/purchases/${p.id}`} className="font-mono font-semibold text-primary hover:underline">{p.number}</Link></td>
                <td className="p-3 font-medium">{p.supplier.name}</td>
                <td className="p-3 text-xs">{formatDate(p.orderedAt)}</td>
                <td className="p-3 text-xs">{formatDate(p.receivedAt)}</td>
                <td className="p-3"><StatusBadge status={p.status} /></td>
                <td className="p-3 text-right">{p._count.items}</td>
                <td className="p-3 text-right font-semibold">{money(p.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && <Pagination page={page} pageSize={data.pageSize} total={data.total} onChange={setPage} />}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader><DialogTitle>Create Purchase Order</DialogTitle></DialogHeader>
          <form onSubmit={createPo} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Supplier *</Label>
                <select className={sel} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div className="space-y-1"><Label>Shipping / Freight Cost (USD)</Label><Input type="number" min={0} step="0.01" value={shippingCost} onChange={(e) => setShippingCost(e.target.value)} /></div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between"><Label>Medicines</Label><Button type="button" size="sm" variant="outline" onClick={() => setLines([...lines, { medicineId: medicines[0]?.id ?? "", quantity: "20", unitCost: medicines[0]?.costPrice ?? "1" }])}><Plus className="size-3.5" /> Add Row</Button></div>
              {lines.map((l, idx) => (
                <div key={idx} className="grid grid-cols-[1fr_90px_110px_36px] items-center gap-2">
                  <select className={sel} value={l.medicineId} onChange={(e) => { const m = medicines.find((x) => x.id === e.target.value); setLines(lines.map((r, i) => (i === idx ? { ...r, medicineId: e.target.value, unitCost: m?.costPrice ?? r.unitCost } : r))); }}>
                    {medicines.map((m) => <option key={m.id} value={m.id}>{m.sku} — {m.nameEn}</option>)}
                  </select>
                  <Input type="number" min={1} placeholder="Qty" value={l.quantity} onChange={(e) => setLines(lines.map((r, i) => (i === idx ? { ...r, quantity: e.target.value } : r)))} />
                  <Input type="number" min={0} step="0.01" placeholder="Cost $" value={l.unitCost} onChange={(e) => setLines(lines.map((r, i) => (i === idx ? { ...r, unitCost: e.target.value } : r)))} />
                  <Button type="button" size="icon" variant="ghost" className="text-red-600" disabled={lines.length <= 1} onClick={() => setLines(lines.filter((_, i) => i !== idx))}><Trash2 className="size-4" /></Button>
                </div>
              ))}
            </div>

            <div className="space-y-1"><Label>Notes</Label><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
            <div className="flex items-center justify-between rounded-xl bg-muted p-3 text-sm">
              <span>Subtotal: ${subtotal.toFixed(2)} + Shipping: ${Number(shippingCost || 0).toFixed(2)}</span>
              <span className="text-base font-bold text-primary">Total: ${total.toFixed(2)}</span>
            </div>
            <DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />} Create PO</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
