import { apiHandler, parseQuery, paginate } from "@/lib/api";
import { prisma, escapeLike } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { sellableCutoff } from "@/lib/services/inventory";
import { adminInventoryQuerySchema } from "@/lib/validators";

/** GET /api/admin/inventory – per-medicine stock overview with sellable / expired / reserved breakdown */
export const GET = apiHandler(async (req) => {
  await requireStaff("inventory.read");
  const p = parseQuery(req, adminInventoryQuerySchema);
  const pg = paginate(p.page, p.pageSize ?? 25);
  const cutoff = sellableCutoff();
  const rawQ = p.q?.trim() || null;
  const pattern = rawQ ? `%${escapeLike(rawQ)}%` : null;
  const rows = await prisma.$queryRaw<{ id: string; sku: string; nameEn: string; nameKm: string; imageUrl: string | null; minStock: number; location: string | null; onHand: number; reserved: number; expired: number; sellable: number; costValue: number; retailValue: number; nearestExpiry: Date | null; batches: number }[]>`
    SELECT m.id, m.sku, m."nameEn", m."nameKm", m."imageUrl", COALESCE(i."minStock", 0)::int AS "minStock", i.location,
      COALESCE(SUM(b.quantity), 0)::int AS "onHand",
      COALESCE(SUM(b.reserved), 0)::int AS reserved,
      COALESCE(SUM(CASE WHEN b."expiryDate" < ${cutoff} THEN b.quantity ELSE 0 END), 0)::int AS expired,
      COALESCE(SUM(CASE WHEN b."expiryDate" IS NULL OR b."expiryDate" >= ${cutoff} THEN GREATEST(0, b.quantity - b.reserved) ELSE 0 END), 0)::int AS sellable,
      COALESCE(SUM(b.quantity * b."costPrice"), 0)::float AS "costValue",
      COALESCE(SUM(b.quantity) * m.price, 0)::float AS "retailValue",
      MIN(CASE WHEN b.quantity > 0 AND b."expiryDate" >= ${cutoff} THEN b."expiryDate" END) AS "nearestExpiry",
      COUNT(b.id) FILTER (WHERE b.quantity > 0)::int AS batches
    FROM "Medicine" m
    LEFT JOIN "Inventory" i ON i."medicineId" = m.id
    LEFT JOIN "MedicineBatch" b ON b."medicineId" = m.id
    WHERE m."deletedAt" IS NULL
      AND (${pattern}::text IS NULL OR m."nameEn" ILIKE ${pattern} ESCAPE '\\' OR m.sku ILIKE ${pattern} ESCAPE '\\' OR m."nameKm" ILIKE ${pattern} ESCAPE '\\' OR m.barcode = ${rawQ})
    GROUP BY m.id, i."minStock", i.location
    ORDER BY m."nameEn"`;
  const enriched = rows;
  const filtered = enriched.filter((r) =>
    p.filter === "low" ? r.sellable <= r.minStock && r.sellable > 0 : p.filter === "out" ? r.sellable <= 0 : p.filter === "expired" ? r.expired > 0 : true,
  );
  const totals = enriched.reduce((a, r) => ({ costValue: a.costValue + r.costValue, retailValue: a.retailValue + r.retailValue, units: a.units + r.onHand, low: a.low + (r.sellable <= r.minStock ? 1 : 0), expiredUnits: a.expiredUnits + r.expired }), { costValue: 0, retailValue: 0, units: 0, low: 0, expiredUnits: 0 });
  return { total: filtered.length, page: pg.page, pageSize: pg.pageSize, items: filtered.slice(pg.skip, pg.skip + pg.take), totals };
});
