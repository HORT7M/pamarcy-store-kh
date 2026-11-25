import type { Prisma } from "@prisma/client";
import { apiHandler, parseQuery, paginate } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { adminCustomersQuerySchema } from "@/lib/validators";

const customerSelect = {
  id: true,
  user: { select: { name: true, email: true, phone: true, status: true, lastLoginAt: true, createdAt: true } },
  orders: { where: { paymentStatus: "PAID" as const }, select: { total: true } },
  _count: { select: { orders: true } },
} as const;

export const GET = apiHandler(async (req) => {
  await requireStaff("customers.read");
  const p = parseQuery(req, adminCustomersQuerySchema);
  const pg = paginate(p.page, p.pageSize);
  const where: Prisma.CustomerWhereInput = { user: { deletedAt: null, role: { isStaff: false }, ...(p.status ? { status: p.status } : {}) } };

  if (p.q) {
    // User PII (name, email, phone) is AES-256-GCM encrypted at rest; filter decrypted rows safely
    const needle = p.q.trim().toLowerCase();
    const phoneNeedle = p.q.trim().replace(/^0/, "").toLowerCase();
    const all = await prisma.customer.findMany({ where, orderBy: { createdAt: "desc" }, take: 2000, select: customerSelect });
    const matched = all.filter((c) =>
      c.user.name.toLowerCase().includes(needle) ||
      c.user.email.toLowerCase().includes(needle) ||
      (c.user.phone?.toLowerCase().includes(phoneNeedle) ?? false),
    );
    const slice = matched.slice(pg.skip, pg.skip + pg.take);
    return {
      total: matched.length,
      page: pg.page,
      pageSize: pg.pageSize,
      items: slice.map(({ orders, ...c }) => ({ ...c, spent: orders.reduce((a, o) => a + Number(o.total), 0) })),
    };
  }

  const [total, items] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({ where, orderBy: { createdAt: "desc" }, skip: pg.skip, take: pg.take, select: customerSelect }),
  ]);
  return { total, page: pg.page, pageSize: pg.pageSize, items: items.map(({ orders, ...c }) => ({ ...c, spent: orders.reduce((a, o) => a + Number(o.total), 0) })) };
});
