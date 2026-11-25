import { apiHandler, parseBody, parseParams } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff, createSession, destroyAllSessions } from "@/lib/auth/session";
import { idParamSchema, staffSchema } from "@/lib/validators";
import { ADMIN_STAFF_EMPLOYEE_WRITE_FIELDS, ADMIN_STAFF_USER_WRITE_FIELDS, pickAllowed } from "@/lib/allowlist";
import { hashPassword } from "@/lib/auth/password";
import { audit } from "@/lib/audit";
import { badRequest, conflict, forbidden, notFound } from "@/lib/errors";

export const PUT = apiHandler<{ id: string }>(async (req, { params }) => {
  const me = await requireStaff("users.manage");
  const { id } = await parseParams(params, idParamSchema);
  const b = await parseBody(req, staffSchema);
  const u = await prisma.user.findUnique({ where: { id }, include: { role: true } });
  if (!u || u.deletedAt || !u.role.isStaff) throw notFound();

  // Defense-in-depth role hierarchy: only a SUPER_ADMIN may modify a SUPER_ADMIN or assign SUPER_ADMIN
  if (me.role !== "SUPER_ADMIN" && (u.role.key === "SUPER_ADMIN" || b.role === "SUPER_ADMIN")) {
    throw forbidden("Only a Super Admin can manage Super Admin accounts");
  }
  if (id === me.id && (b.role !== u.role.key || b.status === "SUSPENDED")) {
    throw badRequest("You cannot change your own role or suspend yourself");
  }

  const userFields = pickAllowed(b, ADMIN_STAFF_USER_WRITE_FIELDS);
  const empFields = pickAllowed(b, ADMIN_STAFF_EMPLOYEE_WRITE_FIELDS);

  const dup = await prisma.user.findFirst({
    where: {
      id: { not: id },
      OR: [{ email: userFields.email }, ...(userFields.phone ? [{ phone: userFields.phone }] : [])],
    },
    select: { id: true },
  });
  if (dup) throw conflict("Email or phone already in use");

  const role = await prisma.role.findUniqueOrThrow({ where: { key: b.role } });
  if (!role.isStaff) throw forbidden("Staff accounts must use a staff role");
  const newPasswordHash = b.password ? await hashPassword(b.password) : undefined;

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${id} FOR UPDATE`;
    if (u.role.key === "SUPER_ADMIN" && (b.role !== "SUPER_ADMIN" || b.status === "SUSPENDED")) {
      const supers = await tx.user.count({ where: { role: { key: "SUPER_ADMIN" }, status: "ACTIVE", deletedAt: null } });
      if (supers <= 1) throw conflict("At least one active Super Admin is required");
    }
    await tx.user.update({
      where: { id },
      data: {
        ...userFields,
        roleId: role.id,
        ...(b.status !== undefined ? { status: b.status } : {}),
        ...(newPasswordHash ? { passwordHash: newPasswordHash } : {}),
        employee: {
          upsert: {
            update: empFields,
            create: { employeeCode: `EMP-${Date.now().toString(36).toUpperCase()}`, ...empFields },
          },
        },
      },
    });
  });

  if (b.status === "SUSPENDED" || b.password || b.role !== u.role.key || userFields.email !== u.email) {
    await prisma.passwordResetToken.deleteMany({ where: { userId: id } });
    await destroyAllSessions(id);
    if (id === me.id && b.status !== "SUSPENDED") {
      await createSession(me.id, true);
    }
  }
  await audit(me.id, "staff.update", "User", id, { role: b.role, status: b.status ?? null, passwordReset: !!b.password });
  return { ok: true };
});
