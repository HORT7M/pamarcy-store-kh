"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Ban, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/common/status-badge";
import { formatDate, formatDateTime } from "@/lib/date";
import { formatKhPhone } from "@/lib/phone";
import { useI18n } from "@/components/providers/i18n-provider";
import { api } from "@/lib/fetcher";

type Detail = {
  id: string; notes: string | null;
  user: { id: string; name: string; email: string; phone: string | null; status: "ACTIVE" | "SUSPENDED"; lastLoginAt: string | null; createdAt: string };
  addresses: { id: string; label: string | null; fullName: string; phone: string; province: string; district: string; commune: string | null; street: string | null; isDefault: boolean }[];
  orders: { id: string; number: string; status: string; paymentStatus: string; total: string; createdAt: string; items: { id: string }[] }[];
  topItems: { medicineId: string; nameEn: string; _sum: { quantity: number | null; lineTotal: string | null } }[];
};

export function CustomerDetailClient({ id, canWrite }: { id: string; canWrite: boolean }) {
  const { money, t, tError } = useI18n();
  const [c, setC] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", email: "", phone: "", notes: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoadError(null);
    api<Detail>(`/api/admin/customers/${id}`)
      .then((d) => {
        setC(d);
        setForm({ name: d.user.name, email: d.user.email, phone: d.user.phone ?? "", notes: d.notes ?? "" });
      })
      .catch((e) => {
        const msg = tError((e as Error).message);
        setLoadError(msg);
        toast.error(msg);
      });
  }, [id, tError]);
  useEffect(load, [load]);

  if (loadError && !c) {
    return (
      <div className="space-y-4 py-12 text-center">
        <p className="text-sm text-red-600">{loadError}</p>
        <Link href="/admin/customers" className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"><ArrowLeft className="size-4" /> {t("customersAdmin.backToCustomers")}</Link>
      </div>
    );
  }
  if (!c) return <div className="py-20 text-center"><Loader2 className="mx-auto animate-spin" /></div>;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/api/admin/customers/${id}`, { method: "PATCH", body: { name: form.name, email: form.email, ...(form.phone ? { phone: form.phone } : {}), notes: form.notes } });
      toast.success(t("customersAdmin.customerUpdatedToast")); load();
    } catch (err) { toast.error(tError((err as Error).message)); }
    finally { setBusy(false); }
  }

  async function toggleStatus() {
    if (!c) return;
    const next = c.user.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE";
    const msg = next === "SUSPENDED" ? t("customersAdmin.confirmSuspend", { name: c.user.name }) : t("customersAdmin.confirmReactivate", { name: c.user.name });
    if (!confirm(msg)) return;
    setBusy(true);
    try {
      await api(`/api/admin/customers/${id}`, { method: "PATCH", body: { status: next } });
      toast.success(next === "SUSPENDED" ? t("customersAdmin.accountSuspendedToast") : t("customersAdmin.accountActivatedToast")); load();
    } catch (err) { toast.error(tError((err as Error).message)); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-5">
      <Link href="/admin/customers" className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"><ArrowLeft className="size-4" /> {t("customersAdmin.backToCustomers")}</Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{c.user.name}</h1>
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span>{t("customersAdmin.joinedPrefix", { date: formatDate(c.user.createdAt) })}</span> · <span>{t("customersAdmin.lastLoginPrefix", { date: formatDateTime(c.user.lastLoginAt) })}</span>
            <StatusBadge status={c.user.status} />
          </div>
        </div>
        {canWrite && (
          <Button variant={c.user.status === "ACTIVE" ? "destructive" : "default"} onClick={toggleStatus} disabled={busy}>
            {c.user.status === "ACTIVE" ? <><Ban /> {t("customersAdmin.suspendAccount")}</> : <><CheckCircle2 /> {t("customersAdmin.reactivateAccount")}</>}
          </Button>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <form onSubmit={save} className="space-y-3 rounded-2xl border bg-white p-5 shadow-sm">
          <h2 className="font-semibold">{t("customersAdmin.customerDetails")}</h2>
          <div className="space-y-1"><Label>{t("checkout.fullName")}</Label><Input disabled={!canWrite} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div className="space-y-1"><Label>{t("common.email")}</Label><Input type="email" disabled={!canWrite} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          <div className="space-y-1"><Label>{t("checkout.phone")}</Label><Input disabled={!canWrite} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
          <div className="space-y-1"><Label>{t("customersAdmin.internalNotes")}</Label><Textarea rows={3} disabled={!canWrite} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
          {canWrite && <Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />} {t("customersAdmin.saveChanges")}</Button>}
        </form>

        <div className="space-y-5 lg:col-span-2">
          <section className="rounded-2xl border bg-white p-5 shadow-sm">
            <h2 className="mb-3 font-semibold">{t("customersAdmin.purchaseHistory", { n: c.topItems.length })}</h2>
            {c.topItems.length === 0 ? <p className="text-sm text-muted-foreground">{t("customersAdmin.noPaidPurchases")}</p> : (
              <div className="grid gap-2 sm:grid-cols-2">
                {c.topItems.map((it) => (
                  <div key={it.medicineId} className="flex items-center justify-between rounded-xl border p-2.5 text-xs">
                    <span className="truncate font-medium">{it.nameEn}</span>
                    <span className="shrink-0 font-semibold">{it._sum.quantity} {t("customersAdmin.pcsShort")} · {money(it._sum.lineTotal ?? 0)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-2xl border bg-white p-5 shadow-sm">
            <h2 className="mb-3 font-semibold">{t("customersAdmin.savedAddresses", { n: c.addresses.length })}</h2>
            <div className="grid gap-2 sm:grid-cols-2 text-xs">
              {c.addresses.map((a) => (
                <div key={a.id} className="rounded-xl border p-3">
                  <div className="font-semibold">{a.label ?? a.fullName} · {formatKhPhone(a.phone)}</div>
                  <div className="text-muted-foreground">{[a.street, a.commune, a.district, a.province].filter(Boolean).join(", ")}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-2xl border bg-white p-5 shadow-sm">
            <h2 className="mb-3 font-semibold">{t("customersAdmin.ordersCount", { n: c.orders.length })}</h2>
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-2">{t("ordersAdmin.colOrderNo")}</th>
                  <th className="py-2">{t("common.date")}</th>
                  <th className="py-2">{t("common.status")}</th>
                  <th className="py-2">{t("ordersAdmin.colPayment")}</th>
                  <th className="py-2 text-right">{t("common.total")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {c.orders.map((o) => (
                  <tr key={o.id}>
                    <td className="py-2"><Link href={`/admin/orders/${o.id}`} className="font-mono text-primary hover:underline">{o.number}</Link></td>
                    <td className="py-2 text-xs">{formatDateTime(o.createdAt)}</td>
                    <td className="py-2"><StatusBadge status={o.status} /></td>
                    <td className="py-2"><StatusBadge status={o.paymentStatus} /></td>
                    <td className="py-2 text-right font-semibold">{money(o.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      </div>
    </div>
  );
}
