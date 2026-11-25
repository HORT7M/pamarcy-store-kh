import { apiHandler, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { bannerSchema } from "@/lib/validators";
import { audit } from "@/lib/audit";

export const GET = apiHandler(async () => {
  await requireStaff("discounts.write");
  return { items: await prisma.banner.findMany({ orderBy: { sortOrder: "asc" } }) };
});

export const POST = apiHandler(async (req) => {
  const user = await requireStaff("discounts.write");
  const b = await prisma.banner.create({ data: await parseBody(req, bannerSchema) });
  await audit(user.id, "banner.create", "Banner", b.id);
  return b;
});
