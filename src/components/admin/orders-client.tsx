"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Search, FileWarning } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/common/status-badge";
import { PageHeader, Pagination } from "./common";
import { useI18n } from "@/components/providers/i18n-provider";
import { formatDateTime } from "@/lib/date";
import { formatKhPhone } from "@/lib/phone";
import { api } from "@/lib/fetcher";

type OrderRow = {
  id: string; number: string; channel: string; fullName: string; phone: string; total: string; status: string;
  paymentStatus: string; fulfillmentStatus: string; prescriptionStatus: string; createdAt: string;
  _count: { items: number }; payments: { method: { code: string }; status: string }[];
};

const STATUSES = ["", "PENDING", "CONFIRMED", "PROCESSING", "READY_FOR_DELIVERY", "SHIPPING", "DELIVERED", "CANCELLED"];

export function OrdersClient() {
  const { money } = useI18n();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [channel, setChannel] = useState("");
  const [payment, setPayment] = useState("");
  const [rxOnly, setRxOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; pageSize: number; items: OrderRow[]; counts: Record<string, number> } | null>(null);

  const load = useCallback(() => {
    const sp = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (q) sp.set("q", q);
    if (status) sp.set("status", status);
    if (channel) sp.set("channel", channel);
    if (payment) sp.set("payment", payment);
    if (rxOnly) sp.set("rx", "pending");
    api<typeof data>(`/api/admin/orders?${sp}`).then(setData);
  }, [q, status, channel, payment, rxOnly, page]);
  useEffect(() => { const id = setTimeout(load, 200); return () => clearTimeout(id); }, [load]);

  const sel = "h-9 rounded-md border bg-white px-3 text-sm";

  return (
    <div className="space-y-4">
      <PageHeader title="Order Management" subtitle="Track online and POS orders, review prescriptions, fulfil stock and issue refunds" />

      <div className="flex flex-wrap gap-1.5">
        {STATUSES.map((s) => (
          <Button key={s || "all"} size="sm" variant={status === s ? "default" : "outline"} onClick={() => { setStatus(s); setPage(1); }}>
            {s ? s.replace(/_/g, " ") : "All"}
            {s && data?.counts[s] ? <span className="ml-1 rounded-full bg-black/10 px-1.5 text-[10px]">{data.counts[s]}</span> : null}
          </Button>
        ))}
        <Button size="sm" variant={rxOnly ? "destructive" : "outline"} onClick={() => { setRxOnly((r) => !r); setPage(1); }}>
          <FileWarning className="size-3.5" /> Rx Pending Review
        </Button>
      </div>

      <div className="flex flex-wrap gap-2 rounded-2xl border bg-white p-3 shadow-sm">
        <div className="relative min-w-56 flex-1"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search order #, customer name, phone, email…" className="pl-9" /></div>
        <select className={sel} value={channel} onChange={(e) => { setChannel(e.target.value); setPage(1); }}><option value="">All channels</option><option value="ONLINE">Online</option><option value="POS">POS</option></select>
        <select className={sel} value={payment} onChange={(e) => { setPayment(e.target.value); setPage(1); }}><option value="">All payments</option>{["PENDING", "PROCESSING", "PAID", "FAILED", "EXPIRED", "REFUNDED"].map((p) => <option key={p} value={p}>{p}</option>)}</select>
      </div>

      <div className="overflow-x-auto rounded-2xl border bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <tr><th className="p-3">Order #</th><th className="p-3">Customer</th><th className="p-3">Channel</th><th className="p-3">Order Status</th><th className="p-3">Payment</th><th className="p-3">Fulfilment</th><th className="p-3 text-right">Total</th><th className="p-3 text-right">Created</th></tr>
          </thead>
          <tbody className="divide-y">
            {data?.items.map((o) => (
              <tr key={o.id} className="hover:bg-muted/30">
                <td className="p-3">
                  <Link href={`/admin/orders/${o.id}`} className="font-mono font-semibold text-primary hover:underline">{o.number}</Link>
                  <div className="text-[11px] text-muted-foreground">{o._count.items} item(s){o.prescriptionStatus === "PENDING_REVIEW" && <Badge className="ml-1 bg-amber-500 text-[10px] text-white">Rx</Badge>}</div>
                </td>
                <td className="p-3"><div className="font-medium">{o.fullName}</div><div className="text-xs text-muted-foreground">{formatKhPhone(o.phone)}</div></td>
                <td className="p-3 text-xs"><Badge variant="secondary">{o.channel}</Badge></td>
                <td className="p-3"><StatusBadge status={o.status} /></td>
                <td className="p-3"><div className="flex items-center gap-1"><StatusBadge status={o.paymentStatus} />{o.payments[0] && <span className="text-[11px] text-muted-foreground">{o.payments[0].method.code}</span>}</div></td>
                <td className="p-3"><StatusBadge status={o.fulfillmentStatus} /></td>
                <td className="p-3 text-right font-semibold">{money(o.total)}</td>
                <td className="whitespace-nowrap p-3 text-right text-xs text-muted-foreground">{formatDateTime(o.createdAt)}</td>
              </tr>
            ))}
            {data && data.items.length === 0 && <tr><td colSpan={8} className="p-8 text-center text-muted-foreground">No orders found.</td></tr>}
          </tbody>
        </table>
      </div>
      {data && <Pagination page={page} pageSize={data.pageSize} total={data.total} onChange={setPage} />}
    </div>
  );
}
