import { requireStaff } from "@/lib/auth/session";
import { OrdersClient } from "@/components/admin/orders-client";

export const dynamic = "force-dynamic";

export default async function AdminOrdersPage() {
  await requireStaff("orders.read");
  return <OrdersClient />;
}
