import { apiHandler, parseBody, parseParams } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireCustomer } from "@/lib/auth/session";
import { addressSchema, idParamSchema } from "@/lib/validators";
import { ADDRESS_WRITE_FIELDS, pickAllowed } from "@/lib/allowlist";
import { notFound } from "@/lib/errors";
import { addressSelect } from "@/lib/public-select";

export const PUT = apiHandler<{ id: string }>(async (req, { params }) => {
  const { id } = await parseParams(params, idParamSchema);
  const u = await requireCustomer();
  const body = await parseBody(req, addressSchema);
  const allowed = pickAllowed(body, ADDRESS_WRITE_FIELDS);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.address.findFirst({ where: { id, customerId: u.customerId }, select: { id: true } });
    if (!existing) throw notFound("Address not found");
    if (allowed.isDefault) {
      await tx.address.updateMany({ where: { customerId: u.customerId }, data: { isDefault: false } });
    }
    return tx.address.update({
      where: { id: existing.id, customerId: u.customerId },
      data: allowed,
      select: addressSelect,
    });
  });
});

export const DELETE = apiHandler<{ id: string }>(async (_req, { params }) => {
  const { id } = await parseParams(params, idParamSchema);
  const u = await requireCustomer();
  await prisma.$transaction(async (tx) => {
    const existing = await tx.address.findFirst({ where: { id, customerId: u.customerId }, select: { id: true, isDefault: true } });
    if (!existing) throw notFound("Address not found");
    const del = await tx.address.deleteMany({ where: { id: existing.id, customerId: u.customerId } });
    if (del.count !== 1) throw notFound("Address not found");
    if (existing.isDefault) {
      const next = await tx.address.findFirst({ where: { customerId: u.customerId }, orderBy: { createdAt: "desc" }, select: { id: true } });
      if (next) {
        await tx.address.update({ where: { id: next.id, customerId: u.customerId }, data: { isDefault: true } });
      }
    }
  });
  return { ok: true };
});
