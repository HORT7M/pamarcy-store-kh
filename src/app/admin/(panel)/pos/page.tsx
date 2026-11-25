import { prisma } from "@/lib/db";
import { can } from "@/lib/auth/session";
import { requireStaffPage } from "@/lib/auth/guards";
import { toCards, productCardInclude } from "@/lib/catalog";
import { availableMethods } from "@/lib/services/payments/config";
import { getSettings } from "@/lib/settings";
import { PosClient } from "@/components/admin/pos-client";

export const dynamic = "force-dynamic";

export default async function AdminPosPage() {
  const user = await requireStaffPage("pos.use");
  const [meds, categories, rawMethods, settings] = await Promise.all([
    prisma.medicine.findMany({ where: { deletedAt: null, isActive: true }, orderBy: [{ soldCount: "desc" }, { nameEn: "asc" }], include: productCardInclude, take: 60 }),
    prisma.category.findMany({ where: { deletedAt: null, isActive: true }, orderBy: { sortOrder: "asc" }, select: { slug: true, nameEn: true, nameKm: true } }),
    availableMethods("pos"),
    getSettings(),
  ]);
  const detailed = can(user, "settings.payments");
  const methods = rawMethods.map(({ reason, ...m }) =>
    detailed || m.ready ? { ...m, reason: m.ready ? undefined : reason } : { ...m, reason: "Not available" },
  );
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
