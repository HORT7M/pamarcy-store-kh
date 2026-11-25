import { apiHandler, parseQuery } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { toCards, productCardInclude } from "@/lib/catalog";
import { posLookupQuerySchema } from "@/lib/validators";

/** GET /api/admin/pos/lookup?q= – search by name / SKU / exact barcode for the POS */
export const GET = apiHandler(async (req) => {
  await requireStaff("pos.use");
  const { q } = parseQuery(req, posLookupQuerySchema);
  const exact = await prisma.medicine.findFirst({ where: { deletedAt: null, isActive: true, OR: [{ barcode: q }, { sku: { equals: q, mode: "insensitive" } }] }, include: productCardInclude });
  if (exact) return { exact: true, items: await toCards([exact]) };
  const meds = await prisma.medicine.findMany({
    where: { deletedAt: null, isActive: true, OR: [{ nameEn: { contains: q, mode: "insensitive" } }, { nameKm: { contains: q } }, { sku: { contains: q, mode: "insensitive" } }, { genericName: { contains: q, mode: "insensitive" } }] },
    take: 12, orderBy: { soldCount: "desc" }, include: productCardInclude,
  });
  return { exact: false, items: await toCards(meds) };
}, { rateLimit: 600 });
