import { ENTITY_ID_RE } from "@/lib/validators";
import { notFound } from "next/navigation";
import { can } from "@/lib/auth/session";
import { requireStaffPage } from "@/lib/auth/guards";
import { CustomerDetailClient } from "@/components/admin/customer-detail";

export const dynamic = "force-dynamic";

export default async function AdminCustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireStaffPage("customers.read");
  const { id } = await params;
  if (!ENTITY_ID_RE.test(id)) notFound();
  return <CustomerDetailClient id={id} canWrite={can(user, "customers.write")} />;
}
