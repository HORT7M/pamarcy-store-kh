"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Pencil, Shield, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { StatusBadge } from "@/components/common/status-badge";
import { PageHeader } from "./common";
import { ROLES, type RoleKey } from "@/lib/auth/permissions";
import { formatDateTime } from "@/lib/date";
import { formatKhPhone } from "@/lib/phone";
import { api } from "@/lib/fetcher";

type StaffRow = {
  id: string; name: string; email: string; phone: string | null; status: "ACTIVE" | "SUSPENDED"; lastLoginAt: string | null;
  role: { key: RoleKey; name: string }; employee: { employeeCode: string; position: string | null; licenseNo: string | null } | null;
};

const STAFF_ROLES: RoleKey[] = ["SUPER_ADMIN", "ADMIN", "PHARMACIST", "CASHIER", "INVENTORY_STAFF"];

export function StaffClient({ currentUserId }: { currentUserId: string }) {
  const [items, setItems] = useState<StaffRow[]>([]);
  const [modal, setModal] = useState<StaffRow | "new" | null>(null);
  const [form, setForm] = useState({ name: "", email: "", phone: "", role: "PHARMACIST" as RoleKey, position: "", licenseNo: "", password: "", status: "ACTIVE" as "ACTIVE" | "SUSPENDED" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => { api<{ items: StaffRow[] }>("/api/admin/staff").then((r) => setItems(r.items)); }, []);
  useEffect(load, [load]);

  function open(s?: StaffRow) {
    setModal(s ?? "new");
    setForm(s ? { name: s.name, email: s.email, phone: s.phone ?? "", role: s.role.key, position: s.employee?.position ?? "", licenseNo: s.employee?.licenseNo ?? "", password: "", status: s.status } : { name: "", email: "", phone: "", role: "PHARMACIST", position: "", licenseNo: "", password: "", status: "ACTIVE" });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { ...form, password: form.password || undefined };
      if (modal === "new") await api("/api/admin/staff", { method: "POST", body });
      else if (modal) await api(`/api/admin/staff/${modal.id}`, { method: "PUT", body });
      toast.success("Staff saved"); setModal(null); load();
    } catch (err) { toast.error((err as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Staff & Role Permissions" subtitle="Role-based access control enforced on every backend endpoint" actions={<Button onClick={() => open()}><Plus /> Add Staff Account</Button>} />

      <div className="overflow-x-auto rounded-2xl border bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <tr><th className="p-3">Employee</th><th className="p-3">Role</th><th className="p-3">Position / Licence</th><th className="p-3">Status</th><th className="p-3">Last Login</th><th className="p-3 text-right">Edit</th></tr>
          </thead>
          <tbody className="divide-y">
            {items.map((s) => (
              <tr key={s.id}>
                <td className="p-3"><div className="font-medium">{s.name} {s.id === currentUserId && <Badge variant="secondary" className="ml-1 text-[10px]">You</Badge>}</div><div className="text-xs text-muted-foreground">{s.email} · {formatKhPhone(s.phone)}</div></td>
                <td className="p-3"><Badge variant="outline" className="font-mono text-xs">{s.role.name}</Badge></td>
                <td className="p-3 text-xs"><div>{s.employee?.position ?? "—"} <span className="font-mono text-muted-foreground">({s.employee?.employeeCode})</span></div>{s.employee?.licenseNo && <div className="text-primary">Licence: {s.employee.licenseNo}</div>}</td>
                <td className="p-3"><StatusBadge status={s.status} /></td>
                <td className="p-3 text-xs text-muted-foreground">{formatDateTime(s.lastLoginAt)}</td>
                <td className="p-3 text-right"><Button size="icon" variant="ghost" onClick={() => open(s)}><Pencil className="size-4" /></Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="rounded-2xl border bg-white p-5 shadow-sm">
        <h2 className="mb-3 flex items-center gap-2 font-semibold"><Shield className="size-4 text-primary" /> Role Permissions Reference</h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {STAFF_ROLES.map((rk) => (
            <div key={rk} className="rounded-xl border p-3.5 text-xs">
              <div className="mb-2 font-bold">{ROLES[rk].name}</div>
              <div className="flex flex-wrap gap-1">
                {ROLES[rk].permissions.map((p) => <span key={p} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{p}</span>)}
              </div>
            </div>
          ))}
        </div>
      </section>

      <Dialog open={!!modal} onOpenChange={(o) => !o && setModal(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{modal === "new" ? "Create Staff Account" : "Edit Staff Account"}</DialogTitle></DialogHeader>
          <form onSubmit={save} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label>Full name *</Label><Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
              <div className="space-y-1"><Label>Email *</Label><Input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
              <div className="space-y-1"><Label>Phone (+855)</Label><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
              <div className="space-y-1">
                <Label>Role *</Label>
                <select className="h-9 w-full rounded-md border bg-white px-3 text-sm" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as RoleKey })}>
                  {STAFF_ROLES.map((r) => <option key={r} value={r}>{ROLES[r].name}</option>)}
                </select>
              </div>
              <div className="space-y-1"><Label>Position</Label><Input value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} placeholder="Pharmacist, Cashier…" /></div>
              <div className="space-y-1"><Label>Pharmacist Licence #</Label><Input value={form.licenseNo} onChange={(e) => setForm({ ...form, licenseNo: e.target.value })} /></div>
              <div className="space-y-1">
                <Label>{modal === "new" ? "Password *" : "Reset password (optional)"}</Label>
                <Input type="password" required={modal === "new"} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Min 8 chars, letters + numbers" />
              </div>
              {modal !== "new" && (
                <div className="space-y-1">
                  <Label>Account Status</Label>
                  <select className="h-9 w-full rounded-md border bg-white px-3 text-sm" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as "ACTIVE" | "SUSPENDED" })}>
                    <option value="ACTIVE">Active</option><option value="SUSPENDED">Suspended</option>
                  </select>
                </div>
              )}
            </div>
            <DialogFooter><Button type="button" variant="outline" onClick={() => setModal(null)}>Cancel</Button><Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />} Save</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
