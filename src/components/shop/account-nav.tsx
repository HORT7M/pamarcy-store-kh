"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Package, MapPin, Heart, CreditCard, UserCog, ShoppingCart } from "lucide-react";
import { useI18n } from "@/components/providers/i18n-provider";
import { cn } from "@/lib/utils";

export function AccountNav({ name }: { name: string }) {
  const { t } = useI18n();
  const path = usePathname();
  const items = [
    { href: "/account", icon: LayoutDashboard, label: t("account.title") },
    { href: "/account/orders", icon: Package, label: t("account.orders") },
    { href: "/account/payments", icon: CreditCard, label: t("account.payments") },
    { href: "/account/addresses", icon: MapPin, label: t("account.addresses") },
    { href: "/account/wishlist", icon: Heart, label: t("account.wishlist") },
    { href: "/cart", icon: ShoppingCart, label: t("common.cart") },
    { href: "/account/profile", icon: UserCog, label: `${t("account.profile")} / ${t("account.password")}` },
  ];
  return (
    <aside className="h-fit rounded-2xl border bg-white p-3 shadow-sm">
      <div className="mb-2 border-b px-3 pb-3 pt-1">
        <div className="text-xs text-muted-foreground">{t("account.title")}</div>
        <div className="truncate font-semibold">{name}</div>
      </div>
      <nav className="flex gap-1 overflow-x-auto lg:flex-col">
        {items.map((i) => {
          const active = i.href === "/account" ? path === "/account" : path.startsWith(i.href);
          return (
            <Link key={i.href} href={i.href} className={cn("flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition", active ? "bg-secondary font-medium text-secondary-foreground" : "text-muted-foreground hover:bg-muted")}>
              <i.icon className="size-4" />{i.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
