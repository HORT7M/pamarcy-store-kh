import { ENTITY_ID_RE } from "@/lib/validators";
import { notFound } from "next/navigation";
import { can } from "@/lib/auth/session";
import { requireStaffPage } from "@/lib/auth/guards";
import { AdminOrderDetail } from "@/components/admin/order-detail";

export const dynamic = "force-dynamic";

export default async function AdminOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireStaffPage("orders.read");
  const { id } = await params;
  if (!ENTITY_ID_RE.test(id)) notFound();
  return (
    <AdminOrderDetail
      orderId={id}
      perms={{
        write: can(user, "orders.write"),
        cancel: can(user, "orders.cancel"),
        refund: can(user, "orders.refund"),
        rx: can(user, "prescriptions.review"),
      }}
    />
  );
}
