import { apiHandler, parseBody, parseParams } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { brandSchema, idParamSchema } from "@/lib/validators";
import { BRAND_WRITE_FIELDS, pickAllowed } from "@/lib/allowlist";
import { audit } from "@/lib/audit";
import { conflict, notFound } from "@/lib/errors";

export const PUT = apiHandler<{ id: string }>(async (req, { params }) => {
  const user = await requireStaff("categories.write");
  const { id } = await parseParams(params, idParamSchema);
  const existing = await prisma.brand.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
  if (!existing) throw notFound("Brand not found");
  const body = await parseBody(req, brandSchema);
  const b = await prisma.brand.update({ where: { id }, data: pickAllowed(body, BRAND_WRITE_FIELDS) });
  await audit(user.id, "brand.update", "Brand", id);
  return b;
});

export const DELETE = apiHandler<{ id: string }>(async (_req, { params }) => {
  const user = await requireStaff("categories.write");
  const { id } = await parseParams(params, idParamSchema);
  const existing = await prisma.brand.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
  if (!existing) throw notFound("Brand not found");
  const inUse = await prisma.medicine.count({ where: { brandId: id, deletedAt: null } });
  if (inUse) throw conflict(`Brand is used by ${inUse} medicine(s)`);
  await prisma.brand.update({ where: { id }, data: { deletedAt: new Date(), slug: `deleted-${Date.now()}-${id.slice(-4)}` } });
  await audit(user.id, "brand.delete", "Brand", id);
  return { ok: true };
});
