import { requireStaffPage } from "@/lib/auth/guards";
import { MovementsClient } from "@/components/admin/movements-client";

export const dynamic = "force-dynamic";

export default async function StockMovementsPage() {
  await requireStaffPage("inventory.read");
  return <MovementsClient />;
}
