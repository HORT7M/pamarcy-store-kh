import { apiHandler } from "@/lib/api";
import { prisma } from "@/lib/db";

export const GET = apiHandler(async () => {
  const categories = await prisma.category.findMany({ where: { deletedAt: null, isActive: true }, orderBy: { sortOrder: "asc" }, select: { id: true, slug: true, nameEn: true, nameKm: true, description: true, icon: true, imageUrl: true, sortOrder: true, _count: { select: { medicines: { where: { deletedAt: null, isActive: true } } } } } });
  return { categories };
});
