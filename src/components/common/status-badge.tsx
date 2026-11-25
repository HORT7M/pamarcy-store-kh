"use client";

import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/components/providers/i18n-provider";
import { cn } from "@/lib/utils";

const COLORS: Record<string, string> = {
  PENDING: "bg-amber-50 text-amber-700 border-amber-200",
  PENDING_REVIEW: "bg-amber-50 text-amber-700 border-amber-200",
  CONFIRMED: "bg-blue-50 text-blue-700 border-blue-200",
  PROCESSING: "bg-indigo-50 text-indigo-700 border-indigo-200",
  READY_FOR_DELIVERY: "bg-cyan-50 text-cyan-700 border-cyan-200",
  SHIPPING: "bg-sky-50 text-sky-700 border-sky-200",
  DELIVERED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  PAID: "bg-emerald-50 text-emerald-700 border-emerald-200",
  APPROVED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  FULFILLED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  PARTIAL: "bg-orange-50 text-orange-700 border-orange-200",
  UNFULFILLED: "bg-slate-50 text-slate-600 border-slate-200",
  CANCELLED: "bg-slate-100 text-slate-600 border-slate-200",
  FAILED: "bg-red-50 text-red-700 border-red-200",
  REJECTED: "bg-red-50 text-red-700 border-red-200",
  EXPIRED: "bg-slate-100 text-slate-600 border-slate-200",
  REFUNDED: "bg-purple-50 text-purple-700 border-purple-200",
  NOT_REQUIRED: "bg-slate-50 text-slate-500 border-slate-200",
  ACTIVE: "bg-emerald-50 text-emerald-700 border-emerald-200",
  SUSPENDED: "bg-red-50 text-red-700 border-red-200",
  ORDERED: "bg-blue-50 text-blue-700 border-blue-200",
  PARTIALLY_RECEIVED: "bg-orange-50 text-orange-700 border-orange-200",
  RECEIVED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  DRAFT: "bg-slate-50 text-slate-600 border-slate-200",
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const { tryT } = useI18n();
  const fallback = status.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
  const label = tryT(`status.${status}`, fallback);
  return (
    <Badge variant="outline" className={cn("font-medium whitespace-nowrap", COLORS[status] ?? "", className)}>
      {label}
    </Badge>
  );
}
