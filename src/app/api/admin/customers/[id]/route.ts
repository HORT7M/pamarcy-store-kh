import { apiHandler, parseBody, parseParams } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff, destroyAllSessions } from "@/lib/auth/session";
import { customerUpdateSchema, idParamSchema } from "@/lib/validators";
import { audit } from "@/lib/audit";
import { conflict, notFound } from "@/lib/errors";

export const GET = apiHandler<{ id: string }>(async (_req, { params }) => {
  await requireStaff("customers.read");
  const { id } = await parseParams(params, idParamSchema);
  const c = await prisma.customer.findUnique({
    where: { id },
    include: { user: { select: { id: true, name: true, email: true, phone: true, status: true, lastLoginAt: true, createdAt: true } }, addresses: true, orders: { orderBy: { createdAt: "desc" }, include: { items: true } } },
  });
  if (!c) throw notFound();
  const topItems = await prisma.orderItem.groupBy({ by: ["medicineId", "nameEn"], where: { order: { customerId: id, paymentStatus: "PAID" } }, _sum: { quantity: true, lineTotal: true }, orderBy: { _sum: { quantity: "desc" } }, take: 10 });
  return { ...c, topItems };
});

export const PATCH = apiHandler<{ id: string }>(async (req, { params }) => {
  const staff = await requireStaff("customers.write");
  const { id } = await parseParams(params, idParamSchema);
  const b = await parseBody(req, customerUpdateSchema);
  const c = await prisma.customer.findUnique({ where: { id }, include: { user: { select: { email: true } } } });
  if (!c) throw notFound();
  if (b.email || b.phone) {
    const dup = await prisma.user.findFirst({ where: { id: { not: c.userId }, OR: [b.email ? { email: b.email } : {}, b.phone ? { phone: b.phone } : {}].filter((x) => Object.keys(x).length) } });
    if (dup) throw conflict("Email or phone already used by another account");
  }
  await prisma.user.update({ where: { id: c.userId }, data: { name: b.name, phone: b.phone, email: b.email, status: b.status } });
  if (b.notes !== undefined) await prisma.customer.update({ where: { id }, data: { notes: b.notes } });
  if (b.status === "SUSPENDED" || (b.email && b.email !== c.user.email)) {
    await destroyAllSessions(c.userId);
  }
  await audit(staff.id, b.status ? `customer.${b.status.toLowerCase()}` : "customer.update", "Customer", id, b);
  return { ok: true };
});
