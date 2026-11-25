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
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/fetcher";
import type { Permission, RoleKey } from "@/lib/auth/permissions";
import { cn } from "@/lib/utils";

type NavItem = { href: string; labelEn: string; labelKm: string; icon: React.ComponentType<{ className?: string }>; perm?: Permission; group: string };

const NAV: NavItem[] = [
  { href: "/admin", labelEn: "Dashboard", labelKm: "ផ្ទាំងសង្ខេប", icon: LayoutDashboard, perm: "dashboard.view", group: "main" },
  { href: "/admin/pos", labelEn: "Point of Sale (POS)", labelKm: "ប្រព័ន្ធលក់ POS", icon: MonitorSmartphone, perm: "pos.use", group: "main" },
  { href: "/admin/orders", labelEn: "Orders", labelKm: "ការបញ្ជាទិញ", icon: ShoppingBag, perm: "orders.read", group: "sales" },
  { href: "/admin/payments", labelEn: "Payments", labelKm: "ការទូទាត់", icon: CreditCard, perm: "payments.read", group: "sales" },
  { href: "/admin/customers", labelEn: "Customers", labelKm: "អតិថិជន", icon: Users, perm: "customers.read", group: "sales" },
  { href: "/admin/medicines", labelEn: "Medicines", labelKm: "ឱសថ និងផលិតផល", icon: Pill, perm: "medicines.read", group: "catalog" },
  { href: "/admin/categories", labelEn: "Categories & Brands", labelKm: "ប្រភេទ និងម៉ាក", icon: FolderTree, perm: "categories.write", group: "catalog" },
  { href: "/admin/inventory", labelEn: "Inventory", labelKm: "ស្តុកទំនិញ", icon: Boxes, perm: "inventory.read", group: "stock" },
  { href: "/admin/inventory/expiry", labelEn: "Expiration Watch", labelKm: "ការផុតកំណត់", icon: CalendarClock, perm: "inventory.read", group: "stock" },
  { href: "/admin/purchases", labelEn: "Purchases", labelKm: "ការបញ្ជាទិញចូល", icon: ClipboardList, perm: "purchases.read", group: "stock" },
  { href: "/admin/suppliers", labelEn: "Suppliers", labelKm: "អ្នកផ្គត់ផ្គង់", icon: Truck, perm: "suppliers.read", group: "stock" },
  { href: "/admin/marketing", labelEn: "Discounts & Banners", labelKm: "ការបញ្ចុះតម្លៃ", icon: Tag, perm: "discounts.write", group: "ops" },
  { href: "/admin/reports", labelEn: "Reports", labelKm: "របាយការណ៍", icon: BarChart3, perm: "reports.view", group: "ops" },
  { href: "/admin/staff", labelEn: "Staff & Roles", labelKm: "បុគ្គលិក និងតួនាទី", icon: Shield, perm: "users.manage", group: "sys" },
  { href: "/admin/settings", labelEn: "Settings", labelKm: "ការកំណត់", icon: Settings, perm: "settings.manage", group: "sys" },
  { href: "/admin/audit", labelEn: "Audit Logs", labelKm: "កំណត់ហេតុសកម្មភាព", icon: FileClock, perm: "audit.view", group: "sys" },
];

const GROUPS: Record<string, { en: string; km: string }> = {
  main: { en: "Overview", km: "ទូទៅ" },
  sales: { en: "Sales & Orders", km: "ការលក់ និងការបញ្ជាទិញ" },
  catalog: { en: "Catalogue", km: "បញ្ជីឱសថ" },
  stock: { en: "Inventory & Supply", km: "ស្តុក និងការផ្គត់ផ្គង់" },
  ops: { en: "Growth & Analytics", km: "ទីផ្សារ និងរបាយការណ៍" },
  sys: { en: "Administration", km: "ការគ្រប់គ្រងប្រព័ន្ធ" },
};

export type AdminUser = { id: string; name: string; email: string; role: RoleKey; permissions: Permission[] };

export function AdminShell({ user, children }: { user: AdminUser; children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);

  const visible = NAV.filter((n) => !n.perm || user.permissions.includes(n.perm) || (n.href === "/admin/settings" && user.permissions.includes("settings.payments")));
  const groups = Object.keys(GROUPS).filter((g) => visible.some((n) => n.group === g));

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
        <Logo href="/admin" light subtitle={locale === "km" ? "ផ្ទាំងគ្រប់គ្រង" : "Admin Console"} />
        <button className="lg:hidden text-white/80 hover:text-white" onClick={() => setOpen(false)} aria-label="Close"><X className="size-5" /></button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
        {groups.map((g) => (
          <div key={g}>
            <div className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-wider text-emerald-300/60">
              {locale === "km" ? GROUPS[g].km : GROUPS[g].en}
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
                    <span className="truncate">{locale === "km" ? n.labelKm : n.labelEn}</span>
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
          <Store className="size-4" /> {locale === "km" ? "បើកគេហទំព័រហាង" : "Open Storefront"}
        </Link>
        <div className="flex items-center justify-between rounded-xl bg-white/5 px-3 py-2">
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold">{user.name}</div>
            <div className="truncate text-[10px] text-emerald-300/80">{user.role.replace(/_/g, " ")}</div>
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
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setOpen(true)} aria-label="Menu"><Menu className="size-5" /></Button>
          <div className="hidden items-center gap-2 sm:flex">
            <Badge variant="secondary" className="font-mono text-[11px]">{user.role.replace(/_/g, " ")}</Badge>
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
