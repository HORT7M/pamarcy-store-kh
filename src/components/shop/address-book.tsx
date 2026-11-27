"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MapPin, Pencil, Trash2, Plus, Loader2, Star } from "lucide-react";
import { toast } from "sonner";
import { useI18n } from "@/components/providers/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AddressFields } from "@/components/common/address-fields";
import { EmptyState } from "@/components/common/empty-state";
import { api } from "@/lib/fetcher";
import { formatKhPhone, isKhPhone } from "@/lib/phone";
import { provinceLabel } from "@/lib/cambodia";

type A = { id: string; label: string | null; fullName: string; phone: string; province: string; district: string; commune: string | null; village: string | null; street: string | null; instructions: string | null; isDefault: boolean };
const empty = { label: "", fullName: "", phone: "", province: "", district: "", commune: "", village: "", street: "", instructions: "", isDefault: false };

export function AddressBook({ initial }: { initial: A[] }) {
  const { t, tError, locale } = useI18n();
  const router = useRouter();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [form, setForm] = useState(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  function open(a?: A) {
    setErrors({});
    setEditing(a?.id ?? "new");
    setForm(a ? { label: a.label ?? "", fullName: a.fullName, phone: a.phone, province: a.province, district: a.district, commune: a.commune ?? "", village: a.village ?? "", street: a.street ?? "", instructions: a.instructions ?? "", isDefault: a.isDefault } : empty);
  }
  async function save() {
    const e: Record<string, string> = {};
    if (form.fullName.trim().length < 2) e.fullName = t("common.required");
    if (!isKhPhone(form.phone)) e.phone = t("checkout.invalidPhone");
    if (!form.province) e.province = t("common.required");
    if (!form.district) e.district = t("common.required");
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    try {
      await api(editing === "new" ? "/api/account/addresses" : `/api/account/addresses/${editing}`, { method: editing === "new" ? "POST" : "PUT", body: form });
      toast.success(t("common.success"));
      setEditing(null);
      router.refresh();
    } catch (err) {
      toast.error(tError((err as Error).message));
    } finally {
      setSaving(false);
    }
  }
  async function remove(id: string) {
    if (!confirm(`${t("common.delete")}?`)) return;
    try {
      await api(`/api/account/addresses/${id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      toast.error(tError((err as Error).message));
    }
  }
  async function makeDefault(a: A) {
    await api(`/api/account/addresses/${a.id}`, { method: "PUT", body: { label: a.label ?? "", fullName: a.fullName, phone: a.phone, province: a.province, district: a.district, commune: a.commune ?? "", village: a.village ?? "", street: a.street ?? "", instructions: a.instructions ?? "", isDefault: true } }).catch((e) => toast.error(tError((e as Error).message)));
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h1 className="text-2xl font-bold">{t("account.addresses")}</h1><Button onClick={() => open()} className="rounded-full"><Plus /> {t("account.addAddress")}</Button></div>
      {initial.length === 0 ? <EmptyState icon={MapPin} title={t("common.noResults")} /> : (
        <div className="grid gap-3 md:grid-cols-2">
          {initial.map((a) => (
            <div key={a.id} className="rounded-2xl border bg-white p-4 shadow-sm">
              <div className="mb-1 flex items-center gap-2 font-semibold">{a.label ?? a.fullName}{a.isDefault && <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] text-secondary-foreground">{t("account.defaultAddress")}</span>}</div>
              <div className="text-sm">{a.fullName} · {formatKhPhone(a.phone)}</div>
              <div className="text-sm text-muted-foreground">{[a.street, a.village, a.commune, a.district, provinceLabel(a.province, locale)].filter(Boolean).join(", ")}</div>
              <div className="mt-3 flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => open(a)}><Pencil /> {t("common.edit")}</Button>
                {!a.isDefault && <Button size="sm" variant="ghost" onClick={() => makeDefault(a)}><Star /> {t("account.setDefault")}</Button>}
                <Button size="sm" variant="ghost" className="text-red-600" onClick={() => remove(a.id)}><Trash2 /> {t("common.delete")}</Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader><DialogTitle>{editing === "new" ? t("account.addAddress") : t("common.edit")}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5"><Label>{t("account.label")}</Label><Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} maxLength={50} /></div>
              <div className="space-y-1.5"><Label>{t("checkout.fullName")} *</Label><Input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} maxLength={100} aria-invalid={!!errors.fullName} />{errors.fullName && <p className="text-xs text-red-600">{errors.fullName}</p>}</div>
              <div className="space-y-1.5"><Label>{t("checkout.phone")} *</Label><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} maxLength={25} aria-invalid={!!errors.phone} />{errors.phone && <p className="text-xs text-red-600">{errors.phone}</p>}</div>
            </div>
            <AddressFields value={form} onChange={(v) => setForm({ ...form, ...v })} errors={errors} />
            <div className="space-y-1.5"><Label>{t("checkout.instructions")}</Label><Textarea rows={2} maxLength={300} value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} /></div>
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={form.isDefault} onCheckedChange={(v) => setForm({ ...form, isDefault: !!v })} /> {t("account.setDefault")}</label>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setEditing(null)}>{t("common.cancel")}</Button><Button onClick={save} disabled={saving}>{saving && <Loader2 className="animate-spin" />}{t("common.save")}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
