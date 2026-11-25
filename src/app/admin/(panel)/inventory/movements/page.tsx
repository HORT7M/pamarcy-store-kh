import { requireStaff } from "@/lib/auth/session";
import { MovementsClient } from "@/components/admin/movements-client";

export const dynamic = "force-dynamic";

export default async function StockMovementsPage() {
  await requireStaff("inventory.read");
  return <MovementsClient />;
}
