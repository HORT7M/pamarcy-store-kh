import { apiHandler, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { staffCreateSchema } from "@/lib/validators";
import { ADMIN_STAFF_EMPLOYEE_WRITE_FIELDS, ADMIN_STAFF_USER_WRITE_FIELDS, pickAllowed } from "@/lib/allowlist";
import { hashPassword } from "@/lib/auth/password";
import { audit } from "@/lib/audit";
import { conflict, forbidden } from "@/lib/errors";

export const GET = apiHandler(async () => {
  await requireStaff("users.manage");
  const items = await prisma.user.findMany({ where: { role: { isStaff: true }, deletedAt: null }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, email: true, phone: true, status: true, lastLoginAt: true, createdAt: true, role: { select: { key: true, name: true } }, employee: { select: { employeeCode: true, position: true, licenseNo: true } } } });
  return { items };
});

export const POST = apiHandler(async (req) => {
  const me = await requireStaff("users.manage");
  const b = await parseBody(req, staffCreateSchema);
  // Defense-in-depth role hierarchy: only a SUPER_ADMIN may provision another SUPER_ADMIN
  if (b.role === "SUPER_ADMIN" && me.role !== "SUPER_ADMIN") {
    throw forbidden("Only a Super Admin can assign the Super Admin role");
  }
  const userFields = pickAllowed(b, ADMIN_STAFF_USER_WRITE_FIELDS);
  const empFields = pickAllowed(b, ADMIN_STAFF_EMPLOYEE_WRITE_FIELDS);

  const dup = await prisma.user.findFirst({ where: { OR: [{ email: userFields.email }, ...(userFields.phone ? [{ phone: userFields.phone }] : [])] }, select: { id: true } });
  if (dup) throw conflict("Email or phone already in use");
  const role = await prisma.role.findUniqueOrThrow({ where: { key: b.role } });
  if (!role.isStaff) throw forbidden("Staff accounts must use a staff role");
  const count = await prisma.employee.count();
  const u = await prisma.user.create({
    data: {
      ...userFields,
      passwordHash: await hashPassword(b.password),
      roleId: role.id,
      status: "ACTIVE",
      employee: {
        create: {
          employeeCode: `EMP-${String(count + 1).padStart(3, "0")}-${Date.now().toString(36).slice(-3).toUpperCase()}`,
          ...empFields,
          hiredAt: new Date(),
        },
      },
    },
  });
  await audit(me.id, "staff.create", "User", u.id, { role: b.role });
  return { id: u.id };
});
