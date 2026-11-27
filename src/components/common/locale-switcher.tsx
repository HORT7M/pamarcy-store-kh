"use client";

import { Check, ChevronDown, Coins, Globe } from "lucide-react";
import { useI18n } from "@/components/providers/i18n-provider";
import { LOCALES, LOCALE_META } from "@/lib/i18n/dictionaries";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export function LocaleSwitcher({
  className,
  compact,
  hideCurrency,
}: {
  className?: string;
  compact?: boolean;
  hideCurrency?: boolean;
}) {
  const { locale, setLocale, currency, setCurrency, t } = useI18n();
  const current = LOCALE_META[locale] ?? LOCALE_META.km;

  return (
    <div className={cn("flex items-center gap-1.5 sm:gap-2 text-xs", className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t("common.language")}
            data-testid="language-switcher"
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border bg-white font-medium text-foreground shadow-2xs transition hover:border-primary/40 hover:bg-secondary/40 focus:outline-none focus:ring-2 focus:ring-ring/40",
              compact ? "px-2.5 py-1" : "px-3 py-1.5",
            )}
          >
            <Globe className="size-3.5 shrink-0 text-primary" />
            <span className="whitespace-nowrap">{compact ? current.short : current.nativeName}</span>
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[11.5rem] p-1">
          {LOCALES.map((code) => {
            const meta = LOCALE_META[code];
            const active = locale === code;
            return (
              <DropdownMenuItem
                key={code}
                data-locale={code}
                onSelect={() => setLocale(code)}
                className={cn(
                  "flex cursor-pointer items-center justify-between gap-3 rounded-md px-2.5 py-2 text-xs",
                  active && "bg-secondary/70 font-semibold text-secondary-foreground",
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="inline-flex w-9 shrink-0 items-center justify-center rounded bg-muted px-1 py-0.5 text-[10px] font-semibold text-muted-foreground">
                    {meta.short}
                  </span>
                  <span className="truncate">{meta.nativeName}</span>
                </div>
                {active && <Check className="size-3.5 shrink-0 text-primary" />}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {!hideCurrency && (
        <div className="flex items-center rounded-full border bg-white p-0.5" role="group" aria-label={t("common.currency")}>
          {!compact && <Coins className="ml-1.5 mr-1 size-3.5 shrink-0 text-muted-foreground" />}
          {(["USD", "KHR"] as const).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCurrency(c)}
              className={cn(
                "rounded-full px-2.5 py-1 font-medium transition",
                currency === c ? "bg-brand-blue text-white" : "text-muted-foreground hover:text-foreground",
              )}
              aria-pressed={currency === c}
            >
              {c === "USD" ? "$" : "៛"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
