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
  const { locale, money, t, tError } = useI18n();
  const km = locale === "km";
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
      toast.success(t("inventoryAdmin.stockAdded"));
      setInModal(false);
      setInForm((f) => ({ ...f, batchNumber: "", lotNumber: "", quantity: "", expiryDate: "", reason: "" }));
      load();
    } catch (err) {
      toast.error(tError((err as Error).message));
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
      toast.success(t("inventoryAdmin.batchUpdated"));
      setAdjusting(null);
      openBatches(batchMed);
      load();
    } catch (err) {
      toast.error(tError((err as Error).message));
    } finally {
      setBusy(false);
    }
  }

  const sel = "h-9 w-full rounded-md border bg-white px-3 text-sm";

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("inventoryAdmin.title")}
        subtitle={t("inventoryAdmin.subtitle")}
        actions={
          <>
            <Button asChild variant="outline"><Link href="/admin/inventory/movements"><History /> {t("inventoryAdmin.stockMovements")}</Link></Button>
            <Button asChild variant="outline"><Link href="/admin/inventory/expiry"><CalendarX2 /> {t("inventoryAdmin.expiryWatch")}</Link></Button>
            {canWrite && <Button onClick={() => setInModal(true)}><Plus /> {t("inventoryAdmin.stockIn")}</Button>}
          </>
        }
      />

      {data && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatCard icon={Boxes} tone="green" label={t("inventoryAdmin.kpiUnitsOnHand")} value={data.totals.units.toLocaleString()} />
          <StatCard icon={DollarSign} tone="blue" label={t("inventoryAdmin.kpiCostValue")} value={money(data.totals.costValue)} />
          <StatCard icon={DollarSign} tone="green" label={t("inventoryAdmin.kpiRetailValue")} value={money(data.totals.retailValue)} />
          <StatCard icon={AlertTriangle} tone="amber" label={t("inventoryAdmin.kpiLowOut")} value={data.totals.low} />
          <StatCard icon={CalendarX2} tone={data.totals.expiredUnits > 0 ? "red" : "slate"} label={t("inventoryAdmin.kpiExpiredBlocked")} value={data.totals.expiredUnits} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 rounded-2xl border bg-white p-3 shadow-sm">
        <div className="relative min-w-56 flex-1"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder={t("inventoryAdmin.searchPh")} className="pl-9" /></div>
        {(["all", "low", "out", "expired"] as const).map((f) => (
          <Button key={f} size="sm" variant={filter === f ? "default" : "outline"} onClick={() => { setFilter(f); setPage(1); }}>
            {f === "all" ? t("common.all") : f === "low" ? t("medicinesAdmin.lowStock") : f === "out" ? t("common.outOfStock") : t("inventoryAdmin.filterHasExpired")}
          </Button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-2xl border bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-3">{t("inventoryAdmin.colMedicine")}</th>
              <th className="p-3">{t("inventoryAdmin.colShelf")}</th>
              <th className="p-3 text-right">{t("inventoryAdmin.colOnHand")}</th>
              <th className="p-3 text-right">{t("inventoryAdmin.colReserved")}</th>
              <th className="p-3 text-right">{t("inventoryAdmin.colExpired")}</th>
              <th className="p-3 text-right">{t("inventoryAdmin.colSellable")}</th>
              <th className="p-3">{t("inventoryAdmin.colNextExpiry")}</th>
              <th className="p-3 text-right">{t("inventoryAdmin.colCostVal")}</th>
              <th className="p-3 text-right">{t("inventoryAdmin.colBatches")}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {data?.items.map((r) => (
              <tr key={r.id} className="hover:bg-muted/30">
                <td className="p-3"><div className="font-medium">{km ? r.nameKm : r.nameEn}</div><div className="font-mono text-xs text-muted-foreground">{r.sku} · {t("inventoryAdmin.minPrefix", { n: r.minStock })}</div></td>
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
          <DialogHeader><DialogTitle>{t("inventoryAdmin.stockInTitle")}</DialogTitle></DialogHeader>
          <form onSubmit={submitStockIn} className="space-y-3">
            <div className="space-y-1">
              <Label>{t("inventoryAdmin.colMedicine")} *</Label>
              <select className={sel} value={inForm.medicineId} onChange={(e) => { const m = medicines.find((x) => x.id === e.target.value); setInForm({ ...inForm, medicineId: e.target.value, costPrice: m?.costPrice ?? "0" }); }}>
                {medicines.map((m) => <option key={m.id} value={m.id}>{m.sku} — {m.nameEn}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label>{t("inventoryAdmin.batchNumber")} *</Label><Input required value={inForm.batchNumber} onChange={(e) => setInForm({ ...inForm, batchNumber: e.target.value })} placeholder="B2026-01" /></div>
              <div className="space-y-1"><Label>{t("inventoryAdmin.lotNumber")}</Label><Input value={inForm.lotNumber} onChange={(e) => setInForm({ ...inForm, lotNumber: e.target.value })} /></div>
              <div className="space-y-1"><Label>{t("common.quantity")} *</Label><Input required type="number" min={1} value={inForm.quantity} onChange={(e) => setInForm({ ...inForm, quantity: e.target.value })} /></div>
              <div className="space-y-1"><Label>{t("inventoryAdmin.unitCostUsd")} *</Label><Input required type="number" min={0} step="0.01" value={inForm.costPrice} onChange={(e) => setInForm({ ...inForm, costPrice: e.target.value })} /></div>
              <div className="space-y-1"><Label>{t("inventoryAdmin.expiryDate")} {medicines.find((m) => m.id === inForm.medicineId)?.tracksExpiry ? "*" : ""}</Label><Input type="date" value={inForm.expiryDate} onChange={(e) => setInForm({ ...inForm, expiryDate: e.target.value })} /></div>
              <div className="space-y-1"><Label>{t("inventoryAdmin.manufactureDate")}</Label><Input type="date" value={inForm.manufactureDate} onChange={(e) => setInForm({ ...inForm, manufactureDate: e.target.value })} /></div>
            </div>
            <div className="space-y-1">
              <Label>{t("inventoryAdmin.supplier")}</Label>
              <select className={sel} value={inForm.supplierId} onChange={(e) => setInForm({ ...inForm, supplierId: e.target.value })}>
                <option value="">{t("common.optionalSelect")}</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div className="space-y-1"><Label>{t("inventoryAdmin.reasonNote")}</Label><Input value={inForm.reason} onChange={(e) => setInForm({ ...inForm, reason: e.target.value })} placeholder={t("inventoryAdmin.reasonNotePh")} /></div>
            <DialogFooter><Button type="button" variant="outline" onClick={() => setInModal(false)}>{t("common.cancel")}</Button><Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />} {t("inventoryAdmin.recordStockIn")}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Batches Dialog */}
      <Dialog open={!!batchMed} onOpenChange={(o) => !o && setBatchMed(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader><DialogTitle>{t("inventoryAdmin.batchesTitle", { name: batchMed ? (km ? batchMed.nameKm : batchMed.nameEn) : "" })}</DialogTitle></DialogHeader>
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-2">{t("inventoryAdmin.colBatchLot")}</th>
                <th className="py-2">{t("medicinesAdmin.colExpiry")}</th>
                <th className="py-2 text-right">{t("common.qty")}</th>
                <th className="py-2 text-right">{t("inventoryAdmin.colResShort")}</th>
                <th className="py-2 text-right">{t("medicinesAdmin.colCost")}</th>
                {canWrite && <th className="py-2 text-right">{t("inventoryAdmin.colAdjust")}</th>}
              </tr>
            </thead>
            <tbody className="divide-y">
              {batches.map((b) => {
                const isExp = b.expiryDate && new Date(b.expiryDate) <= new Date();
                return (
                  <tr key={b.id}>
                    <td className="py-2 font-mono text-xs">{b.batchNumber}{b.lotNumber && <span className="text-muted-foreground"> / {b.lotNumber}</span>}</td>
                    <td className="py-2 text-xs">{formatDate(b.expiryDate)} {isExp && <Badge variant="destructive" className="ml-1 text-[10px]">{t("status.EXPIRED")}</Badge>}</td>
                    <td className="py-2 text-right font-semibold">{b.quantity}</td>
                    <td className="py-2 text-right text-muted-foreground">{b.reserved}</td>
                    <td className="py-2 text-right text-xs">${Number(b.costPrice).toFixed(2)}</td>
                    {canWrite && (
                      <td className="py-2 text-right">
                        <Button size="sm" variant="outline" onClick={() => { setAdjusting(b); setAdjForm({ mode: isExp ? "out" : "set", quantity: String(b.quantity), reason: isExp ? t("inventoryAdmin.actionExpiredWriteOff") : "", type: isExp ? "EXPIRED_WRITE_OFF" : "ADJUSTMENT" }); }}>{t("inventoryAdmin.colAdjust")}</Button>
                      </td>
                    )}
                  </tr>
                );
              })}
              {batches.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-muted-foreground">{t("inventoryAdmin.noBatches")}</td></tr>}
            </tbody>
          </table>
        </DialogContent>
      </Dialog>

      {/* Adjust / Stock-Out Dialog */}
      <Dialog open={!!adjusting} onOpenChange={(o) => !o && setAdjusting(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t("inventoryAdmin.adjustBatchTitle", { batch: adjusting?.batchNumber ?? "" })}</DialogTitle></DialogHeader>
          <form onSubmit={submitAdjust} className="space-y-3">
            <div className="rounded-lg bg-muted p-2.5 text-xs">{t("inventoryAdmin.currentOnHand")} <b>{adjusting?.quantity}</b> · {t("inventoryAdmin.colReserved")}: <b>{adjusting?.reserved}</b></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>{t("inventoryAdmin.action")}</Label>
                <select className={sel} value={adjForm.type} onChange={(e) => { const ty = e.target.value as typeof adjForm.type; setAdjForm({ ...adjForm, type: ty, mode: ty === "ADJUSTMENT" ? "set" : "out" }); }}>
                  <option value="STOCK_OUT">{t("inventoryAdmin.actionStockOut")}</option>
                  <option value="EXPIRED_WRITE_OFF">{t("inventoryAdmin.actionExpiredWriteOff")}</option>
                  <option value="ADJUSTMENT">{t("inventoryAdmin.actionCycleCount")}</option>
                </select>
              </div>
              <div className="space-y-1"><Label>{adjForm.mode === "out" ? t("inventoryAdmin.qtyToRemove") : t("inventoryAdmin.countedQty")}</Label><Input required type="number" min={adjForm.mode === "out" ? 1 : 0} value={adjForm.quantity} onChange={(e) => setAdjForm({ ...adjForm, quantity: e.target.value })} /></div>
            </div>
            <div className="space-y-1"><Label>{t("common.reason")} *</Label><Input required minLength={3} value={adjForm.reason} onChange={(e) => setAdjForm({ ...adjForm, reason: e.target.value })} placeholder={t("inventoryAdmin.reasonPh")} /></div>
            <DialogFooter><Button type="button" variant="outline" onClick={() => setAdjusting(null)}>{t("common.cancel")}</Button><Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />} {t("common.apply")}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
