"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Plus, Pencil, Trash2, Search, History, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { StatusBadge } from "@/components/common/status-badge";
import { PageHeader } from "./common";
import { PROVINCES } from "@/lib/cambodia";
import { formatDate } from "@/lib/date";
import { formatKhPhone } from "@/lib/phone";
import { useI18n } from "@/components/providers/i18n-provider";
import { api } from "@/lib/fetcher";

type Supplier = {
  id: string; name: string; contactName: string | null; phone: string | null; email: string | null;
  province: string | null; district: string | null; address: string | null; taxId: string | null; notes: string | null;
  totalPurchased: number; _count: { purchases: number };
};
type SupplierHistory = Supplier & {
  purchases: { id: string; number: string; status: string; orderedAt: string; total: string; _count: { items: number } }[];
  batches: { id: string; batchNumber: string; quantity: number; expiryDate: string | null; receivedAt: string; medicine: { nameEn: string; sku: string } }[];
};

const empty = { name: "", contactName: "", phone: "", email: "", province: "", district: "", address: "", taxId: "", notes: "" };

export function SuppliersClient({ canWrite }: { canWrite: boolean }) {
  const { money, t, tError, locale } = useI18n();
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Supplier[]>([]);
  const [modal, setModal] = useState<Supplier | "new" | null>(null);
  const [form, setForm] = useState(empty);
  const [history, setHistory] = useState<SupplierHistory | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ items: Supplier[] }>(`/api/admin/suppliers${q ? `?q=${encodeURIComponent(q)}` : ""}`).then((r) => setItems(r.items)).catch((e) => toast.error(tError((e as Error).message)));
  }, [q, tError]);
  useEffect(() => { const id = setTimeout(load, 200); return () => clearTimeout(id); }, [load]);

  function openEdit(s?: Supplier) {
    setModal(s ?? "new");
    setForm(s ? { name: s.name, contactName: s.contactName ?? "", phone: s.phone ?? "", email: s.email ?? "", province: s.province ?? "", district: s.district ?? "", address: s.address ?? "", taxId: s.taxId ?? "", notes: s.notes ?? "" } : empty);
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (modal === "new") await api("/api/admin/suppliers", { method: "POST", body: form });
      else if (modal) await api(`/api/admin/suppliers/${modal.id}`, { method: "PUT", body: form });
      toast.success(t("suppliersAdmin.supplierSavedToast")); setModal(null); load();
    } catch (err) { toast.error(tError((err as Error).message)); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    if (!confirm(t("suppliersAdmin.confirmDelete"))) return;
    try { await api(`/api/admin/suppliers/${id}`, { method: "DELETE" }); toast.success(t("suppliersAdmin.supplierDeletedToast")); load(); }
    catch (err) { toast.error(tError((err as Error).message)); }
  }
  function openHistory(id: string) {
    api<SupplierHistory>(`/api/admin/suppliers/${id}`).then(setHistory).catch((e) => toast.error(tError(e.message)));
  }

  const prov = PROVINCES.find((p) => p.en === form.province);
  const sel = "h-9 w-full rounded-md border bg-white px-3 text-sm";

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("suppliersAdmin.title")}
        subtitle={t("suppliersAdmin.subtitle")}
        actions={canWrite && <Button onClick={() => openEdit()}><Plus /> {t("suppliersAdmin.addSupplier")}</Button>}
      />
      <div className="rounded-2xl border bg-white p-3 shadow-sm">
        <div className="relative max-w-md"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("suppliersAdmin.searchPh")} className="pl-9" /></div>
      </div>

      <div className="overflow-x-auto rounded-2xl border bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-3">{t("suppliersAdmin.colSupplier")}</th>
              <th className="p-3">{t("suppliersAdmin.colContact")}</th>
              <th className="p-3">{t("suppliersAdmin.colLocation")}</th>
              <th className="p-3 text-right">{t("suppliersAdmin.colPos")}</th>
              <th className="p-3 text-right">{t("suppliersAdmin.colTotalPurchased")}</th>
              <th className="p-3 text-right">{t("common.actions")}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {items.map((s) => (
              <tr key={s.id}>
                <td className="p-3"><div className="font-medium">{s.name}</div>{s.taxId && <div className="text-xs text-muted-foreground">{t("suppliersAdmin.vatPrefix")} {s.taxId}</div>}</td>
                <td className="p-3 text-xs"><div>{s.contactName ?? "—"}</div><div className="text-muted-foreground">{formatKhPhone(s.phone)}{s.email ? ` · ${s.email}` : ""}</div></td>
                <td className="p-3 text-xs text-muted-foreground">{[s.address, s.district, s.province].filter(Boolean).join(", ") || "—"}</td>
                <td className="p-3 text-right">{s._count.purchases}</td>
                <td className="p-3 text-right font-semibold">{money(s.totalPurchased)}</td>
                <td className="p-3 text-right">
                  <Button size="icon" variant="ghost" title={t("suppliersAdmin.historyTip")} onClick={() => openHistory(s.id)}><History className="size-4" /></Button>
                  {canWrite && <>
                    <Button size="icon" variant="ghost" onClick={() => openEdit(s)}><Pencil className="size-4" /></Button>
                    <Button size="icon" variant="ghost" className="text-red-600" onClick={() => remove(s.id)}><Trash2 className="size-4" /></Button>
                  </>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={!!modal} onOpenChange={(o) => !o && setModal(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>{modal === "new" ? t("suppliersAdmin.addSupplier") : t("suppliersAdmin.editSupplier")}</DialogTitle></DialogHeader>
          <form onSubmit={save} className="space-y-3">
            <div className="space-y-1"><Label>{t("suppliersAdmin.companyName")} *</Label><Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label>{t("suppliersAdmin.contactPerson")}</Label><Input value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} /></div>
              <div className="space-y-1"><Label>{t("checkout.phone")}</Label><Input value={form.phone} placeholder="023 880 111" onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
              <div className="space-y-1"><Label>{t("common.email")}</Label><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
              <div className="space-y-1"><Label>{t("suppliersAdmin.taxVatId")}</Label><Input value={form.taxId} onChange={(e) => setForm({ ...form, taxId: e.target.value })} /></div>
              <div className="space-y-1">
                <Label>{t("checkout.province")}</Label>
                <select className={sel} value={form.province} onChange={(e) => setForm({ ...form, province: e.target.value, district: "" })}>
                  <option value="">{t("common.select")}</option>
                  {PROVINCES.map((p) => <option key={p.code} value={p.en}>{locale === "km" ? `${p.km} (${p.en})` : p.en}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label>{t("checkout.district")}</Label>
                <select className={sel} value={form.district} disabled={!prov} onChange={(e) => setForm({ ...form, district: e.target.value })}>
                  <option value="">{t("common.select")}</option>
                  {prov?.districts.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
            </div>
            <div className="space-y-1"><Label>{t("suppliersAdmin.streetAddress")}</Label><Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></div>
            <div className="space-y-1"><Label>{t("suppliersAdmin.notes")}</Label><Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
            <DialogFooter><Button type="button" variant="outline" onClick={() => setModal(null)}>{t("common.cancel")}</Button><Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />} {t("common.save")}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!history} onOpenChange={(o) => !o && setHistory(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader><DialogTitle>{t("suppliersAdmin.purchaseHistoryTitle", { name: history?.name ?? "" })}</DialogTitle></DialogHeader>
          {history && (
            <div className="space-y-4 text-sm">
              <div>
                <h3 className="mb-2 font-semibold">{t("suppliersAdmin.purchaseOrdersCount", { n: history.purchases.length })}</h3>
                <table className="w-full text-xs">
                  <thead className="border-b text-left text-muted-foreground">
                    <tr>
                      <th className="py-1.5">{t("suppliersAdmin.colPoNo")}</th>
                      <th className="py-1.5">{t("common.date")}</th>
                      <th className="py-1.5">{t("common.status")}</th>
                      <th className="py-1.5 text-right">{t("suppliersAdmin.colItems")}</th>
                      <th className="py-1.5 text-right">{t("common.total")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {history.purchases.map((p) => (
                      <tr key={p.id}>
                        <td className="py-1.5"><Link href={`/admin/purchases/${p.id}`} className="font-mono text-primary hover:underline">{p.number}</Link></td>
                        <td className="py-1.5">{formatDate(p.orderedAt)}</td>
                        <td className="py-1.5"><StatusBadge status={p.status} /></td>
                        <td className="py-1.5 text-right">{p._count.items}</td>
                        <td className="py-1.5 text-right font-semibold">{money(p.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <h3 className="mb-2 font-semibold">{t("suppliersAdmin.recentBatches")}</h3>
                <div className="max-h-56 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="border-b text-left text-muted-foreground">
                      <tr>
                        <th className="py-1.5">{t("medicinesAdmin.colBatchNo")}</th>
                        <th className="py-1.5">{t("inventoryAdmin.colMedicine")}</th>
                        <th className="py-1.5">{t("medicinesAdmin.colExpiry")}</th>
                        <th className="py-1.5 text-right">{t("medicinesAdmin.colOnHand")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {history.batches.map((b) => (
                        <tr key={b.id}><td className="py-1.5 font-mono">{b.batchNumber}</td><td className="py-1.5">{b.medicine.nameEn}</td><td className="py-1.5">{formatDate(b.expiryDate)}</td><td className="py-1.5 text-right">{b.quantity}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
