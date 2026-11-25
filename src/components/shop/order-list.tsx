"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { useI18n } from "@/components/providers/i18n-provider";
import { StatusBadge } from "@/components/common/status-badge";
import { formatDate } from "@/lib/date";

export type OrderRow = { id: string; number: string; createdAt: string; total: string; status: string; paymentStatus: string; itemCount: number; firstItems: { nameEn: string; nameKm: string }[] };

export function OrderList({ orders }: { orders: OrderRow[] }) {
  const { t, money, pick } = useI18n();
  return (
    <div className="space-y-3">
      {orders.map((o) => (
        <Link key={o.id} href={`/account/orders/${o.id}`} className="flex items-center gap-4 rounded-2xl border bg-white p-4 shadow-sm transition hover:border-primary/50">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-sm font-semibold">{o.number}</span><StatusBadge status={o.status} /><StatusBadge status={o.paymentStatus} /></div>
            <div className="truncate text-sm text-muted-foreground">{o.firstItems.map((i) => pick(i, "name")).join(", ")}{o.itemCount > o.firstItems.length ? ` +${o.itemCount - o.firstItems.length}` : ""}</div>
            <div className="text-xs text-muted-foreground">{formatDate(o.createdAt)}</div>
          </div>
          <div className="text-right"><div className="font-semibold">{money(o.total)}</div><div className="text-xs text-muted-foreground">{t("common.details")}</div></div>
          <ChevronRight className="size-5 text-muted-foreground" />
        </Link>
      ))}
    </div>
  );
}
