import { apiHandler, parseBody, parseParams } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { discountSchema, idParamSchema } from "@/lib/validators";
import { DISCOUNT_WRITE_FIELDS, pickAllowed } from "@/lib/allowlist";
import { audit } from "@/lib/audit";
import { parseDateInput, addDays } from "@/lib/date";
import { notFound } from "@/lib/errors";

export const PUT = apiHandler<{ id: string }>(async (req, { params }) => {
  const user = await requireStaff("discounts.write");
  const { id } = await parseParams(params, idParamSchema);
  const existing = await prisma.discount.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
  if (!existing) throw notFound("Discount not found");
  const b = await parseBody(req, discountSchema);
  const allowed = pickAllowed(b, DISCOUNT_WRITE_FIELDS);
  const d = await prisma.discount.update({
    where: { id },
    data: {
      ...allowed,
      startsAt: b.startsAt ? parseDateInput(b.startsAt) : null,
      endsAt: b.endsAt ? addDays(parseDateInput(b.endsAt), 1) : null,
    },
  });
  await audit(user.id, "discount.update", "Discount", id, { code: d.code });
  return d;
});

export const DELETE = apiHandler<{ id: string }>(async (_req, { params }) => {
  const user = await requireStaff("discounts.write");
  const { id } = await parseParams(params, idParamSchema);
  const d = await prisma.discount.findFirst({ where: { id, deletedAt: null } });
  if (!d) throw notFound("Discount not found");
  await prisma.discount.update({ where: { id }, data: { deletedAt: new Date(), isActive: false, code: `${d.code}~del-${Date.now().toString(36)}` } });
  await audit(user.id, "discount.delete", "Discount", id, { code: d.code });
  return { ok: true };
});
