import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth/session";
import { getSettings } from "@/lib/settings";
import { ShopHeader } from "@/components/shop/header";
import { ShopFooter } from "@/components/shop/footer";

export default async function ShopLayout({ children }: { children: React.ReactNode }) {
  const [categories, user, settings] = await Promise.all([
    prisma.category.findMany({ where: { deletedAt: null, isActive: true }, orderBy: { sortOrder: "asc" }, select: { slug: true, nameEn: true, nameKm: true } }),
    getCurrentUser(),
    getSettings(),
  ]);
  return (
    <div className="flex min-h-screen flex-col">
      <ShopHeader categories={categories} user={user ? { name: user.name, isStaff: user.isStaff } : null} phone={settings.phone} />
      <main className="flex-1">{children}</main>
      <ShopFooter settings={settings} categories={categories} />
    </div>
  );
}
