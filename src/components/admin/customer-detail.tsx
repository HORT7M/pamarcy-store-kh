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
  const { money } = useI18n();
  const [c, setC] = useState<Detail | null>(null);
  const [form, setForm] = useState({ name: "", email: "", phone: "", notes: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<Detail>(`/api/admin/customers/${id}`).then((d) => {
      setC(d);
      setForm({ name: d.user.name, email: d.user.email, phone: d.user.phone ?? "", notes: d.notes ?? "" });
    });
  }, [id]);
  useEffect(load, [load]);

  if (!c) return <div className="py-20 text-center"><Loader2 className="mx-auto animate-spin" /></div>;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/api/admin/customers/${id}`, { method: "PATCH", body: { name: form.name, email: form.email, ...(form.phone ? { phone: form.phone } : {}), notes: form.notes } });
      toast.success("Customer updated"); load();
    } catch (err) { toast.error((err as Error).message); }
    finally { setBusy(false); }
  }

  async function toggleStatus() {
    if (!c) return;
    const next = c.user.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE";
    if (!confirm(`${next === "SUSPENDED" ? "Suspend" : "Reactivate"} ${c.user.name}?`)) return;
    setBusy(true);
    try {
      await api(`/api/admin/customers/${id}`, { method: "PATCH", body: { status: next } });
      toast.success(`Account ${next.toLowerCase()}`); load();
    } catch (err) { toast.error((err as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-5">
      <Link href="/admin/customers" className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"><ArrowLeft className="size-4" /> Back to customers</Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{c.user.name}</h1>
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span>Joined {formatDate(c.user.createdAt)}</span> · <span>Last login {formatDateTime(c.user.lastLoginAt)}</span>
            <StatusBadge status={c.user.status} />
          </div>
        </div>
        {canWrite && (
          <Button variant={c.user.status === "ACTIVE" ? "destructive" : "default"} onClick={toggleStatus} disabled={busy}>
            {c.user.status === "ACTIVE" ? <><Ban /> Suspend Account</> : <><CheckCircle2 /> Reactivate Account</>}
          </Button>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <form onSubmit={save} className="space-y-3 rounded-2xl border bg-white p-5 shadow-sm">
          <h2 className="font-semibold">Customer Details</h2>
          <div className="space-y-1"><Label>Full name</Label><Input disabled={!canWrite} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div className="space-y-1"><Label>Email</Label><Input type="email" disabled={!canWrite} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          <div className="space-y-1"><Label>Phone (+855)</Label><Input disabled={!canWrite} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
          <div className="space-y-1"><Label>Internal pharmacy notes</Label><Textarea rows={3} disabled={!canWrite} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
          {canWrite && <Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />} Save Changes</Button>}
        </form>

        <div className="space-y-5 lg:col-span-2">
          <section className="rounded-2xl border bg-white p-5 shadow-sm">
            <h2 className="mb-3 font-semibold">Purchase History ({c.topItems.length} top medicines)</h2>
            {c.topItems.length === 0 ? <p className="text-sm text-muted-foreground">No paid purchases yet.</p> : (
              <div className="grid gap-2 sm:grid-cols-2">
                {c.topItems.map((t) => (
                  <div key={t.medicineId} className="flex items-center justify-between rounded-xl border p-2.5 text-xs">
                    <span className="truncate font-medium">{t.nameEn}</span>
                    <span className="shrink-0 font-semibold">{t._sum.quantity} pcs · {money(t._sum.lineTotal ?? 0)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-2xl border bg-white p-5 shadow-sm">
            <h2 className="mb-3 font-semibold">Saved Addresses ({c.addresses.length})</h2>
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
            <h2 className="mb-3 font-semibold">Orders ({c.orders.length})</h2>
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs text-muted-foreground"><tr><th className="py-2">Order #</th><th className="py-2">Date</th><th className="py-2">Status</th><th className="py-2">Payment</th><th className="py-2 text-right">Total</th></tr></thead>
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
