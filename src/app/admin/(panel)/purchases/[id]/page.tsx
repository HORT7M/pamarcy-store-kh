import { ENTITY_ID_RE } from "@/lib/validators";
import { notFound } from "next/navigation";
import { requireStaff, can } from "@/lib/auth/session";
import { PurchaseDetailClient } from "@/components/admin/purchase-detail";

export const dynamic = "force-dynamic";

export default async function AdminPurchaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireStaff("purchases.read");
  const { id } = await params;
  if (!ENTITY_ID_RE.test(id)) notFound();
  return <PurchaseDetailClient id={id} canWrite={can(user, "purchases.write")} />;
}
