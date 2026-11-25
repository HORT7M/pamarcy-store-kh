"use client";

import { useCallback, useEffect, useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageHeader, Pagination } from "./common";
import { formatDateTime } from "@/lib/date";
import { api } from "@/lib/fetcher";

type LogRow = { id: string; action: string; entity: string; entityId: string | null; meta: unknown; ip: string | null; createdAt: string; user: { name: string } | null };

export function AuditClient() {
  const [q, setQ] = useState("");
  const [entity, setEntity] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; pageSize: number; items: LogRow[] } | null>(null);

  const load = useCallback(() => {
    const sp = new URLSearchParams({ page: String(page), pageSize: "30" });
    if (q) sp.set("q", q);
    if (entity) sp.set("entity", entity);
    api<typeof data>(`/api/admin/audit?${sp}`).then(setData);
  }, [q, entity, page]);
  useEffect(() => { const id = setTimeout(load, 200); return () => clearTimeout(id); }, [load]);

  return (
    <div className="space-y-4">
      <PageHeader title="Audit Logs" subtitle="Immutable trail of administrative actions, stock changes, payment updates and logins" />
      <div className="flex flex-wrap gap-2 rounded-2xl border bg-white p-3 shadow-sm">
        <div className="relative min-w-56 flex-1"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search action, staff name or entity ID…" className="pl-9" /></div>
        <select className="h-9 rounded-md border bg-white px-3 text-sm" value={entity} onChange={(e) => { setEntity(e.target.value); setPage(1); }}>
          <option value="">All entities</option>
          {["User", "Medicine", "MedicineBatch", "Category", "Brand", "Supplier", "Purchase", "Order", "Payment", "PaymentMethod", "Discount", "Banner", "Customer", "SystemSetting", "Report", "Upload", "BotProtection"].map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
      </div>
      <div className="overflow-x-auto rounded-2xl border bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <tr><th className="p-3">Time</th><th className="p-3">Actor</th><th className="p-3">Action</th><th className="p-3">Entity</th><th className="p-3">Details</th><th className="p-3">IP</th></tr>
          </thead>
          <tbody className="divide-y">
            {data?.items.map((l) => (
              <tr key={l.id}>
                <td className="whitespace-nowrap p-3 text-xs">{formatDateTime(l.createdAt)}</td>
                <td className="p-3 text-xs font-medium">{l.user?.name ?? "System"}</td>
                <td className="p-3"><Badge variant="outline" className="font-mono text-[11px]">{l.action}</Badge></td>
                <td className="p-3 text-xs">{l.entity}{l.entityId ? <span className="ml-1 font-mono text-muted-foreground">#{l.entityId.slice(-6)}</span> : ""}</td>
                <td className="max-w-md truncate p-3 font-mono text-[11px] text-muted-foreground" title={l.meta ? JSON.stringify(l.meta) : ""}>{l.meta ? JSON.stringify(l.meta) : "—"}</td>
                <td className="p-3 font-mono text-xs text-muted-foreground">{l.ip ?? "—"}</td>
              </tr>
            ))}
            {data && data.items.length === 0 && <tr><td colSpan={6} className="p-8 text-center text-muted-foreground">No audit entries yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {data && <Pagination page={page} pageSize={data.pageSize} total={data.total} onChange={setPage} />}
    </div>
  );
}
