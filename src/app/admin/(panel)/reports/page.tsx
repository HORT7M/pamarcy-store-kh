import { requireStaff } from "@/lib/auth/session";
import { ReportsClient } from "@/components/admin/reports-client";

export const dynamic = "force-dynamic";

export default async function AdminReportsPage() {
  await requireStaff("reports.view");
  return <ReportsClient />;
}
