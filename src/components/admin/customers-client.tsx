"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/common/status-badge";
import { PageHeader, Pagination } from "./common";
import { formatDate } from "@/lib/date";
import { formatKhPhone } from "@/lib/phone";
import { useI18n } from "@/components/providers/i18n-provider";
import { api } from "@/lib/fetcher";

type CustRow = { id: string; spent: number; _count: { orders: number }; user: { name: string; email: string; phone: string | null; status: string; lastLoginAt: string | null; createdAt: string } };

export function CustomersClient() {
  const { money } = useI18n();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; pageSize: number; items: CustRow[] } | null>(null);

  const load = useCallback(() => {
    const sp = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (q) sp.set("q", q);
    if (status) sp.set("status", status);
    api<typeof data>(`/api/admin/customers?${sp}`).then(setData);
  }, [q, status, page]);
  useEffect(() => { const id = setTimeout(load, 200); return () => clearTimeout(id); }, [load]);

  return (
    <div className="space-y-4">
      <PageHeader title="Customer Management" subtitle="View registered customers, purchase history and manage account status" />
      <div className="flex flex-wrap gap-2 rounded-2xl border bg-white p-3 shadow-sm">
        <div className="relative min-w-56 flex-1"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search customer name, email or +855 phone…" className="pl-9" /></div>
        <select className="h-9 rounded-md border bg-white px-3 text-sm" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All accounts</option><option value="ACTIVE">Active</option><option value="SUSPENDED">Suspended</option>
        </select>
      </div>
      <div className="overflow-x-auto rounded-2xl border bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <tr><th className="p-3">Customer</th><th className="p-3">Phone</th><th className="p-3">Status</th><th className="p-3 text-right">Orders</th><th className="p-3 text-right">Total Spent</th><th className="p-3 text-right">Joined</th></tr>
          </thead>
          <tbody className="divide-y">
            {data?.items.map((c) => (
              <tr key={c.id} className="hover:bg-muted/30">
                <td className="p-3"><Link href={`/admin/customers/${c.id}`} className="font-medium text-primary hover:underline">{c.user.name}</Link><div className="text-xs text-muted-foreground">{c.user.email}</div></td>
                <td className="p-3 text-xs">{formatKhPhone(c.user.phone)}</td>
                <td className="p-3"><StatusBadge status={c.user.status} /></td>
                <td className="p-3 text-right">{c._count.orders}</td>
                <td className="p-3 text-right font-semibold">{money(c.spent)}</td>
                <td className="p-3 text-right text-xs text-muted-foreground">{formatDate(c.user.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && <Pagination page={page} pageSize={data.pageSize} total={data.total} onChange={setPage} />}
    </div>
  );
}
