import { apiHandler, parseBody, parseParams } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { categorySchema, idParamSchema } from "@/lib/validators";
import { audit } from "@/lib/audit";
import { conflict, notFound } from "@/lib/errors";

export const PUT = apiHandler<{ id: string }>(async (req, { params }) => {
  const user = await requireStaff("categories.write");
  const { id } = await parseParams(params, idParamSchema);
  const existing = await prisma.category.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
  if (!existing) throw notFound("Category not found");
  const body = await parseBody(req, categorySchema);
  const c = await prisma.category.update({ where: { id }, data: body });
  await audit(user.id, "category.update", "Category", id);
  return c;
});

export const DELETE = apiHandler<{ id: string }>(async (_req, { params }) => {
  const user = await requireStaff("categories.write");
  const { id } = await parseParams(params, idParamSchema);
  const existing = await prisma.category.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
  if (!existing) throw notFound("Category not found");
  const inUse = await prisma.medicine.count({ where: { categoryId: id, deletedAt: null } });
  if (inUse) throw conflict(`Category has ${inUse} medicine(s). Move them to another category first.`);
  const c = await prisma.category.update({ where: { id }, data: { deletedAt: new Date(), isActive: false, slug: `deleted-${Date.now()}-${id.slice(-4)}` } });
  await audit(user.id, "category.delete", "Category", id, { name: c.nameEn });
  return { ok: true };
});
