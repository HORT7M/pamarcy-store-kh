import type { Prisma } from "@prisma/client";
import { apiHandler, parseQuery, paginate } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { parseDateInput, addDays } from "@/lib/date";
import { adminOrdersQuerySchema } from "@/lib/validators";

const orderListSelect = {
  id: true,
  number: true,
  channel: true,
  fullName: true,
  phone: true,
  email: true,
  total: true,
  status: true,
  paymentStatus: true,
  fulfillmentStatus: true,
  prescriptionStatus: true,
  createdAt: true,
  _count: { select: { items: true } },
  payments: {
    where: { status: { in: ["PAID", "PENDING", "PROCESSING"] as ("PAID" | "PENDING" | "PROCESSING")[] } },
    select: { method: { select: { code: true } }, status: true },
    take: 1,
    orderBy: { createdAt: "desc" as const },
  },
} as const;

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

  if (p.q) {
    // Order contact fields (fullName, phone, email) are AES-256-GCM encrypted at rest
    const needle = p.q.trim().toLowerCase();
    const phoneNeedle = p.q.trim().replace(/^0/, "").toLowerCase();
    const [all, counts] = await Promise.all([
      prisma.order.findMany({ where, orderBy: { createdAt: "desc" }, take: 2000, select: orderListSelect }),
      prisma.order.groupBy({ by: ["status"], _count: true }),
    ]);
    const matched = all.filter((o) =>
      o.number.toLowerCase().includes(needle) ||
      o.fullName.toLowerCase().includes(needle) ||
      o.phone.toLowerCase().includes(phoneNeedle) ||
      (o.email?.toLowerCase().includes(needle) ?? false),
    );
    const items = matched.slice(pg.skip, pg.skip + pg.take).map(({ email: _e, ...rest }) => { void _e; return rest; });
    return { total: matched.length, page: pg.page, pageSize: pg.pageSize, items, counts: Object.fromEntries(counts.map((c) => [c.status, c._count])) };
  }

  const [total, rawItems, counts] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({ where, orderBy: { createdAt: "desc" }, skip: pg.skip, take: pg.take, select: orderListSelect }),
    prisma.order.groupBy({ by: ["status"], _count: true }),
  ]);
  const items = rawItems.map(({ email: _e, ...rest }) => { void _e; return rest; });
  return { total, page: pg.page, pageSize: pg.pageSize, items, counts: Object.fromEntries(counts.map((c) => [c.status, c._count])) };
});
