import { apiHandler, parseBody, parseParams } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { bannerSchema, idParamSchema } from "@/lib/validators";
import { audit } from "@/lib/audit";

export const PUT = apiHandler<{ id: string }>(async (req, { params }) => {
  const user = await requireStaff("discounts.write");
  const { id } = await parseParams(params, idParamSchema);
  const b = await prisma.banner.update({ where: { id }, data: await parseBody(req, bannerSchema) });
  await audit(user.id, "banner.update", "Banner", id);
  return b;
});

export const DELETE = apiHandler<{ id: string }>(async (_req, { params }) => {
  const user = await requireStaff("discounts.write");
  const { id } = await parseParams(params, idParamSchema);
  await prisma.banner.delete({ where: { id } });
  await audit(user.id, "banner.delete", "Banner", id);
  return { ok: true };
});
