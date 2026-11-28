"use client";

import Link from "next/link";
import { Bell } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { api } from "@/lib/fetcher";
import { formatDateTime } from "@/lib/date";
import { useI18n } from "@/components/providers/i18n-provider";
import { localizeNotification } from "@/lib/i18n/translate";
import { safeInternalPath } from "@/lib/sanitize";
import { cn } from "@/lib/utils";

type N = { id: string; title: string; message: string; link: string | null; readAt: string | null; createdAt: string; type: string };

/** Polls notifications every 20s for near-real-time updates between admin and storefront. */
export function NotificationBell({ className }: { className?: string }) {
  const { t, tryT } = useI18n();
  const [data, setData] = useState<{ items: N[]; unread: number }>({ items: [], unread: 0 });
  const load = useCallback(() => api<{ items: N[]; unread: number }>("/api/account/notifications").then(setData).catch(() => {}), []);
  useEffect(() => {
    load();
    const id = setInterval(() => document.visibilityState === "visible" && load(), 20000);
    return () => clearInterval(id);
  }, [load]);
  async function markAll() {
    await api("/api/account/notifications", { method: "POST", body: {} }).catch(() => {});
    load();
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className={cn("relative rounded-full", className)} aria-label={t("account.notifications")}>
          <Bell className="size-5" />
          {data.unread > 0 && <span className="absolute right-1 top-1 flex min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">{data.unread > 9 ? "9+" : data.unread}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold">{t("account.notifications")}</span>
          {data.unread > 0 && <button onClick={markAll} className="text-xs text-primary hover:underline">{t("common.markAllRead")}</button>}
        </div>
        <div className="max-h-96 overflow-y-auto">
          {data.items.length === 0 && <div className="p-6 text-center text-sm text-muted-foreground">{t("common.noResults")}</div>}
          {data.items.map((n) => {
            const safeLink = safeInternalPath(n.link);
            const localized = localizeNotification(n, t, tryT);
            const body = (
              <div className={cn("border-b px-3 py-2.5 text-sm last:border-0 hover:bg-muted/50", !n.readAt && "bg-secondary/40")}>
                <div className="font-medium leading-snug">{localized.title}</div>
                <div className="line-clamp-2 text-xs text-muted-foreground">{localized.message}</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">{formatDateTime(n.createdAt)}</div>
              </div>
            );
            return safeLink ? (
              <Link key={n.id} href={safeLink} onClick={() => void api("/api/account/notifications", { method: "POST", body: { ids: [n.id] } }).then(load).catch(() => {})}>
                {body}
              </Link>
            ) : (
              <div key={n.id}>{body}</div>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
