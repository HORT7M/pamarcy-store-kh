import { prisma } from "@/lib/db";
import { requireStaff, can } from "@/lib/auth/session";
import { PurchasesClient } from "@/components/admin/purchases-client";

export const dynamic = "force-dynamic";

export default async function AdminPurchasesPage() {
  const user = await requireStaff("purchases.read");
  const [suppliers, medicines] = await Promise.all([
    prisma.supplier.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.medicine.findMany({ where: { deletedAt: null }, orderBy: { nameEn: "asc" }, select: { id: true, nameEn: true, sku: true, costPrice: true } }),
  ]);
  return (
    <PurchasesClient
      suppliers={suppliers}
      medicines={medicines.map((m) => ({ ...m, costPrice: m.costPrice.toString() }))}
      canWrite={can(user, "purchases.write")}
    />
  );
}
