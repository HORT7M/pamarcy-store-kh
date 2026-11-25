"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  LayoutDashboard, Pill, FolderTree, Boxes, CalendarClock, ShoppingBag, MonitorSmartphone,
  Users, Truck, ClipboardList, CreditCard, Tag, BarChart3, Settings, Shield, FileClock,
  LogOut, Store, Menu, X, ChevronRight,
} from "lucide-react";
import { Logo } from "@/components/common/logo";
import { LocaleSwitcher } from "@/components/common/locale-switcher";
import { NotificationBell } from "@/components/common/notification-bell";
import { useI18n } from "@/components/providers/i18n-provider";
import { localizeRoleName, type TKey } from "@/lib/i18n/translate";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/fetcher";
import type { Permission, RoleKey } from "@/lib/auth/permissions";
import { cn } from "@/lib/utils";

type GroupKey = "main" | "sales" | "catalog" | "stock" | "ops" | "sys";
type NavItem = { href: string; labelKey: TKey; icon: React.ComponentType<{ className?: string }>; perm?: Permission; group: GroupKey };

const NAV: NavItem[] = [
  { href: "/admin", labelKey: "adminNav.links.dashboard", icon: LayoutDashboard, perm: "dashboard.view", group: "main" },
  { href: "/admin/pos", labelKey: "adminNav.links.pos", icon: MonitorSmartphone, perm: "pos.use", group: "main" },
  { href: "/admin/orders", labelKey: "adminNav.links.orders", icon: ShoppingBag, perm: "orders.read", group: "sales" },
  { href: "/admin/payments", labelKey: "adminNav.links.payments", icon: CreditCard, perm: "payments.read", group: "sales" },
  { href: "/admin/customers", labelKey: "adminNav.links.customers", icon: Users, perm: "customers.read", group: "sales" },
  { href: "/admin/medicines", labelKey: "adminNav.links.medicines", icon: Pill, perm: "medicines.read", group: "catalog" },
  { href: "/admin/categories", labelKey: "adminNav.links.categories", icon: FolderTree, perm: "categories.write", group: "catalog" },
  { href: "/admin/inventory", labelKey: "adminNav.links.inventory", icon: Boxes, perm: "inventory.read", group: "stock" },
  { href: "/admin/inventory/expiry", labelKey: "adminNav.links.expiry", icon: CalendarClock, perm: "inventory.read", group: "stock" },
  { href: "/admin/purchases", labelKey: "adminNav.links.purchases", icon: ClipboardList, perm: "purchases.read", group: "stock" },
  { href: "/admin/suppliers", labelKey: "adminNav.links.suppliers", icon: Truck, perm: "suppliers.read", group: "stock" },
  { href: "/admin/marketing", labelKey: "adminNav.links.marketing", icon: Tag, perm: "discounts.write", group: "ops" },
  { href: "/admin/reports", labelKey: "adminNav.links.reports", icon: BarChart3, perm: "reports.view", group: "ops" },
  { href: "/admin/staff", labelKey: "adminNav.links.staff", icon: Shield, perm: "users.manage", group: "sys" },
  { href: "/admin/settings", labelKey: "adminNav.links.settings", icon: Settings, perm: "settings.manage", group: "sys" },
  { href: "/admin/audit", labelKey: "adminNav.links.audit", icon: FileClock, perm: "audit.view", group: "sys" },
];

const GROUP_ORDER: GroupKey[] = ["main", "sales", "catalog", "stock", "ops", "sys"];
const GROUP_KEYS: Record<GroupKey, TKey> = {
  main: "adminNav.groups.main",
  sales: "adminNav.groups.sales",
  catalog: "adminNav.groups.catalog",
  stock: "adminNav.groups.stock",
  ops: "adminNav.groups.ops",
  sys: "adminNav.groups.sys",
};

export type AdminUser = { id: string; name: string; email: string; role: RoleKey; permissions: Permission[] };

export function AdminShell({ user, children }: { user: AdminUser; children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { t, tryT } = useI18n();
  const [open, setOpen] = useState(false);

  const visible = NAV.filter((n) => !n.perm || user.permissions.includes(n.perm) || (n.href === "/admin/settings" && user.permissions.includes("settings.payments")));
  const groups = GROUP_ORDER.filter((g) => visible.some((n) => n.group === g));
  const roleLabel = localizeRoleName(user.role, user.role.replace(/_/g, " "), tryT);

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } finally {
      router.push("/admin/login");
      router.refresh();
    }
  }

  const sidebarContent = (
    <div className="flex h-full flex-col bg-[#0b2a1b] text-white">
      <div className="flex h-16 items-center justify-between border-b border-white/10 px-4">
        <Logo href="/admin" light subtitle={t("adminNav.consoleSubtitle")} />
        <button className="lg:hidden text-white/80 hover:text-white" onClick={() => setOpen(false)} aria-label={t("common.close")}><X className="size-5" /></button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
        {groups.map((g) => (
          <div key={g}>
            <div className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-wider text-emerald-300/60">
              {t(GROUP_KEYS[g])}
            </div>
            <div className="space-y-0.5">
              {visible.filter((n) => n.group === g).map((n) => {
                const active = n.href === "/admin"
                  ? path === "/admin"
                  : n.href === "/admin/inventory"
                    ? path === "/admin/inventory" || path.startsWith("/admin/inventory/movements")
                    : path.startsWith(n.href);
                return (
                  <Link
                    key={n.href}
                    href={n.href}
                    onClick={() => setOpen(false)}
                    className={cn(
                      "flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition",
                      active ? "bg-primary text-white shadow-sm" : "text-white/75 hover:bg-white/10 hover:text-white",
                    )}
                  >
                    <n.icon className="size-4 shrink-0" />
                    <span className="truncate">{t(n.labelKey)}</span>
                    {active && <ChevronRight className="ml-auto size-3.5 opacity-80" />}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="border-t border-white/10 p-3 space-y-2">
        <Link href="/" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-xl px-3 py-2 text-xs text-white/75 hover:bg-white/10 hover:text-white">
          <Store className="size-4" /> {t("adminNav.openStorefront")}
        </Link>
        <div className="flex items-center justify-between rounded-xl bg-white/5 px-3 py-2">
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold">{user.name}</div>
            <div className="truncate text-[10px] text-emerald-300/80">{roleLabel}</div>
          </div>
          <button onClick={logout} title={t("common.logout")} className="rounded-lg p-1.5 text-white/70 hover:bg-white/10 hover:text-white">
            <LogOut className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-[#f5f8f6]">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 lg:block">{sidebarContent}</aside>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] shadow-2xl">{sidebarContent}</div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-white/95 px-4 backdrop-blur lg:px-6">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setOpen(true)} aria-label={t("common.menu")}><Menu className="size-5" /></Button>
          <div className="hidden items-center gap-2 sm:flex">
            <Badge variant="secondary" className="text-[11px]">{roleLabel}</Badge>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <LocaleSwitcher compact />
            <NotificationBell />
            <Button variant="outline" size="sm" onClick={logout} className="hidden sm:inline-flex"><LogOut className="size-4" /> {t("common.logout")}</Button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1440px] flex-1 p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
