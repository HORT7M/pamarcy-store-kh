import { apiHandler, parseBody, parseParams } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { idParamSchema, supplierSchema } from "@/lib/validators";
import { pickAllowed, SUPPLIER_WRITE_FIELDS } from "@/lib/allowlist";
import { audit } from "@/lib/audit";
import { conflict, notFound } from "@/lib/errors";

export const GET = apiHandler<{ id: string }>(async (_req, { params }) => {
  await requireStaff("suppliers.read");
  const { id } = await parseParams(params, idParamSchema);
  const s = await prisma.supplier.findFirst({
    where: { id, deletedAt: null },
    include: { purchases: { orderBy: { orderedAt: "desc" }, include: { _count: { select: { items: true } } } }, batches: { take: 50, orderBy: { receivedAt: "desc" }, include: { medicine: { select: { nameEn: true, sku: true } } } } },
  });
  if (!s) throw notFound();
  return s;
});

export const PUT = apiHandler<{ id: string }>(async (req, { params }) => {
  const user = await requireStaff("suppliers.write");
  const { id } = await parseParams(params, idParamSchema);
  const existing = await prisma.supplier.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
  if (!existing) throw notFound("Supplier not found");
  const body = await parseBody(req, supplierSchema);
  const s = await prisma.supplier.update({ where: { id }, data: pickAllowed(body, SUPPLIER_WRITE_FIELDS) });
  await audit(user.id, "supplier.update", "Supplier", id);
  return s;
});

export const DELETE = apiHandler<{ id: string }>(async (_req, { params }) => {
  const user = await requireStaff("suppliers.write");
  const { id } = await parseParams(params, idParamSchema);
  const existing = await prisma.supplier.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
  if (!existing) throw notFound("Supplier not found");
  const open = await prisma.purchase.count({ where: { supplierId: id, status: { in: ["ORDERED", "PARTIALLY_RECEIVED", "DRAFT"] } } });
  if (open) throw conflict("Supplier has open purchase orders");
  await prisma.supplier.update({ where: { id }, data: { deletedAt: new Date() } });
  await audit(user.id, "supplier.delete", "Supplier", id);
  return { ok: true };
});
