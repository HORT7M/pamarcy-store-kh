import { Heart } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireCustomerPage } from "@/lib/auth/guards";
import { getT } from "@/lib/i18n/server";
import { toCards, productCardInclude } from "@/lib/catalog";
import { ProductCard } from "@/components/shop/product-card";
import { EmptyState } from "@/components/common/empty-state";

export const dynamic = "force-dynamic";

export default async function WishlistPage() {
  const user = await requireCustomerPage();
  const { t } = await getT();
  const items = await prisma.wishlistItem.findMany({ where: { customerId: user.customerId, medicine: { deletedAt: null, isActive: true } }, include: { medicine: { include: productCardInclude } }, orderBy: { createdAt: "desc" } });
  const cards = await toCards(items.map((i) => i.medicine));
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t("account.wishlist")}</h1>
      {cards.length === 0 ? <EmptyState icon={Heart} title={t("common.noResults")} /> : <div className="grid grid-cols-2 gap-3 md:grid-cols-3">{cards.map((c) => <ProductCard key={c.id} p={c} />)}</div>}
    </div>
  );
}
