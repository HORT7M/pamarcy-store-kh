import { prisma } from "@/lib/db";
import { can } from "@/lib/auth/session";
import { requireStaffPage } from "@/lib/auth/guards";
import { InventoryClient } from "@/components/admin/inventory-client";

export const dynamic = "force-dynamic";

export default async function AdminInventoryPage() {
  const user = await requireStaffPage("inventory.read");
  const [meds, suppliers] = await Promise.all([
    prisma.medicine.findMany({ where: { deletedAt: null }, orderBy: { nameEn: "asc" }, select: { id: true, nameEn: true, sku: true, costPrice: true, tracksExpiry: true } }),
    prisma.supplier.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  return (
    <InventoryClient
      medicines={meds.map((m) => ({ ...m, costPrice: m.costPrice.toString() }))}
      suppliers={suppliers}
      canWrite={can(user, "inventory.write")}
    />
  );
}
