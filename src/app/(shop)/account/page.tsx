import Link from "next/link";
import { Package, Clock, Heart, MapPin } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireCustomer } from "@/lib/auth/session";
import { getT } from "@/lib/i18n/server";
import { customerOrders } from "@/lib/account";
import { OrderList } from "@/components/shop/order-list";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const user = await requireCustomer();
  const { t } = await getT();
  const [orders, total, pending, wish, addrs] = await Promise.all([
    customerOrders(user.customerId, 5),
    prisma.order.count({ where: { customerId: user.customerId } }),
    prisma.order.count({ where: { customerId: user.customerId, status: { in: ["PENDING", "CONFIRMED", "PROCESSING", "READY_FOR_DELIVERY", "SHIPPING"] } } }),
    prisma.wishlistItem.count({ where: { customerId: user.customerId } }),
    prisma.address.count({ where: { customerId: user.customerId } }),
  ]);
  const stats = [
    { icon: Package, label: t("account.orders"), value: total, href: "/account/orders" },
    { icon: Clock, label: t("status.PROCESSING"), value: pending, href: "/account/orders" },
    { icon: Heart, label: t("account.wishlist"), value: wish, href: "/account/wishlist" },
    { icon: MapPin, label: t("account.addresses"), value: addrs, href: "/account/addresses" },
  ];
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{t("account.welcome", { name: user.name })}</h1>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.map((s) => (
          <Link key={s.label} href={s.href} className="rounded-2xl border bg-white p-4 shadow-sm hover:border-primary/50">
            <s.icon className="mb-2 size-5 text-primary" /><div className="text-2xl font-bold">{s.value}</div><div className="text-xs text-muted-foreground">{s.label}</div>
          </Link>
        ))}
      </div>
      <div>
        <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">{t("account.orders")}</h2><Link href="/account/orders" className="text-sm text-primary hover:underline">{t("common.viewAll")}</Link></div>
        {orders.length ? <OrderList orders={orders} /> : <EmptyState icon={Package} title={t("account.noOrders")} action={<Button asChild className="rounded-full"><Link href="/shop">{t("home.shopNow")}</Link></Button>} />}
      </div>
    </div>
  );
}
