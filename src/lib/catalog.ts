import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { getAvailability, sellableCutoff } from "./services/inventory";
import { toNum } from "./money";

export type ProductCard = {
  id: string; slug: string; sku: string; nameEn: string; nameKm: string; imageUrl: string | null; price: number; compareAtPrice: number | null;
  requiresPrescription: boolean; available: number; brand: string | null; categorySlug: string; categoryEn: string; categoryKm: string; unit: string;
};

export const productCardInclude = { brand: { select: { name: true } }, category: { select: { slug: true, nameEn: true, nameKm: true } } } satisfies Prisma.MedicineInclude;

export async function toCards(meds: Prisma.MedicineGetPayload<{ include: typeof productCardInclude }>[]): Promise<ProductCard[]> {
  const avail = await getAvailability(prisma, meds.map((m) => m.id));
  return meds.map((m) => ({
    id: m.id, slug: m.slug, sku: m.sku, nameEn: m.nameEn, nameKm: m.nameKm, imageUrl: m.imageUrl, price: toNum(m.price),
    compareAtPrice: m.compareAtPrice ? toNum(m.compareAtPrice) : null, requiresPrescription: m.requiresPrescription, available: avail.get(m.id) ?? 0,
    brand: m.brand?.name ?? null, categorySlug: m.category.slug, categoryEn: m.category.nameEn, categoryKm: m.category.nameKm, unit: m.unit,
  }));
}

export type ProductQuery = {
  q?: string; category?: string; brand?: string[]; minPrice?: number; maxPrice?: number; sort?: string; inStock?: boolean; rx?: "rx" | "otc";
  page?: number; pageSize?: number; featured?: boolean; offers?: boolean;
};

export async function searchProducts(p: ProductQuery) {
  const where: Prisma.MedicineWhereInput = { deletedAt: null, isActive: true };
  const and: Prisma.MedicineWhereInput[] = [];
  if (p.q) {
    const q = p.q.trim();
    and.push({
      OR: [
        { nameEn: { contains: q, mode: "insensitive" } }, { nameKm: { contains: q, mode: "insensitive" } }, { genericName: { contains: q, mode: "insensitive" } },
        { sku: { contains: q, mode: "insensitive" } }, { barcode: q }, { activeIngredients: { contains: q, mode: "insensitive" } },
        { brand: { name: { contains: q, mode: "insensitive" } } }, { category: { nameEn: { contains: q, mode: "insensitive" } } }, { category: { nameKm: { contains: q } } },
      ],
    });
  }
  if (p.category) and.push({ category: { slug: p.category } });
  if (p.brand?.length) and.push({ brand: { slug: { in: p.brand } } });
  if (p.minPrice !== undefined) and.push({ price: { gte: p.minPrice } });
  if (p.maxPrice !== undefined) and.push({ price: { lte: p.maxPrice } });
  if (p.rx === "rx") and.push({ requiresPrescription: true });
  if (p.rx === "otc") and.push({ requiresPrescription: false });
  if (p.featured) and.push({ isFeatured: true });
  if (p.offers) and.push({ compareAtPrice: { not: null } });
  if (p.inStock) and.push({ inventory: { quantity: { gt: 0 } }, batches: { some: { quantity: { gt: 0 }, OR: [{ expiryDate: null }, { expiryDate: { gte: sellableCutoff() } }] } } });
  if (and.length) where.AND = and;
  const orderBy: Prisma.MedicineOrderByWithRelationInput[] =
    p.sort === "newest" ? [{ createdAt: "desc" }] : p.sort === "price_asc" ? [{ price: "asc" }] : p.sort === "price_desc" ? [{ price: "desc" }] : p.sort === "name" ? [{ nameEn: "asc" }] : [{ soldCount: "desc" }, { nameEn: "asc" }];
  const pageSize = Math.min(48, Math.max(1, p.pageSize ?? 12));
  const page = Math.max(1, p.page ?? 1);
  const [total, meds] = await Promise.all([
    prisma.medicine.count({ where }),
    prisma.medicine.findMany({ where, orderBy, skip: (page - 1) * pageSize, take: pageSize, include: productCardInclude }),
  ]);
  let items = await toCards(meds);
  if (p.inStock) items = items.filter((i) => i.available > 0);
  return { items, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}
