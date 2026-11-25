import { apiHandler, parseBody, parseParams } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { roleHas } from "@/lib/auth/permissions";
import { idParamSchema, medicineUpdateSchema } from "@/lib/validators";
import { MEDICINE_WRITE_FIELDS, pickAllowed } from "@/lib/allowlist";
import { audit } from "@/lib/audit";
import { badRequest, notFound } from "@/lib/errors";

export const GET = apiHandler<{ id: string }>(async (_req, { params }) => {
  const user = await requireStaff("medicines.read");
  const { id } = await parseParams(params, idParamSchema);
  const canInventory = roleHas(user.role, "inventory.read");
  const m = await prisma.medicine.findFirst({
    where: { id, deletedAt: null },
    include: {
      category: true,
      brand: true,
      inventory: true,
      ...(canInventory
        ? {
            batches: { orderBy: { expiryDate: "asc" }, include: { supplier: { select: { name: true } } } },
            movements: { orderBy: { createdAt: "desc" }, take: 30 },
          }
        : {}),
    },
  });
  if (!m) throw notFound();
  return canInventory ? m : { ...m, batches: [], movements: [] };
});

export const PUT = apiHandler<{ id: string }>(async (req, { params }) => {
  const user = await requireStaff("medicines.write");
  const { id } = await parseParams(params, idParamSchema);
  const parsed = await parseBody(req, medicineUpdateSchema);
  const { minStock, location } = parsed;
  const data = pickAllowed(parsed, MEDICINE_WRITE_FIELDS);
  if (data.compareAtPrice && data.compareAtPrice <= data.price) data.compareAtPrice = null;
  const before = await prisma.medicine.findFirst({ where: { id, deletedAt: null } });
  if (!before) throw notFound();

  const cat = await prisma.category.findFirst({ where: { id: data.categoryId, deletedAt: null }, select: { id: true } });
  if (!cat) throw badRequest("Category not found");
  if (data.brandId) {
    const brand = await prisma.brand.findFirst({ where: { id: data.brandId, deletedAt: null }, select: { id: true } });
    if (!brand) throw badRequest("Brand not found");
  }

  const m = await prisma.medicine.update({
    where: { id },
    data: {
      ...data,
      imageUrl: data.imageUrl ?? data.images[0] ?? null,
      inventory: { upsert: { update: { minStock, location }, create: { minStock, location } } },
    },
  });
  const changed = MEDICINE_WRITE_FIELDS.filter((k) => String((before as Record<string, unknown>)[k]) !== String((data as Record<string, unknown>)[k]));
  await audit(user.id, "medicine.update", "Medicine", id, { changed, price: before.price.toString() !== String(data.price) ? { from: before.price.toString(), to: data.price } : undefined });
  return m;
});

/** Soft delete – keeps order / stock history intact */
export const DELETE = apiHandler<{ id: string }>(async (_req, { params }) => {
  const user = await requireStaff("medicines.delete");
  const { id } = await parseParams(params, idParamSchema);
  const cur = await prisma.medicine.findFirst({ where: { id, deletedAt: null } });
  if (!cur) throw notFound();
  const tag = `~del-${Date.now().toString(36)}`;
  // free unique SKU / barcode / slug so they can be reused, keep originals in the audit log
  const m = await prisma.medicine.update({ where: { id }, data: { deletedAt: new Date(), isActive: false, sku: cur.sku + tag, barcode: cur.barcode ? cur.barcode + tag : null, slug: cur.slug + tag } });
  await audit(user.id, "medicine.delete", "Medicine", id, { sku: cur.sku, barcode: cur.barcode, newSku: m.sku });
  return { ok: true };
});
