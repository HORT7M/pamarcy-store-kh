import { apiHandler, parseParams } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { conflict, notFound } from "@/lib/errors";
import { idParamSchema } from "@/lib/validators";

export const GET = apiHandler<{ id: string }>(async (_req, { params }) => {
  await requireStaff("purchases.read");
  const { id } = await parseParams(params, idParamSchema);
  const p = await prisma.purchase.findUnique({ where: { id }, include: { supplier: true, items: { include: { medicine: { select: { nameEn: true, nameKm: true, sku: true, tracksExpiry: true } }, batches: true } } } });
  if (!p) throw notFound();
  return p;
});

/** DELETE = cancel a purchase order that has not received any stock */
export const DELETE = apiHandler<{ id: string }>(async (_req, { params }) => {
  const user = await requireStaff("purchases.write");
  const { id } = await parseParams(params, idParamSchema);
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Purchase" WHERE id = ${id} FOR UPDATE`;
    const p = await tx.purchase.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!p) throw notFound();
    if (p.status !== "ORDERED" && p.status !== "DRAFT") {
      throw conflict("Only purchase orders with no received stock can be cancelled");
    }
    await tx.purchase.update({ where: { id }, data: { status: "CANCELLED" } });
  });
  await audit(user.id, "purchase.cancel", "Purchase", id);
  return { ok: true };
});
