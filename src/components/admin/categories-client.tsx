"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Pencil, Trash2, Loader2, Upload } from "lucide-react";
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
import { api } from "@/lib/fetcher";

type Cat = { id: string; slug: string; nameEn: string; nameKm: string; description: string | null; imageUrl: string | null; sortOrder: number; isActive: boolean; _count: { medicines: number } };
type Brand = { id: string; slug: string; name: string; manufacturer: string | null; country: string | null; _count: { medicines: number } };

export function CategoriesClient() {
  const { t, tError, catName } = useI18n();
  const [cats, setCats] = useState<Cat[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [catModal, setCatModal] = useState<Cat | "new" | null>(null);
  const [catForm, setCatForm] = useState({ nameEn: "", nameKm: "", description: "", imageUrl: "", sortOrder: "0", isActive: true });
  const [brandModal, setBrandModal] = useState<Brand | "new" | null>(null);
  const [brandForm, setBrandForm] = useState({ name: "", manufacturer: "", country: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ items: Cat[] }>("/api/admin/categories").then((r) => setCats(r.items)).catch((e) => toast.error(tError((e as Error).message)));
    api<{ items: Brand[] }>("/api/admin/brands").then((r) => setBrands(r.items)).catch((e) => toast.error(tError((e as Error).message)));
  }, [tError]);
  useEffect(load, [load]);

  function openCat(c?: Cat) {
    setCatModal(c ?? "new");
    setCatForm(c ? { nameEn: c.nameEn, nameKm: c.nameKm, description: c.description ?? "", imageUrl: c.imageUrl ?? "", sortOrder: String(c.sortOrder), isActive: c.isActive } : { nameEn: "", nameKm: "", description: "", imageUrl: "", sortOrder: String(cats.length), isActive: true });
  }
  async function uploadCatImg(file: File) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) return toast.error(t("common.error"));
    if (file.size > 5 * 1024 * 1024) return toast.error(t("messages.fileTooLarge"));
    const fd = new FormData(); fd.append("file", file); fd.append("folder", "categories");
    try { const r = await api<{ url: string }>("/api/uploads", { method: "POST", body: fd }); setCatForm((f) => ({ ...f, imageUrl: r.url })); }
    catch (e) { toast.error(tError((e as Error).message)); }
  }
  async function saveCat() {
    setBusy(true);
    try {
      const body = { ...catForm, sortOrder: Number(catForm.sortOrder || 0), imageUrl: catForm.imageUrl || null };
      if (catModal === "new") await api("/api/admin/categories", { method: "POST", body });
      else if (catModal) await api(`/api/admin/categories/${catModal.id}`, { method: "PUT", body });
      toast.success(t("common.saved")); setCatModal(null); load();
    } catch (e) { toast.error(tError((e as Error).message)); }
    finally { setBusy(false); }
  }
  async function delCat(id: string) {
    if (!confirm(t("categoriesAdmin.confirmDeleteCat"))) return;
    try { await api(`/api/admin/categories/${id}`, { method: "DELETE" }); toast.success(t("common.deleted")); load(); }
    catch (e) { toast.error(tError((e as Error).message)); }
  }

  function openBrand(b?: Brand) {
    setBrandModal(b ?? "new");
    setBrandForm(b ? { name: b.name, manufacturer: b.manufacturer ?? "", country: b.country ?? "" } : { name: "", manufacturer: "", country: "" });
  }
  async function saveBrand() {
    setBusy(true);
    try {
      if (brandModal === "new") await api("/api/admin/brands", { method: "POST", body: brandForm });
      else if (brandModal) await api(`/api/admin/brands/${brandModal.id}`, { method: "PUT", body: brandForm });
      toast.success(t("common.saved")); setBrandModal(null); load();
    } catch (e) { toast.error(tError((e as Error).message)); }
    finally { setBusy(false); }
  }
  async function delBrand(id: string) {
    if (!confirm(t("categoriesAdmin.confirmDeleteBrand"))) return;
    try { await api(`/api/admin/brands/${id}`, { method: "DELETE" }); toast.success(t("common.deleted")); load(); }
    catch (e) { toast.error(tError((e as Error).message)); }
  }

  return (
    <div>
      <PageHeader title={t("categoriesAdmin.title")} subtitle={t("categoriesAdmin.subtitle")} />
      <Tabs defaultValue="cats">
        <TabsList className="mb-4">
          <TabsTrigger value="cats">{t("categoriesAdmin.tabCategories", { n: cats.length })}</TabsTrigger>
          <TabsTrigger value="brands">{t("categoriesAdmin.tabBrands", { n: brands.length })}</TabsTrigger>
        </TabsList>
        <TabsContent value="cats" className="space-y-4">
          <div className="flex justify-end"><Button onClick={() => openCat()}><Plus /> {t("categoriesAdmin.addCategory")}</Button></div>
          <div className="overflow-x-auto rounded-2xl border bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-3">{t("categoriesAdmin.colCategory")}</th>
                  <th className="p-3">{t("categoriesAdmin.colSlug")}</th>
                  <th className="p-3 text-right">{t("categoriesAdmin.colMedicines")}</th>
                  <th className="p-3">{t("categoriesAdmin.colOrder")}</th>
                  <th className="p-3">{t("categoriesAdmin.colActive")}</th>
                  <th className="p-3 text-right">{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {cats.map((c) => (
                  <tr key={c.id}>
                    <td className="p-3"><div className="flex items-center gap-3"><ProductImage src={c.imageUrl} alt={catName(c)} className="size-10 shrink-0 rounded-lg" sizes="40px" /><div><div className="font-medium">{catName(c)}</div><div className="text-xs text-muted-foreground">{c.nameKm}</div></div></div></td>
                    <td className="p-3 font-mono text-xs">{c.slug}</td>
                    <td className="p-3 text-right">{c._count.medicines}</td>
                    <td className="p-3">{c.sortOrder}</td>
                    <td className="p-3 text-xs">{c.isActive ? t("common.active") : t("common.hidden")}</td>
                    <td className="p-3 text-right"><Button size="icon" variant="ghost" onClick={() => openCat(c)}><Pencil className="size-4" /></Button><Button size="icon" variant="ghost" className="text-red-600" onClick={() => delCat(c.id)}><Trash2 className="size-4" /></Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>
        <TabsContent value="brands" className="space-y-4">
          <div className="flex justify-end"><Button onClick={() => openBrand()}><Plus /> {t("categoriesAdmin.addBrand")}</Button></div>
          <div className="overflow-x-auto rounded-2xl border bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-3">{t("categoriesAdmin.colBrand")}</th>
                  <th className="p-3">{t("categoriesAdmin.colManufacturer")}</th>
                  <th className="p-3">{t("categoriesAdmin.colCountry")}</th>
                  <th className="p-3 text-right">{t("categoriesAdmin.colMedicines")}</th>
                  <th className="p-3 text-right">{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {brands.map((b) => (
                  <tr key={b.id}>
                    <td className="p-3 font-medium">{b.name}</td><td className="p-3 text-muted-foreground">{b.manufacturer ?? "—"}</td><td className="p-3 text-muted-foreground">{b.country ?? "—"}</td>
                    <td className="p-3 text-right">{b._count.medicines}</td>
                    <td className="p-3 text-right"><Button size="icon" variant="ghost" onClick={() => openBrand(b)}><Pencil className="size-4" /></Button><Button size="icon" variant="ghost" className="text-red-600" onClick={() => delBrand(b.id)}><Trash2 className="size-4" /></Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={!!catModal} onOpenChange={(o) => !o && setCatModal(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{catModal === "new" ? t("categoriesAdmin.newCategory") : t("categoriesAdmin.editCategory")}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label>{t("categoriesAdmin.englishName")} *</Label><Input value={catForm.nameEn} onChange={(e) => setCatForm({ ...catForm, nameEn: e.target.value })} /></div>
              <div className="space-y-1"><Label>{t("categoriesAdmin.khmerName")} *</Label><Input value={catForm.nameKm} onChange={(e) => setCatForm({ ...catForm, nameKm: e.target.value })} /></div>
            </div>
            <div className="space-y-1"><Label>{t("categoriesAdmin.description")}</Label><Input value={catForm.description} onChange={(e) => setCatForm({ ...catForm, description: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label>{t("categoriesAdmin.sortOrder")}</Label><Input type="number" value={catForm.sortOrder} onChange={(e) => setCatForm({ ...catForm, sortOrder: e.target.value })} /></div>
              <div className="flex items-end gap-2 pb-1.5"><Switch checked={catForm.isActive} onCheckedChange={(v) => setCatForm({ ...catForm, isActive: v })} /><Label>{t("common.active")}</Label></div>
            </div>
            <div className="flex items-center gap-3">
              <ProductImage src={catForm.imageUrl || null} alt="" className="size-14 rounded-lg" sizes="56px" />
              <label className="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed p-2.5 text-xs font-medium text-primary"><Upload className="size-4" /> {t("categoriesAdmin.uploadImage")}<input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => e.target.files?.[0] && uploadCatImg(e.target.files[0])} /></label>
            </div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setCatModal(null)}>{t("common.cancel")}</Button><Button onClick={saveCat} disabled={busy}>{busy && <Loader2 className="animate-spin" />} {t("common.save")}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!brandModal} onOpenChange={(o) => !o && setBrandModal(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{brandModal === "new" ? t("categoriesAdmin.newBrand") : t("categoriesAdmin.editBrand")}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1"><Label>{t("categoriesAdmin.brandName")} *</Label><Input value={brandForm.name} onChange={(e) => setBrandForm({ ...brandForm, name: e.target.value })} /></div>
            <div className="space-y-1"><Label>{t("categoriesAdmin.colManufacturer")}</Label><Input value={brandForm.manufacturer} onChange={(e) => setBrandForm({ ...brandForm, manufacturer: e.target.value })} /></div>
            <div className="space-y-1"><Label>{t("categoriesAdmin.colCountry")}</Label><Input value={brandForm.country} onChange={(e) => setBrandForm({ ...brandForm, country: e.target.value })} /></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setBrandModal(null)}>{t("common.cancel")}</Button><Button onClick={saveBrand} disabled={busy}>{busy && <Loader2 className="animate-spin" />} {t("common.save")}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
