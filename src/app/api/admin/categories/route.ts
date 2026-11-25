import { apiHandler, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { categorySchema } from "@/lib/validators";
import { audit } from "@/lib/audit";
import { slugify } from "@/lib/slug";

export const GET = apiHandler(async () => {
  await requireStaff("medicines.read");
  return { items: await prisma.category.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: "asc" }, include: { _count: { select: { medicines: { where: { deletedAt: null } } } } } }) };
});

export const POST = apiHandler(async (req) => {
  const user = await requireStaff("categories.write");
  const body = await parseBody(req, categorySchema);
  const c = await prisma.category.create({ data: { ...body, slug: body.slug ?? slugify(body.nameEn) } });
  await audit(user.id, "category.create", "Category", c.id, { name: c.nameEn });
  return c;
});
