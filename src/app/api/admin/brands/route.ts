import { apiHandler, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { brandSchema } from "@/lib/validators";
import { audit } from "@/lib/audit";
import { slugify } from "@/lib/slug";

export const GET = apiHandler(async () => {
  await requireStaff("medicines.read");
  return { items: await prisma.brand.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" }, include: { _count: { select: { medicines: { where: { deletedAt: null } } } } } }) };
});

export const POST = apiHandler(async (req) => {
  const user = await requireStaff("categories.write");
  const body = await parseBody(req, brandSchema);
  let slug = slugify(body.name);
  if (await prisma.brand.findUnique({ where: { slug } })) slug += `-${Date.now().toString(36)}`;
  const b = await prisma.brand.create({ data: { ...body, slug } });
  await audit(user.id, "brand.create", "Brand", b.id, { name: b.name });
  return b;
});
