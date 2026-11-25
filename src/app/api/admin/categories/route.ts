import { apiHandler, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { categorySchema } from "@/lib/validators";
import { CATEGORY_WRITE_FIELDS, pickAllowed } from "@/lib/allowlist";
import { audit } from "@/lib/audit";
import { slugify } from "@/lib/slug";

export const GET = apiHandler(async () => {
  await requireStaff("medicines.read");
  return { items: await prisma.category.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: "asc" }, include: { _count: { select: { medicines: { where: { deletedAt: null } } } } } }) };
});

export const POST = apiHandler(async (req) => {
  const user = await requireStaff("categories.write");
  const body = await parseBody(req, categorySchema);
  const allowed = pickAllowed(body, CATEGORY_WRITE_FIELDS);
  const c = await prisma.category.create({ data: { ...allowed, slug: body.slug ?? slugify(allowed.nameEn) } });
  await audit(user.id, "category.create", "Category", c.id, { name: c.nameEn });
  return c;
});
