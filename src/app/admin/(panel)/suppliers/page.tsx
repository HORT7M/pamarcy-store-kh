import { can } from "@/lib/auth/session";
import { requireStaffPage } from "@/lib/auth/guards";
import { SuppliersClient } from "@/components/admin/suppliers-client";

export const dynamic = "force-dynamic";

export default async function AdminSuppliersPage() {
  const user = await requireStaffPage("suppliers.read");
  return <SuppliersClient canWrite={can(user, "suppliers.write")} />;
}
