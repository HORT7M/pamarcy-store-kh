import { can } from "@/lib/auth/session";
import { requireStaffPage } from "@/lib/auth/guards";
import { dashboardData } from "@/lib/services/reports";
import { DashboardClient } from "@/components/admin/dashboard-client";

export const dynamic = "force-dynamic";

export default async function AdminDashboardPage() {
  const user = await requireStaffPage("dashboard.view");
  const data = await dashboardData({
    ordersRead: can(user, "orders.read"),
    paymentsRead: can(user, "payments.read"),
    customersRead: can(user, "customers.read"),
    inventoryRead: can(user, "inventory.read"),
    reportsView: can(user, "reports.view"),
  });
  return <DashboardClient data={JSON.parse(JSON.stringify(data))} />;
}
