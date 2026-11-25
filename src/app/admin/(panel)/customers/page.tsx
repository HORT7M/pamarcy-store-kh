import { requireStaffPage } from "@/lib/auth/guards";
import { CustomersClient } from "@/components/admin/customers-client";

export const dynamic = "force-dynamic";

export default async function AdminCustomersPage() {
  await requireStaffPage("customers.read");
  return <CustomersClient />;
}
