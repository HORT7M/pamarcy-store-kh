import { requireStaff, can } from "@/lib/auth/session";
import { SuppliersClient } from "@/components/admin/suppliers-client";

export const dynamic = "force-dynamic";

export default async function AdminSuppliersPage() {
  const user = await requireStaff("suppliers.read");
  return <SuppliersClient canWrite={can(user, "suppliers.write")} />;
}
