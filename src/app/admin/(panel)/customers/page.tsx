import { requireStaff } from "@/lib/auth/session";
import { CustomersClient } from "@/components/admin/customers-client";

export const dynamic = "force-dynamic";

export default async function AdminCustomersPage() {
  await requireStaff("customers.read");
  return <CustomersClient />;
}
