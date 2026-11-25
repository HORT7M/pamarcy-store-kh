"use client";

import { useI18n } from "@/components/providers/i18n-provider";
import { cn } from "@/lib/utils";

export function Price({ usd, compareAt, className, showSecondary = true, size = "md" }: { usd: number; compareAt?: number | null; className?: string; showSecondary?: boolean; size?: "sm" | "md" | "lg" }) {
  const { dual, money } = useI18n();
  const d = dual(usd);
  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex items-baseline gap-2">
        <span className={cn("font-bold text-primary", size === "lg" ? "text-3xl" : size === "sm" ? "text-base" : "text-lg")}>{d.primary}</span>
        {compareAt && compareAt > usd && <span className="text-sm text-muted-foreground line-through">{money(compareAt)}</span>}
      </div>
      {showSecondary && <span className="text-xs text-muted-foreground">≈ {d.secondary}</span>}
    </div>
  );
}

export function Money({ usd, className }: { usd: number | string; className?: string }) {
  const { money } = useI18n();
  return <span className={className}>{money(Number(usd))}</span>;
}
