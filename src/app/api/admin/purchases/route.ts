import type { Prisma } from "@prisma/client";
import { apiHandler, parseBody, parseQuery, paginate } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { adminPurchasesQuerySchema, purchaseSchema } from "@/lib/validators";
import { nextNumber } from "@/lib/sequence";
import { audit } from "@/lib/audit";
import { round2 } from "@/lib/money";
import { badRequest } from "@/lib/errors";

export const GET = apiHandler(async (req) => {
  await requireStaff("purchases.read");
  const p = parseQuery(req, adminPurchasesQuerySchema);
  const pg = paginate(p.page, p.pageSize);
  const where: Prisma.PurchaseWhereInput = {};
  if (p.status) where.status = p.status;
  if (p.supplierId) where.supplierId = p.supplierId;
  if (p.q) where.OR = [{ number: { contains: p.q, mode: "insensitive" } }, { supplier: { name: { contains: p.q, mode: "insensitive" } } }];
  const [total, items] = await Promise.all([
    prisma.purchase.count({ where }),
    prisma.purchase.findMany({ where, orderBy: { orderedAt: "desc" }, skip: pg.skip, take: pg.take, include: { supplier: { select: { name: true } }, _count: { select: { items: true } } } }),
  ]);
  return { total, page: pg.page, pageSize: pg.pageSize, items };
});

export const POST = apiHandler(async (req) => {
  const user = await requireStaff("purchases.write");
  const b = await parseBody(req, purchaseSchema);
  const ids = [...new Set(b.items.map((i) => i.medicineId))];
  if (ids.length !== b.items.length) throw badRequest("Each medicine can only appear once");
  const [supplier, medsCount] = await Promise.all([
    prisma.supplier.findFirst({ where: { id: b.supplierId, deletedAt: null }, select: { id: true } }),
    prisma.medicine.count({ where: { id: { in: ids }, deletedAt: null } }),
  ]);
  if (!supplier) throw badRequest("Supplier not found");
  if (medsCount !== ids.length) throw badRequest("One or more medicines were not found");
  const items = b.items.map((i) => ({ ...i, lineTotal: round2(i.quantity * i.unitCost) }));
  const subtotal = round2(items.reduce((s, i) => s + i.lineTotal, 0));
  const po = await prisma.$transaction(async (tx) => {
    const number = await nextNumber(tx, "PO");
    return tx.purchase.create({ data: { number, supplierId: b.supplierId, notes: b.notes, shippingCost: b.shippingCost, subtotal, total: round2(subtotal + b.shippingCost), createdById: user.id, items: { create: items } } });
  });
  await audit(user.id, "purchase.create", "Purchase", po.id, { number: po.number, total: po.total.toString() });
  return po;
});
