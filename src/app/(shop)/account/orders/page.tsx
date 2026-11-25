import Link from "next/link";
import { Package } from "lucide-react";
import { requireCustomer } from "@/lib/auth/session";
import { getT } from "@/lib/i18n/server";
import { customerOrders } from "@/lib/account";
import { OrderList } from "@/components/shop/order-list";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  const user = await requireCustomer();
  const { t } = await getT();
  const orders = await customerOrders(user.customerId, 100);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t("account.orders")}</h1>
      {orders.length ? <OrderList orders={orders} /> : <EmptyState icon={Package} title={t("account.noOrders")} action={<Button asChild className="rounded-full"><Link href="/shop">{t("home.shopNow")}</Link></Button>} />}
    </div>
  );
}
