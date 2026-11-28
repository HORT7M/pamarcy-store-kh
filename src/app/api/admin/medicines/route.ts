import type { Prisma } from "@prisma/client";
import { apiHandler, parseBody, parseQuery, paginate } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { roleHas } from "@/lib/auth/permissions";
import { adminMedicinesQuerySchema, medicineSchema } from "@/lib/validators";
import { MEDICINE_WRITE_FIELDS, pickAllowed } from "@/lib/allowlist";
import { audit } from "@/lib/audit";
import { stockIn, getAvailability, sellableCutoff } from "@/lib/services/inventory";
import { parseDateInput } from "@/lib/date";
import { badRequest, forbidden } from "@/lib/errors";
import { slugify } from "@/lib/slug";

export const GET = apiHandler(async (req) => {
  await requireStaff("medicines.read");
  const p = parseQuery(req, adminMedicinesQuerySchema);
  const pg = paginate(p.page, p.pageSize);
  const where: Prisma.MedicineWhereInput = { deletedAt: null };
  if (p.q) where.OR = [{ nameEn: { contains: p.q, mode: "insensitive" } }, { nameKm: { contains: p.q } }, { sku: { contains: p.q, mode: "insensitive" } }, { barcode: p.q }, { genericName: { contains: p.q, mode: "insensitive" } }];
  if (p.category) where.categoryId = p.category;
  if (p.status === "active") where.isActive = true;
  if (p.status === "inactive") where.isActive = false;
  if (p.rx) where.requiresPrescription = p.rx === "rx";
  if (p.status === "low" || p.status === "out") {
    const cutoff = sellableCutoff();
    const rows =
      p.status === "out"
        ? await prisma.$queryRaw<{ medicineId: string }[]>`
            SELECT m.id AS "medicineId"
            FROM "Medicine" m
            LEFT JOIN "MedicineBatch" b ON b."medicineId" = m.id
            WHERE m."deletedAt" IS NULL
            GROUP BY m.id
            HAVING COALESCE(SUM(CASE WHEN b."expiryDate" IS NULL OR b."expiryDate" >= ${cutoff} THEN GREATEST(0, b.quantity - b.reserved) ELSE 0 END), 0) <= 0`
        : await prisma.$queryRaw<{ medicineId: string }[]>`
            SELECT m.id AS "medicineId"
            FROM "Medicine" m
            LEFT JOIN "Inventory" i ON i."medicineId" = m.id
            LEFT JOIN "MedicineBatch" b ON b."medicineId" = m.id
            WHERE m."deletedAt" IS NULL
            GROUP BY m.id, i."minStock"
            HAVING COALESCE(SUM(CASE WHEN b."expiryDate" IS NULL OR b."expiryDate" >= ${cutoff} THEN GREATEST(0, b.quantity - b.reserved) ELSE 0 END), 0) > 0
               AND COALESCE(SUM(CASE WHEN b."expiryDate" IS NULL OR b."expiryDate" >= ${cutoff} THEN GREATEST(0, b.quantity - b.reserved) ELSE 0 END), 0) <= COALESCE(i."minStock", 0)`;
    where.id = { in: rows.map((r) => r.medicineId) };
  }
  const [total, items] = await Promise.all([
    prisma.medicine.count({ where }),
    prisma.medicine.findMany({ where, orderBy: { updatedAt: "desc" }, skip: pg.skip, take: pg.take, include: { category: true, brand: true, inventory: true } }),
  ]);
  const avail = await getAvailability(prisma, items.map((i) => i.id));
  return { total, page: pg.page, pageSize: pg.pageSize, items: items.map((i) => ({ ...i, sellable: avail.get(i.id) ?? 0 })) };
});

export const POST = apiHandler(async (req) => {
  const user = await requireStaff("medicines.write");
  const parsed = await parseBody(req, medicineSchema);
  const { minStock, location, initialStock } = parsed;
  if (initialStock && !roleHas(user.role, "inventory.write")) {
    throw forbidden("You do not have permission to add opening stock");
  }
  const data = pickAllowed(parsed, MEDICINE_WRITE_FIELDS);
  if (data.compareAtPrice && data.compareAtPrice <= data.price) data.compareAtPrice = null;

  const cat = await prisma.category.findFirst({ where: { id: data.categoryId, deletedAt: null }, select: { id: true } });
  if (!cat) throw badRequest("Category not found");
  if (data.brandId) {
    const brand = await prisma.brand.findFirst({ where: { id: data.brandId, deletedAt: null }, select: { id: true } });
    if (!brand) throw badRequest("Brand not found");
  }
  if (initialStock) {
    if (data.tracksExpiry && !initialStock.expiryDate) throw badRequest("Expiry date is required for the opening batch");
    if (initialStock.expiryDate && parseDateInput(initialStock.expiryDate) < sellableCutoff()) {
      throw badRequest("Opening batch cannot already be expired");
    }
  }

  let slug = slugify(`${data.nameEn}-${data.sku}`);
  if (await prisma.medicine.findUnique({ where: { slug } })) slug = `${slug}-${Date.now().toString(36)}`;
  const med = await prisma.$transaction(async (tx) => {
    const m = await tx.medicine.create({
      data: {
        ...data,
        slug,
        imageUrl: data.imageUrl ?? data.images[0] ?? null,
        inventory: { create: { minStock, location } },
      },
    });
    if (initialStock) {
      await stockIn(tx, {
        medicineId: m.id,
        batchNumber: initialStock.batchNumber,
        quantity: initialStock.quantity,
        costPrice: initialStock.costPrice ?? data.costPrice,
        expiryDate: initialStock.expiryDate ? parseDateInput(initialStock.expiryDate) : null,
        reason: "Opening stock",
        userId: user.id,
        type: "STOCK_IN",
      });
    }
    return m;
  });
  await audit(user.id, "medicine.create", "Medicine", med.id, { sku: med.sku });
  return med;
});
