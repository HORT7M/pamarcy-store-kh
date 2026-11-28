import { apiHandler, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { discountSchema } from "@/lib/validators";
import { DISCOUNT_WRITE_FIELDS, pickAllowed } from "@/lib/allowlist";
import { audit } from "@/lib/audit";
import { parseDateInput, addDays } from "@/lib/date";

export const GET = apiHandler(async () => {
  await requireStaff("discounts.write");
  return { items: await prisma.discount.findMany({ where: { deletedAt: null }, orderBy: { createdAt: "desc" } }) };
});

export const POST = apiHandler(async (req) => {
  const user = await requireStaff("discounts.write");
  const b = await parseBody(req, discountSchema);
  const allowed = pickAllowed(b, DISCOUNT_WRITE_FIELDS);
  const d = await prisma.discount.create({
    data: {
      ...allowed,
      startsAt: b.startsAt ? parseDateInput(b.startsAt) : null,
      endsAt: b.endsAt ? new Date(addDays(parseDateInput(b.endsAt), 1).getTime() - 1) : null,
    },
  });
  await audit(user.id, "discount.create", "Discount", d.id, { code: d.code });
  return d;
});
