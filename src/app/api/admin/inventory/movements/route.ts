import type { Prisma } from "@prisma/client";
import { apiHandler, parseQuery, paginate } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { adminMovementsQuerySchema } from "@/lib/validators";

export const GET = apiHandler(async (req) => {
  await requireStaff("inventory.read");
  const p = parseQuery(req, adminMovementsQuerySchema);
  const pg = paginate(p.page, p.pageSize ?? 30);
  const where: Prisma.StockMovementWhereInput = { type: { not: "RESERVE" } };
  if (p.medicineId) where.medicineId = p.medicineId;
  if (p.type) where.type = p.type;
  else where.type = { notIn: ["RESERVE", "RELEASE"] };
  if (p.q) where.OR = [{ reference: { contains: p.q, mode: "insensitive" } }, { medicine: { nameEn: { contains: p.q, mode: "insensitive" } } }, { medicine: { sku: { contains: p.q, mode: "insensitive" } } }];
  const [total, items] = await Promise.all([
    prisma.stockMovement.count({ where }),
    prisma.stockMovement.findMany({ where, orderBy: { createdAt: "desc" }, skip: pg.skip, take: pg.take, include: { medicine: { select: { nameEn: true, sku: true } }, batch: { select: { batchNumber: true } } } }),
  ]);
  const userIds = [...new Set(items.map((i) => i.userId).filter(Boolean))] as string[];
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
  return { total, page: pg.page, pageSize: pg.pageSize, items: items.map(({ userId, ...i }) => ({ ...i, userName: users.find((u) => u.id === userId)?.name ?? null })) };
});
