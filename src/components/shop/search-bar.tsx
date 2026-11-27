"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { useState } from "react";
import { useI18n } from "@/components/providers/i18n-provider";
import { cn } from "@/lib/utils";

export function SearchBar({ className, large }: { className?: string; large?: boolean }) {
  const router = useRouter();
  const sp = useSearchParams();
  const { t } = useI18n();
  const [q, setQ] = useState(sp.get("q") ?? "");
  return (
    <form
      role="search"
      className={cn(
        "flex w-full items-center gap-1.5 rounded-full border bg-muted/40 pl-3.5 pr-1 transition focus-within:border-primary focus-within:bg-white focus-within:ring-4 focus-within:ring-primary/10",
        large ? "h-13" : "h-10",
        className,
      )}
      onSubmit={(e) => {
        e.preventDefault();
        router.push(`/shop${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`);
      }}
    >
      <Search className="size-4 shrink-0 text-muted-foreground" />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t("common.searchPlaceholder")}
        aria-label={t("common.search")}
        className={cn("min-w-0 flex-1 bg-transparent outline-none", large ? "text-base" : "text-sm")}
        maxLength={100}
      />
      <button
        type="submit"
        className={cn(
          "shrink-0 whitespace-nowrap rounded-full bg-primary px-3.5 font-medium text-white transition hover:bg-primary/90 sm:px-4",
          large ? "h-11 text-sm sm:text-base" : "h-8 text-xs sm:text-sm",
        )}
      >
        {t("common.search")}
      </button>
    </form>
  );
}
