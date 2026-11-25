import type { Prisma } from "@prisma/client";
import { apiHandler, parseQuery, paginate } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { adminCustomersQuerySchema } from "@/lib/validators";

export const GET = apiHandler(async (req) => {
  await requireStaff("customers.read");
  const p = parseQuery(req, adminCustomersQuerySchema);
  const pg = paginate(p.page, p.pageSize);
  const where: Prisma.CustomerWhereInput = { user: { deletedAt: null, ...(p.status ? { status: p.status } : {}) } };
  if (p.q) where.OR = [{ user: { name: { contains: p.q, mode: "insensitive" } } }, { user: { email: { contains: p.q, mode: "insensitive" } } }, { user: { phone: { contains: p.q.replace(/^0/, "") } } }];
  const [total, items] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({ where, orderBy: { createdAt: "desc" }, skip: pg.skip, take: pg.take, select: { id: true, user: { select: { name: true, email: true, phone: true, status: true, lastLoginAt: true, createdAt: true } }, orders: { where: { paymentStatus: "PAID" }, select: { total: true } }, _count: { select: { orders: true } } } }),
  ]);
  return { total, page: pg.page, pageSize: pg.pageSize, items: items.map(({ orders, ...c }) => ({ ...c, spent: orders.reduce((a, o) => a + Number(o.total), 0) })) };
});
