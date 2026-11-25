"use client";

import { Globe, Coins } from "lucide-react";
import { useI18n } from "@/components/providers/i18n-provider";
import { cn } from "@/lib/utils";

export function LocaleSwitcher({ className, compact }: { className?: string; compact?: boolean }) {
  const { locale, setLocale, currency, setCurrency } = useI18n();
  return (
    <div className={cn("flex items-center gap-2 text-xs", className)}>
      <div className="flex items-center rounded-full border bg-white p-0.5" role="group" aria-label="Language">
        {!compact && <Globe className="ml-1.5 size-3.5 text-muted-foreground" />}
        {(["km", "en"] as const).map((l) => (
          <button key={l} onClick={() => setLocale(l)} className={cn("rounded-full px-2.5 py-1 font-medium transition", locale === l ? "bg-primary text-white" : "text-muted-foreground hover:text-foreground")} aria-pressed={locale === l}>
            {l === "km" ? "ខ្មែរ" : "EN"}
          </button>
        ))}
      </div>
      <div className="flex items-center rounded-full border bg-white p-0.5" role="group" aria-label="Currency">
        {!compact && <Coins className="ml-1.5 size-3.5 text-muted-foreground" />}
        {(["USD", "KHR"] as const).map((c) => (
          <button key={c} onClick={() => setCurrency(c)} className={cn("rounded-full px-2.5 py-1 font-medium transition", currency === c ? "bg-brand-blue text-white" : "text-muted-foreground hover:text-foreground")} aria-pressed={currency === c}>
            {c === "USD" ? "$" : "៛"}
          </button>
        ))}
      </div>
    </div>
  );
}
