"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Boxes, DollarSign, AlertTriangle, CalendarX2, Plus, Search, History, Layers, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { PageHeader, StatCard, Pagination } from "./common";
import { useI18n } from "@/components/providers/i18n-provider";
import { formatDate } from "@/lib/date";
import { api } from "@/lib/fetcher";

type InvRow = {
  id: string; sku: string; nameEn: string; nameKm: string; minStock: number; location: string | null;
  onHand: number; reserved: number; expired: number; sellable: number; costValue: number; retailValue: number; nearestExpiry: string | null; batches: number;
};
type Batch = { id: string; batchNumber: string; lotNumber: string | null; expiryDate: string | null; quantity: number; reserved: number; costPrice: string; supplier: { name: string } | null };

export function InventoryClient({ medicines, suppliers, canWrite }: { medicines: { id: string; nameEn: string; sku: string; costPrice: string; tracksExpiry: boolean }[]; suppliers: { id: string; name: string }[]; canWrite: boolean }) {
  const { money } = useI18n();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "low" | "out" | "expired">("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; pageSize: number; items: InvRow[]; totals: { costValue: number; retailValue: number; units: number; low: number; expiredUnits: number } } | null>(null);
  const [inModal, setInModal] = useState(false);
  const [inForm, setInForm] = useState({ medicineId: medicines[0]?.id ?? "", batchNumber: "", lotNumber: "", quantity: "", costPrice: medicines[0]?.costPrice ?? "0", expiryDate: "", manufactureDate: "", supplierId: "", reason: "" });
  const [batchMed, setBatchMed] = useState<InvRow | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [adjusting, setAdjusting] = useState<Batch | null>(null);
  const [adjForm, setAdjForm] = useState({ mode: "out" as "out" | "set", quantity: "", reason: "", type: "STOCK_OUT" as "STOCK_OUT" | "ADJUSTMENT" | "EXPIRED_WRITE_OFF" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    const sp = new URLSearchParams({ page: String(page), pageSize: "25", filter });
    if (q) sp.set("q", q);
    api<typeof data>(`/api/admin/inventory?${sp}`).then(setData);
  }, [q, filter, page]);

  useEffect(() => { const id = setTimeout(load, 200); return () => clearTimeout(id); }, [load]);

  function openBatches(row: InvRow) {
    setBatchMed(row);
    setBatches([]);
    api<{ batches: Batch[] }>(`/api/admin/inventory/batches?medicineId=${row.id}`).then((r) => setBatches(r.batches));
  }

  async function submitStockIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/api/admin/inventory/stock-in", {
        method: "POST",
        body: { ...inForm, quantity: Number(inForm.quantity), costPrice: Number(inForm.costPrice || 0), expiryDate: inForm.expiryDate || null, manufactureDate: inForm.manufactureDate || null, supplierId: inForm.supplierId || null, lotNumber: inForm.lotNumber || null, reason: inForm.reason || null },
      });
      toast.success("Stock added");
      setInModal(false);
      setInForm((f) => ({ ...f, batchNumber: "", lotNumber: "", quantity: "", expiryDate: "", reason: "" }));
      load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitAdjust(e: React.FormEvent) {
    e.preventDefault();
    if (!adjusting || !batchMed) return;
    setBusy(true);
    try {
      await api(`/api/admin/inventory/batches/${adjusting.id}`, {
        method: "POST",
        body: { mode: adjForm.mode, quantity: Number(adjForm.quantity), reason: adjForm.reason, type: adjForm.type },
      });
      toast.success("Batch updated");
      setAdjusting(null);
      openBatches(batchMed);
      load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const sel = "h-9 w-full rounded-md border bg-white px-3 text-sm";

  return (
    <div className="space-y-5">
      <PageHeader
        title="Inventory Management"
        subtitle="Batch-level stock control with FEFO (First Expired, First Out) enforcement and valuation"
        actions={
          <>
            <Button asChild variant="outline"><Link href="/admin/inventory/movements"><History /> Stock Movements</Link></Button>
            <Button asChild variant="outline"><Link href="/admin/inventory/expiry"><CalendarX2 /> Expiry Watch</Link></Button>
            {canWrite && <Button onClick={() => setInModal(true)}><Plus /> Stock In</Button>}
          </>
        }
      />

      {data && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatCard icon={Boxes} tone="green" label="Total Units On Hand" value={data.totals.units.toLocaleString()} />
          <StatCard icon={DollarSign} tone="blue" label="Inventory Cost Value" value={money(data.totals.costValue)} />
          <StatCard icon={DollarSign} tone="green" label="Retail Valuation" value={money(data.totals.retailValue)} />
          <StatCard icon={AlertTriangle} tone="amber" label="Low / Out of Stock" value={data.totals.low} />
          <StatCard icon={CalendarX2} tone={data.totals.expiredUnits > 0 ? "red" : "slate"} label="Expired Units (Blocked)" value={data.totals.expiredUnits} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 rounded-2xl border bg-white p-3 shadow-sm">
        <div className="relative min-w-56 flex-1"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search medicine, SKU or barcode…" className="pl-9" /></div>
        {(["all", "low", "out", "expired"] as const).map((f) => (
          <Button key={f} size="sm" variant={filter === f ? "default" : "outline"} onClick={() => { setFilter(f); setPage(1); }}>
            {f === "all" ? "All" : f === "low" ? "Low stock" : f === "out" ? "Out of stock" : "Has expired"}
          </Button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-2xl border bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-3">Medicine</th><th className="p-3">Shelf</th><th className="p-3 text-right">On hand</th><th className="p-3 text-right">Reserved</th>
              <th className="p-3 text-right">Expired</th><th className="p-3 text-right">Sellable</th><th className="p-3">Next expiry</th><th className="p-3 text-right">Cost val.</th><th className="p-3 text-right">Batches</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {data?.items.map((r) => (
              <tr key={r.id} className="hover:bg-muted/30">
                <td className="p-3"><div className="font-medium">{r.nameEn}</div><div className="font-mono text-xs text-muted-foreground">{r.sku} · min {r.minStock}</div></td>
                <td className="p-3 text-xs text-muted-foreground">{r.location ?? "—"}</td>
                <td className="p-3 text-right">{r.onHand}</td>
                <td className="p-3 text-right text-muted-foreground">{r.reserved}</td>
                <td className="p-3 text-right">{r.expired > 0 ? <Badge variant="destructive">{r.expired}</Badge> : "0"}</td>
                <td className={`p-3 text-right font-bold ${r.sellable <= 0 ? "text-red-600" : r.sellable <= r.minStock ? "text-amber-600" : "text-primary"}`}>{r.sellable}</td>
                <td className="p-3 text-xs">{formatDate(r.nearestExpiry)}</td>
                <td className="p-3 text-right text-xs">{money(r.costValue)}</td>
                <td className="p-3 text-right"><Button size="sm" variant="outline" onClick={() => openBatches(r)}><Layers className="size-3.5" /> {r.batches}</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && <Pagination page={page} pageSize={data.pageSize} total={data.total} onChange={setPage} />}

      {/* Stock In Dialog */}
      <Dialog open={inModal} onOpenChange={setInModal}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>Stock In (Add Batch)</DialogTitle></DialogHeader>
          <form onSubmit={submitStockIn} className="space-y-3">
            <div className="space-y-1">
              <Label>Medicine *</Label>
              <select className={sel} value={inForm.medicineId} onChange={(e) => { const m = medicines.find((x) => x.id === e.target.value); setInForm({ ...inForm, medicineId: e.target.value, costPrice: m?.costPrice ?? "0" }); }}>
                {medicines.map((m) => <option key={m.id} value={m.id}>{m.sku} — {m.nameEn}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label>Batch number *</Label><Input required value={inForm.batchNumber} onChange={(e) => setInForm({ ...inForm, batchNumber: e.target.value })} placeholder="B2026-01" /></div>
              <div className="space-y-1"><Label>Lot number</Label><Input value={inForm.lotNumber} onChange={(e) => setInForm({ ...inForm, lotNumber: e.target.value })} /></div>
              <div className="space-y-1"><Label>Quantity *</Label><Input required type="number" min={1} value={inForm.quantity} onChange={(e) => setInForm({ ...inForm, quantity: e.target.value })} /></div>
              <div className="space-y-1"><Label>Unit cost (USD) *</Label><Input required type="number" min={0} step="0.01" value={inForm.costPrice} onChange={(e) => setInForm({ ...inForm, costPrice: e.target.value })} /></div>
              <div className="space-y-1"><Label>Expiry date {medicines.find((m) => m.id === inForm.medicineId)?.tracksExpiry ? "*" : ""}</Label><Input type="date" value={inForm.expiryDate} onChange={(e) => setInForm({ ...inForm, expiryDate: e.target.value })} /></div>
              <div className="space-y-1"><Label>Manufacture date</Label><Input type="date" value={inForm.manufactureDate} onChange={(e) => setInForm({ ...inForm, manufactureDate: e.target.value })} /></div>
            </div>
            <div className="space-y-1">
              <Label>Supplier</Label>
              <select className={sel} value={inForm.supplierId} onChange={(e) => setInForm({ ...inForm, supplierId: e.target.value })}>
                <option value="">— Optional —</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div className="space-y-1"><Label>Reason / Note</Label><Input value={inForm.reason} onChange={(e) => setInForm({ ...inForm, reason: e.target.value })} placeholder="Opening stock, direct delivery…" /></div>
            <DialogFooter><Button type="button" variant="outline" onClick={() => setInModal(false)}>Cancel</Button><Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />} Record Stock In</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Batches Dialog */}
      <Dialog open={!!batchMed} onOpenChange={(o) => !o && setBatchMed(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader><DialogTitle>Batches — {batchMed?.nameEn}</DialogTitle></DialogHeader>
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground"><tr><th className="py-2">Batch / Lot</th><th className="py-2">Expiry</th><th className="py-2 text-right">Qty</th><th className="py-2 text-right">Res.</th><th className="py-2 text-right">Cost</th>{canWrite && <th className="py-2 text-right">Adjust</th>}</tr></thead>
            <tbody className="divide-y">
              {batches.map((b) => {
                const isExp = b.expiryDate && new Date(b.expiryDate) <= new Date();
                return (
                  <tr key={b.id}>
                    <td className="py-2 font-mono text-xs">{b.batchNumber}{b.lotNumber && <span className="text-muted-foreground"> / {b.lotNumber}</span>}</td>
                    <td className="py-2 text-xs">{formatDate(b.expiryDate)} {isExp && <Badge variant="destructive" className="ml-1 text-[10px]">Expired</Badge>}</td>
                    <td className="py-2 text-right font-semibold">{b.quantity}</td>
                    <td className="py-2 text-right text-muted-foreground">{b.reserved}</td>
                    <td className="py-2 text-right text-xs">${Number(b.costPrice).toFixed(2)}</td>
                    {canWrite && (
                      <td className="py-2 text-right">
                        <Button size="sm" variant="outline" onClick={() => { setAdjusting(b); setAdjForm({ mode: isExp ? "out" : "set", quantity: String(b.quantity), reason: isExp ? "Expired write-off" : "", type: isExp ? "EXPIRED_WRITE_OFF" : "ADJUSTMENT" }); }}>Adjust</Button>
                      </td>
                    )}
                  </tr>
                );
              })}
              {batches.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-muted-foreground">No batches</td></tr>}
            </tbody>
          </table>
        </DialogContent>
      </Dialog>

      {/* Adjust / Stock-Out Dialog */}
      <Dialog open={!!adjusting} onOpenChange={(o) => !o && setAdjusting(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Adjust Batch {adjusting?.batchNumber}</DialogTitle></DialogHeader>
          <form onSubmit={submitAdjust} className="space-y-3">
            <div className="rounded-lg bg-muted p-2.5 text-xs">Current on hand: <b>{adjusting?.quantity}</b> · Reserved: <b>{adjusting?.reserved}</b></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Action</Label>
                <select className={sel} value={adjForm.type} onChange={(e) => { const t = e.target.value as typeof adjForm.type; setAdjForm({ ...adjForm, type: t, mode: t === "ADJUSTMENT" ? "set" : "out" }); }}>
                  <option value="STOCK_OUT">Stock Out (damage / loss)</option>
                  <option value="EXPIRED_WRITE_OFF">Expired Write-Off</option>
                  <option value="ADJUSTMENT">Cycle Count (set exact qty)</option>
                </select>
              </div>
              <div className="space-y-1"><Label>{adjForm.mode === "out" ? "Quantity to remove" : "Counted quantity"}</Label><Input required type="number" min={adjForm.mode === "out" ? 1 : 0} value={adjForm.quantity} onChange={(e) => setAdjForm({ ...adjForm, quantity: e.target.value })} /></div>
            </div>
            <div className="space-y-1"><Label>Reason *</Label><Input required minLength={3} value={adjForm.reason} onChange={(e) => setAdjForm({ ...adjForm, reason: e.target.value })} placeholder="Damaged packaging, annual count, expired…" /></div>
            <DialogFooter><Button type="button" variant="outline" onClick={() => setAdjusting(null)}>Cancel</Button><Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />} Apply</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
