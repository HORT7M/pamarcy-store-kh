import { prisma } from "@/lib/db";
import { can } from "@/lib/auth/session";
import { requireStaffPage } from "@/lib/auth/guards";
import { InventoryClient } from "@/components/admin/inventory-client";
import { normalizeSingleLineText } from "@/lib/sanitize";

export const dynamic = "force-dynamic";

export default async function AdminInventoryPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const [user, sp, meds, suppliers] = await Promise.all([
    requireStaffPage("inventory.read"),
    searchParams,
    prisma.medicine.findMany({ where: { deletedAt: null }, orderBy: { nameEn: "asc" }, select: { id: true, nameEn: true, sku: true, costPrice: true, tracksExpiry: true } }),
    prisma.supplier.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  const rawQ = typeof sp.q === "string" ? sp.q : Array.isArray(sp.q) ? sp.q[0] : "";
  const initialQuery = rawQ ? normalizeSingleLineText(rawQ, 100) : "";
  return (
    <InventoryClient
      medicines={meds.map((m) => ({ ...m, costPrice: m.costPrice.toString() }))}
      suppliers={suppliers}
      canWrite={can(user, "inventory.write")}
      initialQuery={initialQuery}
    />
  );
}
