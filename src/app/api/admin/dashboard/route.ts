import { apiHandler } from "@/lib/api";
import { requireStaff } from "@/lib/auth/session";
import { dashboardData } from "@/lib/services/reports";

export const GET = apiHandler(async () => {
  await requireStaff("dashboard.view");
  return dashboardData();
});
