import type { Prisma } from "@prisma/client";
import { apiHandler, parseQuery, paginate } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { parseDateInput, addDays } from "@/lib/date";
import { adminPaymentsQuerySchema } from "@/lib/validators";

const paymentListSelect = {
  id: true,
  reference: true,
  providerRef: true,
  status: true,
  currency: true,
  amount: true,
  amountUsd: true,
  network: true,
  providerTxnId: true,
  paidAt: true,
  createdAt: true,
  method: { select: { code: true, nameEn: true } },
  order: { select: { id: true, number: true, fullName: true, channel: true } },
} as const;

/** GET /api/admin/payments – unified payment management ledger across KHQR, USDT, PayPal, Cash */
export const GET = apiHandler(async (req) => {
  await requireStaff("payments.read");
  const p = parseQuery(req, adminPaymentsQuerySchema);
  const pg = paginate(p.page, p.pageSize ?? 25);
  const where: Prisma.PaymentWhereInput = {};
  if (p.status) where.status = p.status;
  if (p.method) where.method = { code: p.method };
  if (p.from || p.to) where.createdAt = { ...(p.from ? { gte: parseDateInput(p.from) } : {}), ...(p.to ? { lt: addDays(parseDateInput(p.to), 1) } : {}) };

  if (p.q) {
    // Order.fullName is AES-256-GCM encrypted at rest; filter decrypted rows safely
    const needle = p.q.trim().toLowerCase();
    const [all, summary] = await Promise.all([
      prisma.payment.findMany({ where, orderBy: { createdAt: "desc" }, take: 2000, select: paymentListSelect }),
      prisma.payment.groupBy({ by: ["status"], _count: true, _sum: { amountUsd: true } }),
    ]);
    const matched = all.filter((x) =>
      x.reference.toLowerCase().includes(needle) ||
      (x.providerTxnId?.toLowerCase().includes(needle) ?? false) ||
      (x.providerRef?.toLowerCase().includes(needle) ?? false) ||
      x.order.number.toLowerCase().includes(needle) ||
      x.order.fullName.toLowerCase().includes(needle),
    );
    const items = matched.slice(pg.skip, pg.skip + pg.take).map(({ providerRef: _r, ...rest }) => { void _r; return rest; });
    return {
      total: matched.length,
      page: pg.page,
      pageSize: pg.pageSize,
      items,
      summary: Object.fromEntries(summary.map((s) => [s.status, { count: s._count, amountUsd: Number(s._sum.amountUsd ?? 0) }])),
    };
  }

  const [total, rawItems, summary] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({ where, orderBy: { createdAt: "desc" }, skip: pg.skip, take: pg.take, select: paymentListSelect }),
    prisma.payment.groupBy({ by: ["status"], _count: true, _sum: { amountUsd: true } }),
  ]);
  const items = rawItems.map(({ providerRef: _r, ...rest }) => { void _r; return rest; });
  return {
    total, page: pg.page, pageSize: pg.pageSize, items,
    summary: Object.fromEntries(summary.map((s) => [s.status, { count: s._count, amountUsd: Number(s._sum.amountUsd ?? 0) }])),
  };
});
