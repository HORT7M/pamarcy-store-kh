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
      className={cn("relative flex w-full items-center", className)}
      onSubmit={(e) => {
        e.preventDefault();
        router.push(`/shop${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`);
      }}
    >
      <Search className="pointer-events-none absolute left-3.5 size-4 text-muted-foreground" />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t("common.searchPlaceholder")}
        aria-label={t("common.search")}
        className={cn("w-full rounded-full border bg-muted/40 pl-10 pr-24 outline-none transition focus:border-primary focus:bg-white focus:ring-4 focus:ring-primary/10", large ? "h-13 text-base" : "h-10 text-sm")}
        maxLength={100}
      />
      <button type="submit" className={cn("absolute right-1 rounded-full bg-primary px-4 font-medium text-white hover:bg-primary/90", large ? "h-11" : "h-8 text-sm")}>{t("common.search")}</button>
    </form>
  );
}
