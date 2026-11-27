"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Menu, ShoppingCart, User, Phone, LogOut, LayoutDashboard, Heart, Package, X } from "lucide-react";
import { Logo } from "@/components/common/logo";
import { LocaleSwitcher } from "@/components/common/locale-switcher";
import { SearchBar } from "./search-bar";
import { useCart } from "@/components/providers/cart-provider";
import { useI18n } from "@/components/providers/i18n-provider";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/fetcher";
import { cn } from "@/lib/utils";
import { safeTelHref } from "@/lib/sanitize";
import { NotificationBell } from "@/components/common/notification-bell";

type Cat = { slug: string; nameEn: string; nameKm: string };
type HeaderUser = { name: string; isStaff: boolean } | null;

export function ShopHeader({ categories, user, phone }: { categories: Cat[]; user: HeaderUser; phone: string }) {
  const { count, ready } = useCart();
  const { t, catName } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const telHref = safeTelHref(phone);

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } finally {
      router.push("/");
      router.refresh();
    }
  }

  const nav = [
    { href: "/shop", label: t("common.shop") },
    { href: "/shop?sort=popular", label: t("nav.bestSellers") },
    { href: "/shop?sort=newest", label: t("nav.newArrivals") },
    { href: "/shop?offers=1", label: t("nav.offers") },
    { href: "/shop?category=prescription-medicines", label: t("nav.prescription") },
  ];

  return (
    <>
      <header className="sticky top-0 z-40 border-b bg-white/95 backdrop-blur">
        <div className="hidden bg-primary text-primary-foreground md:block">
          <div className="mx-auto flex h-9 max-w-7xl items-center justify-between px-4 text-xs">
            {telHref ? <a href={telHref} className="flex items-center gap-1.5 hover:underline"><Phone className="size-3.5" /> {phone}</a> : <span className="flex items-center gap-1.5"><Phone className="size-3.5" /> {phone}</span>}
            <span className="opacity-90">{t("common.tagline")}</span>
            <LocaleSwitcher compact className="[&_button]:py-0.5" />
          </div>
        </div>
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-2 sm:gap-4 px-4">
          <button className="md:hidden shrink-0" onClick={() => setOpen(true)} aria-label={t("common.menu")}><Menu className="size-6" /></button>
          <Logo subtitle={t("common.tagline")} className="[&>span>span:last-child]:hidden lg:[&>span>span:last-child]:block" />
          <div className="mx-2 hidden min-w-0 flex-1 md:block lg:mx-4"><Suspense><SearchBar /></Suspense></div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <LocaleSwitcher compact hideCurrency className="md:hidden" />
            {user && <NotificationBell />}
            {user ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="gap-2 rounded-full px-2 sm:px-3"><User className="size-5" /><span className="hidden max-w-28 truncate lg:inline">{user.name}</span></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuLabel className="truncate">{user.name}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {user.isStaff && <DropdownMenuItem asChild><Link href="/admin"><LayoutDashboard /> {t("common.adminPanel")}</Link></DropdownMenuItem>}
                  {!user.isStaff && <>
                    <DropdownMenuItem asChild><Link href="/account"><User /> {t("common.account")}</Link></DropdownMenuItem>
                    <DropdownMenuItem asChild><Link href="/account/orders"><Package /> {t("account.orders")}</Link></DropdownMenuItem>
                    <DropdownMenuItem asChild><Link href="/account/wishlist"><Heart /> {t("account.wishlist")}</Link></DropdownMenuItem>
                  </>}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={logout}><LogOut /> {t("common.logout")}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button asChild variant="ghost" className="rounded-full px-2 sm:px-3"><Link href="/login"><User className="size-5" /><span className="hidden sm:inline">{t("common.login")}</span></Link></Button>
            )}
            <Button asChild variant="ghost" className="relative rounded-full px-2 sm:px-3" aria-label={t("common.cart")}>
              <Link href="/cart">
                <ShoppingCart className="size-5" />
                <span className="hidden sm:inline">{t("common.cart")}</span>
                {ready && count > 0 && <span className="absolute -right-0.5 -top-0.5 flex size-5 items-center justify-center rounded-full bg-brand-blue text-[10px] font-bold text-white">{count > 99 ? "99+" : count}</span>}
              </Link>
            </Button>
          </div>
        </div>
        <div className="px-4 pb-3 md:hidden"><Suspense><SearchBar /></Suspense></div>
        <nav className="hidden border-t md:block">
          <div className="mx-auto flex h-11 max-w-7xl items-center gap-1 overflow-x-auto px-4 text-sm">
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button size="sm" className="mr-2 shrink-0 rounded-full"><Menu className="size-4" /> {t("common.allCategories")}</Button></DropdownMenuTrigger>
              <DropdownMenuContent className="w-64">
                {categories.map((c) => <DropdownMenuItem key={c.slug} asChild><Link href={`/shop?category=${encodeURIComponent(c.slug)}`}>{catName(c)}</Link></DropdownMenuItem>)}
              </DropdownMenuContent>
            </DropdownMenu>
            {nav.map((n) => (
              <Link key={n.href} href={n.href} className={cn("whitespace-nowrap rounded-full px-3 py-1.5 font-medium text-muted-foreground transition hover:bg-secondary hover:text-secondary-foreground", pathname === n.href && "text-primary")}>{n.label}</Link>
            ))}
          </div>
        </nav>
      </header>

      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-80 max-w-[85vw] flex-col gap-4 overflow-y-auto bg-white p-5 shadow-xl">
            <div className="flex items-center justify-between"><Logo /><button onClick={() => setOpen(false)} aria-label={t("common.close")}><X /></button></div>
            <LocaleSwitcher />
            <div className="flex flex-col">
              {nav.map((n) => <Link key={n.href} href={n.href} onClick={() => setOpen(false)} className="rounded-lg px-3 py-2.5 font-medium hover:bg-secondary">{n.label}</Link>)}
            </div>
            <div className="border-t pt-3">
              <div className="mb-2 px-3 text-xs font-semibold uppercase text-muted-foreground">{t("common.categories")}</div>
              {categories.map((c) => <Link key={c.slug} href={`/shop?category=${encodeURIComponent(c.slug)}`} onClick={() => setOpen(false)} className="block rounded-lg px-3 py-2 text-sm hover:bg-secondary">{catName(c)}</Link>)}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
