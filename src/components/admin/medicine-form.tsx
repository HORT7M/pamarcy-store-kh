"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, Upload, Trash2, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { ProductImage } from "@/components/common/product-image";
import { useI18n } from "@/components/providers/i18n-provider";
import { api } from "@/lib/fetcher";

type Option = { id: string; name: string };

export type MedicineFormData = {
  id?: string; nameEn: string; nameKm: string; genericName: string; sku: string; barcode: string; categoryId: string; brandId: string;
  manufacturer: string; activeIngredients: string; dosageForm: string; strength: string; dosageInfo: string; usageInstructions: string; warnings: string;
  descriptionEn: string; descriptionKm: string; unit: string; price: string; compareAtPrice: string; costPrice: string; minStock: string; location: string;
  imageUrl: string; requiresPrescription: boolean; tracksExpiry: boolean; isFeatured: boolean; isActive: boolean;
};

export function MedicineForm({ initial, categories, brands, canWrite = true, canDelete, canAddOpeningStock = false }: { initial?: MedicineFormData; categories: Option[]; brands: Option[]; canWrite?: boolean; canDelete?: boolean; canAddOpeningStock?: boolean }) {
  const router = useRouter();
  const { t, tError } = useI18n();
  const isEdit = !!initial?.id;
  const [f, setF] = useState<MedicineFormData>(initial ?? {
    nameEn: "", nameKm: "", genericName: "", sku: "", barcode: "", categoryId: categories[0]?.id ?? "", brandId: "", manufacturer: "",
    activeIngredients: "", dosageForm: "Tablet", strength: "", dosageInfo: "", usageInstructions: "", warnings: "", descriptionEn: "", descriptionKm: "",
    unit: "box", price: "", compareAtPrice: "", costPrice: "0", minStock: "10", location: "", imageUrl: "",
    requiresPrescription: false, tracksExpiry: true, isFeatured: false, isActive: true,
  });
  const [addOpening, setAddOpening] = useState(false);
  const [opening, setOpening] = useState({ batchNumber: "", quantity: "", expiryDate: "", costPrice: "" });
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof MedicineFormData>(k: K, v: MedicineFormData[K]) => setF((prev) => ({ ...prev, [k]: v }));

  async function onUpload(file: File) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) return toast.error(t("common.error"));
    if (file.size > 5 * 1024 * 1024) return toast.error(t("messages.fileTooLarge"));
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("folder", "products");
      const r = await api<{ url: string }>("/api/uploads", { method: "POST", body: fd });
      set("imageUrl", r.url);
      toast.success(t("medicinesAdmin.imageUploaded"));
    } catch (e) {
      toast.error(tError((e as Error).message));
    } finally {
      setUploading(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canWrite) return;
    if (!f.nameEn.trim() || !f.nameKm.trim() || !f.sku.trim() || !f.categoryId) return toast.error(t("medicinesAdmin.fillRequired"));
    if (Number(f.price) <= 0) return toast.error(t("medicinesAdmin.pricePositive"));
    setSaving(true);
    try {
      const { id: _id, ...fields } = f;
      void _id;
      const payload = {
        ...fields,
        brandId: f.brandId || null,
        barcode: f.barcode || null,
        price: Number(f.price),
        compareAtPrice: f.compareAtPrice ? Number(f.compareAtPrice) : null,
        costPrice: Number(f.costPrice || 0),
        minStock: Number(f.minStock || 0),
        imageUrl: f.imageUrl || null,
        images: f.imageUrl ? [f.imageUrl] : [],
        initialStock: !isEdit && canAddOpeningStock && addOpening && Number(opening.quantity) > 0
          ? { batchNumber: opening.batchNumber, quantity: Number(opening.quantity), expiryDate: opening.expiryDate || null, costPrice: opening.costPrice ? Number(opening.costPrice) : Number(f.costPrice || 0) }
          : null,
      };
      if (isEdit) {
        await api(`/api/admin/medicines/${initial.id}`, { method: "PUT", body: payload });
        toast.success(t("medicinesAdmin.medicineUpdated"));
        router.refresh();
      } else {
        const created = await api<{ id: string }>("/api/admin/medicines", { method: "POST", body: payload });
        toast.success(t("medicinesAdmin.medicineCreated"));
        router.push(`/admin/medicines/${created.id}`);
      }
    } catch (err) {
      toast.error(tError((err as Error).message));
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (!initial?.id || !confirm(t("medicinesAdmin.confirmDelete"))) return;
    setSaving(true);
    try {
      await api(`/api/admin/medicines/${initial.id}`, { method: "DELETE" });
      toast.success(t("medicinesAdmin.medicineDeleted"));
      router.push("/admin/medicines");
      router.refresh();
    } catch (err) {
      toast.error(tError((err as Error).message));
      setSaving(false);
    }
  }

  const sel = "h-9 w-full rounded-md border bg-white px-3 text-sm";

  return (
    <form onSubmit={submit} className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href="/admin/medicines" className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"><ArrowLeft className="size-4" /> {t("medicinesAdmin.backToMedicines")}</Link>
        <div className="flex gap-2">
          {isEdit && canDelete && <Button type="button" variant="outline" className="text-red-600" onClick={onDelete} disabled={saving}><Trash2 className="size-4" /> {t("common.delete")}</Button>}
          {canWrite && <Button type="submit" disabled={saving || uploading}>{saving && <Loader2 className="animate-spin" />}{isEdit ? t("medicinesAdmin.saveChanges") : t("medicinesAdmin.createMedicine")}</Button>}
        </div>
      </div>

      <fieldset disabled={!canWrite} className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <section className="space-y-4 rounded-2xl border bg-white p-5 shadow-sm">
            <h2 className="font-semibold">{t("medicinesAdmin.identityNames")}</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5"><Label>{t("medicinesAdmin.englishName")} *</Label><Input required value={f.nameEn} onChange={(e) => set("nameEn", e.target.value)} /></div>
              <div className="space-y-1.5"><Label>{t("medicinesAdmin.khmerName")} *</Label><Input required value={f.nameKm} onChange={(e) => set("nameKm", e.target.value)} /></div>
              <div className="space-y-1.5"><Label>{t("medicinesAdmin.genericName")}</Label><Input value={f.genericName} onChange={(e) => set("genericName", e.target.value)} /></div>
              <div className="space-y-1.5"><Label>{t("medicinesAdmin.manufacturer")}</Label><Input value={f.manufacturer} onChange={(e) => set("manufacturer", e.target.value)} /></div>
              <div className="space-y-1.5"><Label>{t("medicinesAdmin.sku")} *</Label><Input required value={f.sku} onChange={(e) => set("sku", e.target.value)} className="font-mono" /></div>
              <div className="space-y-1.5"><Label>{t("medicinesAdmin.barcode")}</Label><Input value={f.barcode} onChange={(e) => set("barcode", e.target.value)} className="font-mono" /></div>
              <div className="space-y-1.5">
                <Label>{t("medicinesAdmin.category")} *</Label>
                <select className={sel} value={f.categoryId} onChange={(e) => set("categoryId", e.target.value)}>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>{t("medicinesAdmin.brand")}</Label>
                <select className={sel} value={f.brandId} onChange={(e) => set("brandId", e.target.value)}>
                  <option value="">{t("common.none")}</option>
                  {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
            </div>
          </section>

          <section className="space-y-4 rounded-2xl border bg-white p-5 shadow-sm">
            <h2 className="font-semibold">{t("medicinesAdmin.clinicalDetails")}</h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5"><Label>{t("medicinesAdmin.dosageForm")}</Label><Input value={f.dosageForm} placeholder={t("medicinesAdmin.dosageFormPh")} onChange={(e) => set("dosageForm", e.target.value)} /></div>
              <div className="space-y-1.5"><Label>{t("medicinesAdmin.strength")}</Label><Input value={f.strength} placeholder={t("medicinesAdmin.strengthPh")} onChange={(e) => set("strength", e.target.value)} /></div>
              <div className="space-y-1.5"><Label>{t("medicinesAdmin.unit")}</Label><Input value={f.unit} placeholder={t("medicinesAdmin.unitPh")} onChange={(e) => set("unit", e.target.value)} /></div>
            </div>
            <div className="space-y-1.5"><Label>{t("medicinesAdmin.activeIngredients")}</Label><Input value={f.activeIngredients} onChange={(e) => set("activeIngredients", e.target.value)} /></div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5"><Label>{t("medicinesAdmin.dosageInfo")}</Label><Textarea rows={3} value={f.dosageInfo} onChange={(e) => set("dosageInfo", e.target.value)} /></div>
              <div className="space-y-1.5"><Label>{t("medicinesAdmin.usageInstructions")}</Label><Textarea rows={3} value={f.usageInstructions} onChange={(e) => set("usageInstructions", e.target.value)} /></div>
            </div>
            <div className="space-y-1.5"><Label>{t("medicinesAdmin.warnings")}</Label><Textarea rows={2} value={f.warnings} onChange={(e) => set("warnings", e.target.value)} /></div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5"><Label>{t("medicinesAdmin.descEn")}</Label><Textarea rows={3} value={f.descriptionEn} onChange={(e) => set("descriptionEn", e.target.value)} /></div>
              <div className="space-y-1.5"><Label>{t("medicinesAdmin.descKm")}</Label><Textarea rows={3} value={f.descriptionKm} onChange={(e) => set("descriptionKm", e.target.value)} /></div>
            </div>
          </section>

          {!isEdit && canAddOpeningStock && (
            <section className="space-y-4 rounded-2xl border bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <div><h2 className="font-semibold">{t("medicinesAdmin.openingBatchTitle")}</h2><p className="text-xs text-muted-foreground">{t("medicinesAdmin.openingBatchSub")}</p></div>
                <Switch checked={addOpening} onCheckedChange={setAddOpening} />
              </div>
              {addOpening && (
                <div className="grid gap-4 sm:grid-cols-4">
                  <div className="space-y-1.5"><Label>{t("medicinesAdmin.batchNo")} *</Label><Input required={addOpening} value={opening.batchNumber} onChange={(e) => setOpening({ ...opening, batchNumber: e.target.value })} /></div>
                  <div className="space-y-1.5"><Label>{t("common.quantity")} *</Label><Input required={addOpening} type="number" min={1} value={opening.quantity} onChange={(e) => setOpening({ ...opening, quantity: e.target.value })} /></div>
                  <div className="space-y-1.5"><Label>{t("medicinesAdmin.expiryDate")} {f.tracksExpiry ? "*" : ""}</Label><Input required={addOpening && f.tracksExpiry} type="date" value={opening.expiryDate} onChange={(e) => setOpening({ ...opening, expiryDate: e.target.value })} /></div>
                  <div className="space-y-1.5"><Label>{t("medicinesAdmin.unitCostUsd")}</Label><Input type="number" min={0} step="0.01" value={opening.costPrice} placeholder={f.costPrice} onChange={(e) => setOpening({ ...opening, costPrice: e.target.value })} /></div>
                </div>
              )}
            </section>
          )}
        </div>

        <div className="space-y-6">
          <section className="space-y-3 rounded-2xl border bg-white p-5 shadow-sm">
            <h2 className="font-semibold">{t("medicinesAdmin.productImage")}</h2>
            <ProductImage src={f.imageUrl || null} alt={f.nameEn || t("medicinesAdmin.colMedicine")} className="aspect-[4/3] w-full rounded-xl border" />
            <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed p-3 text-sm font-medium text-primary hover:bg-secondary/40">
              {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} {t("medicinesAdmin.uploadPhoto")}
              <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])} disabled={uploading} />
            </label>
            <Input value={f.imageUrl} onChange={(e) => set("imageUrl", e.target.value)} placeholder={t("medicinesAdmin.orImageUrl")} className="text-xs" />
          </section>

          <section className="space-y-4 rounded-2xl border bg-white p-5 shadow-sm">
            <h2 className="font-semibold">{t("medicinesAdmin.pricingStockRules")}</h2>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>{t("medicinesAdmin.priceUsd")} *</Label><Input required type="number" min="0.01" step="0.01" value={f.price} onChange={(e) => set("price", e.target.value)} /></div>
              <div className="space-y-1.5"><Label>{t("medicinesAdmin.compareAtUsd")}</Label><Input type="number" min="0" step="0.01" value={f.compareAtPrice} onChange={(e) => set("compareAtPrice", e.target.value)} /></div>
              <div className="space-y-1.5"><Label>{t("medicinesAdmin.costPriceUsd")}</Label><Input type="number" min="0" step="0.01" value={f.costPrice} onChange={(e) => set("costPrice", e.target.value)} /></div>
              <div className="space-y-1.5"><Label>{t("medicinesAdmin.minStockAlert")}</Label><Input type="number" min="0" value={f.minStock} onChange={(e) => set("minStock", e.target.value)} /></div>
            </div>
            <div className="space-y-1.5"><Label>{t("medicinesAdmin.shelfLocation")}</Label><Input value={f.location} placeholder={t("medicinesAdmin.shelfPh")} onChange={(e) => set("location", e.target.value)} /></div>
          </section>

          <section className="space-y-3 rounded-2xl border bg-white p-5 shadow-sm">
            <h2 className="font-semibold">{t("medicinesAdmin.flags")}</h2>
            {[
              ["requiresPrescription", t("medicinesAdmin.flagRxTitle"), t("medicinesAdmin.flagRxSub")],
              ["tracksExpiry", t("medicinesAdmin.flagExpiryTitle"), t("medicinesAdmin.flagExpirySub")],
              ["isFeatured", t("medicinesAdmin.flagFeaturedTitle"), t("medicinesAdmin.flagFeaturedSub")],
              ["isActive", t("medicinesAdmin.flagActiveTitle"), t("medicinesAdmin.flagActiveSub")],
            ].map(([k, title, sub]) => (
              <div key={k} className="flex items-center justify-between gap-2">
                <div><div className="text-sm font-medium">{title}</div><div className="text-xs text-muted-foreground">{sub}</div></div>
                <Switch checked={f[k as keyof MedicineFormData] as boolean} onCheckedChange={(v) => set(k as keyof MedicineFormData, v as never)} />
              </div>
            ))}
          </section>
        </div>
      </fieldset>
    </form>
  );
}
