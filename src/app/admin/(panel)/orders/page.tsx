import { requireStaffPage } from "@/lib/auth/guards";
import { OrdersClient } from "@/components/admin/orders-client";

export const dynamic = "force-dynamic";

export default async function AdminOrdersPage() {
  await requireStaffPage("orders.read");
  return <OrdersClient />;
}
