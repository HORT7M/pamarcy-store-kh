import { apiHandler, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { staffSchema } from "@/lib/validators";
import { hashPassword } from "@/lib/auth/password";
import { audit } from "@/lib/audit";
import { badRequest, conflict } from "@/lib/errors";

export const GET = apiHandler(async () => {
  await requireStaff("users.manage");
  const items = await prisma.user.findMany({ where: { role: { isStaff: true }, deletedAt: null }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, email: true, phone: true, status: true, lastLoginAt: true, createdAt: true, role: { select: { key: true, name: true } }, employee: { select: { employeeCode: true, position: true, licenseNo: true } } } });
  return { items };
});

export const POST = apiHandler(async (req) => {
  const me = await requireStaff("users.manage");
  const b = await parseBody(req, staffSchema);
  if (!b.password) throw badRequest("Password is required");
  const dup = await prisma.user.findFirst({ where: { OR: [{ email: b.email }, ...(b.phone ? [{ phone: b.phone }] : [])] } });
  if (dup) throw conflict("Email or phone already in use");
  const role = await prisma.role.findUniqueOrThrow({ where: { key: b.role } });
  const count = await prisma.employee.count();
  const u = await prisma.user.create({
    data: { name: b.name, email: b.email, phone: b.phone, passwordHash: await hashPassword(b.password), roleId: role.id, employee: { create: { employeeCode: `EMP-${String(count + 1).padStart(3, "0")}-${Date.now().toString(36).slice(-3).toUpperCase()}`, position: b.position, licenseNo: b.licenseNo, hiredAt: new Date() } } },
  });
  await audit(me.id, "staff.create", "User", u.id, { email: u.email, role: b.role });
  return { id: u.id };
});
