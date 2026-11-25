import { apiHandler, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/session";
import { profileSchema } from "@/lib/validators";
import { conflict } from "@/lib/errors";

export const GET = apiHandler(async () => {
  const u = await requireUser();
  return prisma.user.findUniqueOrThrow({ where: { id: u.id }, select: { id: true, name: true, email: true, phone: true, locale: true, createdAt: true } });
});

export const PATCH = apiHandler(async (req) => {
  const u = await requireUser();
  const body = await parseBody(req, profileSchema);
  const taken = await prisma.user.findFirst({ where: { phone: body.phone, id: { not: u.id } } });
  if (taken) throw conflict("Phone number is already used by another account");
  return prisma.user.update({ where: { id: u.id }, data: body, select: { id: true, name: true, phone: true, locale: true } });
});
