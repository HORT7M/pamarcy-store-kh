import { apiHandler, parseBody, parseQuery } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { adminSuppliersQuerySchema, supplierSchema } from "@/lib/validators";
import { audit } from "@/lib/audit";

export const GET = apiHandler(async (req) => {
  await requireStaff("suppliers.read");
  const { q } = parseQuery(req, adminSuppliersQuerySchema);
  const items = await prisma.supplier.findMany({
    where: { deletedAt: null, ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }, { contactName: { contains: q, mode: "insensitive" } }] } : {}) },
    orderBy: { name: "asc" },
    include: { _count: { select: { purchases: true } }, purchases: { select: { total: true, status: true } } },
  });
  return {
    items: items.map(({ purchases, ...s }) => ({ ...s, totalPurchased: purchases.filter((p) => p.status !== "CANCELLED").reduce((a, p) => a + Number(p.total), 0) })),
  };
});

export const POST = apiHandler(async (req) => {
  const user = await requireStaff("suppliers.write");
  const s = await prisma.supplier.create({ data: await parseBody(req, supplierSchema) });
  await audit(user.id, "supplier.create", "Supplier", s.id, { name: s.name });
  return s;
});
