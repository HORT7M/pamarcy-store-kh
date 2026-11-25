import { requireStaffPage } from "@/lib/auth/guards";
import { AuditClient } from "@/components/admin/audit-client";

export const dynamic = "force-dynamic";

export default async function AdminAuditPage() {
  await requireStaffPage("audit.view");
  return <AuditClient />;
}
