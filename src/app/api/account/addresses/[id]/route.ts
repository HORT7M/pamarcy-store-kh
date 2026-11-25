import { apiHandler, parseBody, parseParams } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireCustomer } from "@/lib/auth/session";
import { addressSchema, idParamSchema } from "@/lib/validators";
import { notFound } from "@/lib/errors";
import { addressSelect } from "@/lib/public-select";

async function own(id: string, customerId: string) {
  const a = await prisma.address.findUnique({ where: { id } });
  if (!a || a.customerId !== customerId) throw notFound("Address not found");
  return a;
}

export const PUT = apiHandler<{ id: string }>(async (req, { params }) => {
  const { id } = await parseParams(params, idParamSchema);
  const u = await requireCustomer();
  await own(id, u.customerId);
  const body = await parseBody(req, addressSchema);
  return prisma.$transaction(async (tx) => {
    if (body.isDefault) await tx.address.updateMany({ where: { customerId: u.customerId }, data: { isDefault: false } });
    return tx.address.update({ where: { id }, data: body, select: addressSelect });
  });
});

export const DELETE = apiHandler<{ id: string }>(async (_req, { params }) => {
  const { id } = await parseParams(params, idParamSchema);
  const u = await requireCustomer();
  const a = await own(id, u.customerId);
  await prisma.address.delete({ where: { id } });
  if (a.isDefault) {
    const next = await prisma.address.findFirst({ where: { customerId: u.customerId }, orderBy: { createdAt: "desc" } });
    if (next) await prisma.address.update({ where: { id: next.id }, data: { isDefault: true } });
  }
  return { ok: true };
});
