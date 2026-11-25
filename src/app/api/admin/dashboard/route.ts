import { apiHandler } from "@/lib/api";
import { can, requireStaff } from "@/lib/auth/session";
import { dashboardData } from "@/lib/services/reports";

export const GET = apiHandler(async () => {
  const user = await requireStaff("dashboard.view");
  return dashboardData({
    ordersRead: can(user, "orders.read"),
    paymentsRead: can(user, "payments.read"),
    customersRead: can(user, "customers.read"),
    inventoryRead: can(user, "inventory.read"),
    reportsView: can(user, "reports.view"),
  });
});
