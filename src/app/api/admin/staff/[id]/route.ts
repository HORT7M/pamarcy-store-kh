import { apiHandler, parseBody, parseParams } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff, createSession, destroyAllSessions } from "@/lib/auth/session";
import { idParamSchema, staffSchema } from "@/lib/validators";
import { hashPassword } from "@/lib/auth/password";
import { audit } from "@/lib/audit";
import { badRequest, conflict, notFound } from "@/lib/errors";

export const PUT = apiHandler<{ id: string }>(async (req, { params }) => {
  const me = await requireStaff("users.manage");
  const { id } = await parseParams(params, idParamSchema);
  const b = await parseBody(req, staffSchema);
  const u = await prisma.user.findUnique({ where: { id }, include: { role: true } });
  if (!u || !u.role.isStaff) throw notFound();
  if (id === me.id && (b.role !== u.role.key || b.status === "SUSPENDED")) throw badRequest("You cannot change your own role or suspend yourself");
  if (u.role.key === "SUPER_ADMIN" && (b.role !== "SUPER_ADMIN" || b.status === "SUSPENDED")) {
    const supers = await prisma.user.count({ where: { role: { key: "SUPER_ADMIN" }, status: "ACTIVE", deletedAt: null } });
    if (supers <= 1) throw conflict("At least one active Super Admin is required");
  }
  const role = await prisma.role.findUniqueOrThrow({ where: { key: b.role } });
  await prisma.user.update({
    where: { id },
    data: {
      name: b.name, email: b.email, phone: b.phone, roleId: role.id, status: b.status, ...(b.password ? { passwordHash: await hashPassword(b.password) } : {}),
      employee: { upsert: { update: { position: b.position, licenseNo: b.licenseNo }, create: { employeeCode: `EMP-${Date.now().toString(36).toUpperCase()}`, position: b.position, licenseNo: b.licenseNo } } },
    },
  });
  if (b.status === "SUSPENDED" || b.password || b.role !== u.role.key || b.email !== u.email) {
    await destroyAllSessions(id);
    if (id === me.id && b.status !== "SUSPENDED") {
      await createSession(me.id, true);
    }
  }
  await audit(me.id, "staff.update", "User", id, { role: b.role, status: b.status ?? null, passwordReset: !!b.password });
  return { ok: true };
});
