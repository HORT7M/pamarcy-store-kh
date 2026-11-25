import { requireStaff } from "@/lib/auth/session";
import { AuditClient } from "@/components/admin/audit-client";

export const dynamic = "force-dynamic";

export default async function AdminAuditPage() {
  await requireStaff("audit.view");
  return <AuditClient />;
}
