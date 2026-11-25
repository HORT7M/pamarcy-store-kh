import { apiHandler, parseParams } from "@/lib/api";
import { prisma } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { toCards, productCardInclude } from "@/lib/catalog";
import { slugOnlyParamSchema } from "@/lib/validators";

/** GET /api/products/:slug – public product detail (explicit allow-list: no cost, sales counters, flags or timestamps) */
export const GET = apiHandler<{ slug: string }>(async (_req, { params }) => {
  const { slug } = await parseParams(params, slugOnlyParamSchema);
  const m = await prisma.medicine.findFirst({ where: { OR: [{ slug }, { id: slug }], deletedAt: null, isActive: true }, include: productCardInclude });
  if (!m) throw notFound("Product not found");
  const [card] = await toCards([m]);
  return {
    id: m.id, slug: m.slug, sku: m.sku, barcode: m.barcode, nameEn: m.nameEn, nameKm: m.nameKm, genericName: m.genericName,
    descriptionEn: m.descriptionEn, descriptionKm: m.descriptionKm, manufacturer: m.manufacturer, activeIngredients: m.activeIngredients,
    dosageForm: m.dosageForm, strength: m.strength, dosageInfo: m.dosageInfo, usageInstructions: m.usageInstructions, warnings: m.warnings,
    unit: m.unit, price: m.price, compareAtPrice: m.compareAtPrice, imageUrl: m.imageUrl, images: m.images, requiresPrescription: m.requiresPrescription,
    brand: m.brand, category: m.category, available: card.available,
  };
});
