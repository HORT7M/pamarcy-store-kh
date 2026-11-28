"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Pencil, Trash2, Upload, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { ProductImage } from "@/components/common/product-image";
import { PageHeader } from "./common";
import { useI18n } from "@/components/providers/i18n-provider";
import { localizeBanner } from "@/lib/i18n/translate";
import { formatDate, toDateInput } from "@/lib/date";
import { api } from "@/lib/fetcher";

type Disc = { id: string; code: string; description: string | null; type: "PERCENTAGE" | "FIXED"; value: string; minSubtotal: string; maxDiscount: string | null; usageLimit: number | null; usedCount: number; startsAt: string | null; endsAt: string | null; isActive: boolean };
type Banner = { id: string; titleEn: string; titleKm: string; subtitleEn: string | null; subtitleKm: string | null; imageUrl: string; link: string | null; sortOrder: number; isActive: boolean };

export function MarketingClient() {
  const { t, tError, locale } = useI18n();
  const [discounts, setDiscounts] = useState<Disc[]>([]);
  const [banners, setBanners] = useState<Banner[]>([]);
  const [dModal, setDModal] = useState<Disc | "new" | null>(null);
  const [dForm, setDForm] = useState({ code: "", description: "", type: "PERCENTAGE" as "PERCENTAGE" | "FIXED", value: "10", minSubtotal: "0", maxDiscount: "", usageLimit: "", startsAt: "", endsAt: "", isActive: true });
  const [bModal, setBModal] = useState<Banner | "new" | null>(null);
  const [bForm, setBForm] = useState({ titleEn: "", titleKm: "", subtitleEn: "", subtitleKm: "", imageUrl: "", link: "/shop", sortOrder: "0", isActive: true });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ items: Disc[] }>("/api/admin/discounts").then((r) => setDiscounts(r.items)).catch((e) => toast.error(tError((e as Error).message)));
    api<{ items: Banner[] }>("/api/admin/banners").then((r) => setBanners(r.items)).catch((e) => toast.error(tError((e as Error).message)));
  }, [tError]);
  useEffect(load, [load]);

  function openDisc(d?: Disc) {
    setDModal(d ?? "new");
    setDForm(d ? { code: d.code, description: d.description ?? "", type: d.type, value: d.value, minSubtotal: d.minSubtotal, maxDiscount: d.maxDiscount ?? "", usageLimit: d.usageLimit ? String(d.usageLimit) : "", startsAt: toDateInput(d.startsAt), endsAt: toDateInput(d.endsAt), isActive: d.isActive } : { code: "", description: "", type: "PERCENTAGE", value: "10", minSubtotal: "0", maxDiscount: "", usageLimit: "", startsAt: "", endsAt: "", isActive: true });
  }
  async function saveDisc() {
    setBusy(true);
    try {
      const body = { ...dForm, value: Number(dForm.value), minSubtotal: Number(dForm.minSubtotal || 0), maxDiscount: dForm.maxDiscount ? Number(dForm.maxDiscount) : null, usageLimit: dForm.usageLimit ? Number(dForm.usageLimit) : null, startsAt: dForm.startsAt || null, endsAt: dForm.endsAt || null };
      if (dModal === "new") await api("/api/admin/discounts", { method: "POST", body });
      else if (dModal) await api(`/api/admin/discounts/${dModal.id}`, { method: "PUT", body });
      toast.success(t("marketingAdmin.discountSavedToast")); setDModal(null); load();
    } catch (e) { toast.error(tError((e as Error).message)); }
    finally { setBusy(false); }
  }
  async function delDisc(id: string) {
    if (!confirm(t("marketingAdmin.confirmDeleteDiscount"))) return;
    try { await api(`/api/admin/discounts/${id}`, { method: "DELETE" }); toast.success(t("common.deleted")); load(); }
    catch (e) { toast.error(tError((e as Error).message)); }
  }

  function openBanner(b?: Banner) {
    setBModal(b ?? "new");
    setBForm(b ? { titleEn: b.titleEn, titleKm: b.titleKm, subtitleEn: b.subtitleEn ?? "", subtitleKm: b.subtitleKm ?? "", imageUrl: b.imageUrl, link: b.link ?? "", sortOrder: String(b.sortOrder), isActive: b.isActive } : { titleEn: "", titleKm: "", subtitleEn: "", subtitleKm: "", imageUrl: "", link: "/shop", sortOrder: String(banners.length + 1), isActive: true });
  }
  async function uploadBannerImg(file: File) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) return toast.error(t("common.error"));
    if (file.size > 5 * 1024 * 1024) return toast.error(t("messages.fileTooLarge"));
    const fd = new FormData(); fd.append("file", file); fd.append("folder", "banners");
    try { const r = await api<{ url: string }>("/api/uploads", { method: "POST", body: fd }); setBForm((f) => ({ ...f, imageUrl: r.url })); }
    catch (e) { toast.error(tError((e as Error).message)); }
  }
  async function saveBanner() {
    setBusy(true);
    try {
      const body = { ...bForm, sortOrder: Number(bForm.sortOrder || 0) };
      if (bModal === "new") await api("/api/admin/banners", { method: "POST", body });
      else if (bModal) await api(`/api/admin/banners/${bModal.id}`, { method: "PUT", body });
      toast.success(t("marketingAdmin.bannerSavedToast")); setBModal(null); load();
    } catch (e) { toast.error(tError((e as Error).message)); }
    finally { setBusy(false); }
  }
  async function delBanner(id: string) {
    if (!confirm(t("marketingAdmin.confirmDeleteBanner"))) return;
    try { await api(`/api/admin/banners/${id}`, { method: "DELETE" }); toast.success(t("common.deleted")); load(); }
    catch (e) { toast.error(tError((e as Error).message)); }
  }

  return (
    <div>
      <PageHeader title={t("marketingAdmin.title")} subtitle={t("marketingAdmin.subtitle")} />
      <Tabs defaultValue="discounts">
        <TabsList className="mb-4">
          <TabsTrigger value="discounts">{t("marketingAdmin.tabDiscounts", { n: discounts.length })}</TabsTrigger>
          <TabsTrigger value="banners">{t("marketingAdmin.tabBanners", { n: banners.length })}</TabsTrigger>
        </TabsList>
        <TabsContent value="discounts" className="space-y-4">
          <div className="flex justify-end"><Button onClick={() => openDisc()}><Plus /> {t("marketingAdmin.newDiscount")}</Button></div>
          <div className="overflow-x-auto rounded-2xl border bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-3">{t("marketingAdmin.colCode")}</th>
                  <th className="p-3">{t("marketingAdmin.colValue")}</th>
                  <th className="p-3">{t("marketingAdmin.colMinOrder")}</th>
                  <th className="p-3">{t("marketingAdmin.colUsage")}</th>
                  <th className="p-3">{t("marketingAdmin.colValid")}</th>
                  <th className="p-3">{t("common.active")}</th>
                  <th className="p-3 text-right">{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {discounts.map((d) => (
                  <tr key={d.id}>
                    <td className="p-3"><div className="font-mono font-bold text-primary">{d.code}</div><div className="text-xs text-muted-foreground">{d.description}</div></td>
                    <td className="p-3 font-semibold">{d.type === "PERCENTAGE" ? `${Number(d.value)}%` : `$${Number(d.value).toFixed(2)}`}{d.maxDiscount ? ` (${t("marketingAdmin.maxPrefix")} $${Number(d.maxDiscount)})` : ""}</td>
                    <td className="p-3">${Number(d.minSubtotal).toFixed(2)}</td>
                    <td className="p-3">{d.usedCount}{d.usageLimit ? ` / ${d.usageLimit}` : ""}</td>
                    <td className="p-3 text-xs">{formatDate(d.startsAt)} → {formatDate(d.endsAt)}</td>
                    <td className="p-3 text-xs">{d.isActive ? t("common.active") : t("common.paused")}</td>
                    <td className="p-3 text-right"><Button size="icon" variant="ghost" onClick={() => openDisc(d)}><Pencil className="size-4" /></Button><Button size="icon" variant="ghost" className="text-red-600" onClick={() => delDisc(d.id)}><Trash2 className="size-4" /></Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>
        <TabsContent value="banners" className="space-y-4">
          <div className="flex justify-end"><Button onClick={() => openBanner()}><Plus /> {t("marketingAdmin.addBanner")}</Button></div>
          <div className="grid gap-4 md:grid-cols-2">
            {banners.map((b) => {
              const bText = localizeBanner(b, locale, t);
              return (
                <div key={b.id} className="overflow-hidden rounded-2xl border bg-white shadow-sm">
                  <ProductImage src={b.imageUrl} alt={bText.title} className="aspect-[16/7] w-full" sizes="500px" />
                  <div className="flex items-center justify-between p-4">
                    <div><div className="font-semibold">{bText.title}</div><div className="text-xs text-muted-foreground">{b.titleKm} · {b.link}</div></div>
                    <div className="flex gap-1"><Button size="icon" variant="ghost" onClick={() => openBanner(b)}><Pencil className="size-4" /></Button><Button size="icon" variant="ghost" className="text-red-600" onClick={() => delBanner(b.id)}><Trash2 className="size-4" /></Button></div>
                  </div>
                </div>
              );
            })}
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={!!dModal} onOpenChange={(o) => !o && setDModal(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{dModal === "new" ? t("marketingAdmin.newDiscountTitle") : t("marketingAdmin.editDiscountTitle")}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label>{t("marketingAdmin.colCode")} *</Label><Input value={dForm.code} onChange={(e) => setDForm({ ...dForm, code: e.target.value.toUpperCase() })} className="font-mono uppercase" /></div>
              <div className="space-y-1">
                <Label>{t("marketingAdmin.typeLabel")}</Label>
                <select className="h-9 w-full rounded-md border bg-white px-3 text-sm" value={dForm.type} onChange={(e) => setDForm({ ...dForm, type: e.target.value as "PERCENTAGE" | "FIXED" })}>
                  <option value="PERCENTAGE">{t("marketingAdmin.typePercentage")}</option>
                  <option value="FIXED">{t("marketingAdmin.typeFixed")}</option>
                </select>
              </div>
              <div className="space-y-1"><Label>{t("marketingAdmin.valueLabel")} *</Label><Input type="number" step="0.01" value={dForm.value} onChange={(e) => setDForm({ ...dForm, value: e.target.value })} /></div>
              <div className="space-y-1"><Label>{t("marketingAdmin.minSubtotalUsd")}</Label><Input type="number" step="0.01" value={dForm.minSubtotal} onChange={(e) => setDForm({ ...dForm, minSubtotal: e.target.value })} /></div>
              <div className="space-y-1"><Label>{t("marketingAdmin.maxDiscountUsd")}</Label><Input type="number" step="0.01" value={dForm.maxDiscount} onChange={(e) => setDForm({ ...dForm, maxDiscount: e.target.value })} /></div>
              <div className="space-y-1"><Label>{t("marketingAdmin.usageLimit")}</Label><Input type="number" value={dForm.usageLimit} onChange={(e) => setDForm({ ...dForm, usageLimit: e.target.value })} /></div>
              <div className="space-y-1"><Label>{t("marketingAdmin.startDate")}</Label><Input type="date" value={dForm.startsAt} onChange={(e) => setDForm({ ...dForm, startsAt: e.target.value })} /></div>
              <div className="space-y-1"><Label>{t("marketingAdmin.endDate")}</Label><Input type="date" value={dForm.endsAt} onChange={(e) => setDForm({ ...dForm, endsAt: e.target.value })} /></div>
            </div>
            <div className="space-y-1"><Label>{t("marketingAdmin.description")}</Label><Input value={dForm.description} onChange={(e) => setDForm({ ...dForm, description: e.target.value })} /></div>
            <div className="flex items-center gap-2"><Switch checked={dForm.isActive} onCheckedChange={(v) => setDForm({ ...dForm, isActive: v })} /><Label>{t("common.active")}</Label></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setDModal(null)}>{t("common.cancel")}</Button><Button onClick={saveDisc} disabled={busy}>{busy && <Loader2 className="animate-spin" />} {t("common.save")}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!bModal} onOpenChange={(o) => !o && setBModal(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{bModal === "new" ? t("marketingAdmin.newBannerTitle") : t("marketingAdmin.editBannerTitle")}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label>{t("marketingAdmin.titleEn")} *</Label><Input value={bForm.titleEn} onChange={(e) => setBForm({ ...bForm, titleEn: e.target.value })} /></div>
              <div className="space-y-1"><Label>{t("marketingAdmin.titleKm")} *</Label><Input value={bForm.titleKm} onChange={(e) => setBForm({ ...bForm, titleKm: e.target.value })} /></div>
              <div className="space-y-1"><Label>{t("marketingAdmin.subtitleEn")}</Label><Input value={bForm.subtitleEn} onChange={(e) => setBForm({ ...bForm, subtitleEn: e.target.value })} /></div>
              <div className="space-y-1"><Label>{t("marketingAdmin.subtitleKm")}</Label><Input value={bForm.subtitleKm} onChange={(e) => setBForm({ ...bForm, subtitleKm: e.target.value })} /></div>
              <div className="space-y-1"><Label>{t("marketingAdmin.targetLink")}</Label><Input value={bForm.link} onChange={(e) => setBForm({ ...bForm, link: e.target.value })} /></div>
              <div className="space-y-1"><Label>{t("marketingAdmin.sortOrder")}</Label><Input type="number" value={bForm.sortOrder} onChange={(e) => setBForm({ ...bForm, sortOrder: e.target.value })} /></div>
            </div>
            <div className="space-y-1.5">
              <Label>{t("marketingAdmin.bannerImage")} *</Label>
              <div className="flex items-center gap-3">
                <ProductImage src={bForm.imageUrl || null} alt="" className="h-16 w-28 rounded-lg" sizes="112px" />
                <label className="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed p-3 text-xs font-medium text-primary"><Upload className="size-4" /> {t("marketingAdmin.uploadRealPhoto")}<input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => e.target.files?.[0] && uploadBannerImg(e.target.files[0])} /></label>
              </div>
              <Input value={bForm.imageUrl} onChange={(e) => setBForm({ ...bForm, imageUrl: e.target.value })} placeholder={t("marketingAdmin.orImagePath")} className="text-xs" />
            </div>
            <div className="flex items-center gap-2"><Switch checked={bForm.isActive} onCheckedChange={(v) => setBForm({ ...bForm, isActive: v })} /><Label>{t("common.active")}</Label></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setBModal(null)}>{t("common.cancel")}</Button><Button onClick={saveBanner} disabled={busy}>{busy && <Loader2 className="animate-spin" />} {t("common.save")}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
