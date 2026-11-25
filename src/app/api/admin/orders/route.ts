import type { Prisma } from "@prisma/client";
import { apiHandler, parseQuery, paginate } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { parseDateInput, addDays } from "@/lib/date";
import { adminOrdersQuerySchema } from "@/lib/validators";

export const GET = apiHandler(async (req) => {
  await requireStaff("orders.read");
  const p = parseQuery(req, adminOrdersQuerySchema);
  const pg = paginate(p.page, p.pageSize);
  const where: Prisma.OrderWhereInput = {};
  if (p.status) where.status = p.status;
  if (p.payment) where.paymentStatus = p.payment;
  if (p.channel) where.channel = p.channel;
  if (p.rx) where.prescriptionStatus = "PENDING_REVIEW";
  if (p.from || p.to) where.createdAt = { ...(p.from ? { gte: parseDateInput(p.from) } : {}), ...(p.to ? { lt: addDays(parseDateInput(p.to), 1) } : {}) };
  if (p.q) where.OR = [{ number: { contains: p.q, mode: "insensitive" } }, { fullName: { contains: p.q, mode: "insensitive" } }, { phone: { contains: p.q.replace(/^0/, "") } }, { email: { contains: p.q, mode: "insensitive" } }];
  const [total, items, counts] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({ where, orderBy: { createdAt: "desc" }, skip: pg.skip, take: pg.take, select: { id: true, number: true, channel: true, fullName: true, phone: true, total: true, status: true, paymentStatus: true, fulfillmentStatus: true, prescriptionStatus: true, createdAt: true, _count: { select: { items: true } }, payments: { where: { status: { in: ["PAID", "PENDING", "PROCESSING"] } }, select: { method: { select: { code: true } }, status: true }, take: 1, orderBy: { createdAt: "desc" } } } }),
    prisma.order.groupBy({ by: ["status"], _count: true }),
  ]);
  return { total, page: pg.page, pageSize: pg.pageSize, items, counts: Object.fromEntries(counts.map((c) => [c.status, c._count])) };
});
