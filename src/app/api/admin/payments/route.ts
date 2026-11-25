import type { Prisma } from "@prisma/client";
import { apiHandler, parseQuery, paginate } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { parseDateInput, addDays } from "@/lib/date";
import { adminPaymentsQuerySchema } from "@/lib/validators";

/** GET /api/admin/payments – unified payment management ledger across KHQR, USDT, PayPal, Cash */
export const GET = apiHandler(async (req) => {
  await requireStaff("payments.read");
  const p = parseQuery(req, adminPaymentsQuerySchema);
  const pg = paginate(p.page, p.pageSize ?? 25);
  const where: Prisma.PaymentWhereInput = {};
  if (p.status) where.status = p.status;
  if (p.method) where.method = { code: p.method };
  if (p.from || p.to) where.createdAt = { ...(p.from ? { gte: parseDateInput(p.from) } : {}), ...(p.to ? { lt: addDays(parseDateInput(p.to), 1) } : {}) };
  if (p.q) where.OR = [
    { reference: { contains: p.q, mode: "insensitive" } }, { providerTxnId: { contains: p.q, mode: "insensitive" } },
    { providerRef: { contains: p.q, mode: "insensitive" } }, { order: { number: { contains: p.q, mode: "insensitive" } } },
    { order: { fullName: { contains: p.q, mode: "insensitive" } } },
  ];
  const [total, items, summary] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({
      where, orderBy: { createdAt: "desc" }, skip: pg.skip, take: pg.take,
      select: { id: true, reference: true, status: true, currency: true, amount: true, amountUsd: true, network: true, providerTxnId: true, paidAt: true, createdAt: true, method: { select: { code: true, nameEn: true } }, order: { select: { id: true, number: true, fullName: true, channel: true } } },
    }),
    prisma.payment.groupBy({ by: ["status"], _count: true, _sum: { amountUsd: true } }),
  ]);
  return {
    total, page: pg.page, pageSize: pg.pageSize, items,
    summary: Object.fromEntries(summary.map((s) => [s.status, { count: s._count, amountUsd: Number(s._sum.amountUsd ?? 0) }])),
  };
});
