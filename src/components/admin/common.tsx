"use client";

import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/providers/i18n-provider";
import { cn } from "@/lib/utils";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatCard({ label, value, sub, icon: Icon, tone = "green" }: { label: string; value: string | number; sub?: string; icon: LucideIcon; tone?: "green" | "blue" | "amber" | "red" | "slate" }) {
  const tones = {
    green: "bg-secondary text-primary",
    blue: "bg-accent text-brand-blue",
    amber: "bg-amber-50 text-amber-600",
    red: "bg-red-50 text-red-600",
    slate: "bg-slate-100 text-slate-700",
  };
  return (
    <div className="rounded-2xl border bg-white p-3.5 shadow-sm sm:p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium text-muted-foreground">{label}</div>
          <div className="mt-1 truncate text-lg font-bold tracking-tight sm:text-2xl">{value}</div>
          {sub && <div className="mt-0.5 truncate text-xs text-muted-foreground">{sub}</div>}
        </div>
        <div className={cn("rounded-xl p-2 shrink-0 sm:p-2.5", tones[tone])}><Icon className="size-4 sm:size-5" /></div>
      </div>
    </div>
  );
}

export function Pagination({ page, pageSize, total, onChange }: { page: number; pageSize: number; total: number; onChange: (p: number) => void }) {
  const { t } = useI18n();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const from = Math.min((page - 1) * pageSize + 1, total);
  const to = Math.min(page * pageSize, total);
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{t("common.showingRange", { from, to, total })}</span>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => onChange(page - 1)}>{t("common.prev")}</Button>
        <span>{page} / {pages}</span>
        <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => onChange(page + 1)}>{t("common.next")}</Button>
      </div>
    </div>
  );
}
