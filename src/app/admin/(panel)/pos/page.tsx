import { prisma } from "@/lib/db";
import { requireStaff, can } from "@/lib/auth/session";
import { toCards, productCardInclude } from "@/lib/catalog";
import { availableMethods } from "@/lib/services/payments/config";
import { getSettings } from "@/lib/settings";
import { PosClient } from "@/components/admin/pos-client";

export const dynamic = "force-dynamic";

export default async function AdminPosPage() {
  const user = await requireStaff("pos.use");
  const [meds, categories, methods, settings] = await Promise.all([
    prisma.medicine.findMany({ where: { deletedAt: null, isActive: true }, orderBy: [{ soldCount: "desc" }, { nameEn: "asc" }], include: productCardInclude, take: 60 }),
    prisma.category.findMany({ where: { deletedAt: null, isActive: true }, orderBy: { sortOrder: "asc" }, select: { slug: true, nameEn: true, nameKm: true } }),
    availableMethods("pos"),
    getSettings(),
  ]);
  const products = await toCards(meds);
  return (
    <PosClient
      initialProducts={products}
      categories={categories}
      methods={methods}
      exchangeRate={settings.exchangeRate}
      canDispenseRx={can(user, "prescriptions.review")}
      canManualDiscount={can(user, "orders.write") || can(user, "discounts.write")}
    />
  );
}
