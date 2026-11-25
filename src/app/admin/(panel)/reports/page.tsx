import { requireStaffPage } from "@/lib/auth/guards";
import { ReportsClient } from "@/components/admin/reports-client";

export const dynamic = "force-dynamic";

export default async function AdminReportsPage() {
  await requireStaffPage("reports.view");
  return <ReportsClient />;
}
