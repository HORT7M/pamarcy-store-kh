import { requireStaff } from "@/lib/auth/session";
import { dashboardData } from "@/lib/services/reports";
import { DashboardClient } from "@/components/admin/dashboard-client";

export const dynamic = "force-dynamic";

export default async function AdminDashboardPage() {
  await requireStaff("dashboard.view");
  const data = await dashboardData();
  return <DashboardClient data={JSON.parse(JSON.stringify(data))} />;
}
