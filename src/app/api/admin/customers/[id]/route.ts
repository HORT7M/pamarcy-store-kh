import { apiHandler, parseBody, parseParams } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff, destroyAllSessions } from "@/lib/auth/session";
import { customerUpdateSchema, idParamSchema } from "@/lib/validators";
import { ADMIN_CUSTOMER_USER_UPDATE_FIELDS, pickAllowed } from "@/lib/allowlist";
import { audit } from "@/lib/audit";
import { conflict, notFound } from "@/lib/errors";
import { addressSelect } from "@/lib/public-select";

export const GET = apiHandler<{ id: string }>(async (_req, { params }) => {
  await requireStaff("customers.read");
  const { id } = await parseParams(params, idParamSchema);
  const c = await prisma.customer.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, name: true, email: true, phone: true, status: true, lastLoginAt: true, createdAt: true, deletedAt: true, role: { select: { isStaff: true } } } },
      addresses: { select: addressSelect },
      orders: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          number: true,
          channel: true,
          status: true,
          paymentStatus: true,
          fulfillmentStatus: true,
          prescriptionStatus: true,
          total: true,
          createdAt: true,
          items: { select: { id: true, nameEn: true, nameKm: true, sku: true, quantity: true, unitPrice: true, lineTotal: true } },
        },
      },
    },
  });
  if (!c || c.user.deletedAt || c.user.role.isStaff) throw notFound();
  const topItems = await prisma.orderItem.groupBy({ by: ["medicineId", "nameEn"], where: { order: { customerId: id, paymentStatus: "PAID" } }, _sum: { quantity: true, lineTotal: true }, orderBy: { _sum: { quantity: "desc" } }, take: 10 });
  const { deletedAt: _d, role: _r, ...safeUser } = c.user;
  void _d;
  void _r;
  return { ...c, user: safeUser, topItems };
});

export const PATCH = apiHandler<{ id: string }>(async (req, { params }) => {
  const staff = await requireStaff("customers.write");
  const { id } = await parseParams(params, idParamSchema);
  const b = await parseBody(req, customerUpdateSchema);
  const c = await prisma.customer.findUnique({
    where: { id },
    include: { user: { select: { email: true, deletedAt: true, role: { select: { isStaff: true } } } } },
  });
  // Never allow customers.write to modify soft-deleted accounts or staff/admin users
  if (!c || c.user.deletedAt || c.user.role.isStaff) throw notFound();

  const userUpdate = pickAllowed(b, ADMIN_CUSTOMER_USER_UPDATE_FIELDS, { omitUndefined: true });
  if (userUpdate.email || userUpdate.phone) {
    const orClauses = [
      ...(userUpdate.email ? [{ email: userUpdate.email }] : []),
      ...(userUpdate.phone ? [{ phone: userUpdate.phone }] : []),
    ];
    const dup = await prisma.user.findFirst({ where: { id: { not: c.userId }, OR: orClauses }, select: { id: true } });
    if (dup) throw conflict("Email or phone already used by another account");
  }

  await prisma.$transaction(async (tx) => {
    if (Object.keys(userUpdate).length > 0) {
      await tx.user.update({ where: { id: c.userId }, data: userUpdate });
    }
    if (b.notes !== undefined) {
      await tx.customer.update({ where: { id }, data: { notes: b.notes } });
    }
  });

  if (userUpdate.status === "SUSPENDED" || (userUpdate.email && userUpdate.email !== c.user.email)) {
    await prisma.passwordResetToken.deleteMany({ where: { userId: c.userId } });
    await destroyAllSessions(c.userId);
  }
  await audit(staff.id, userUpdate.status ? `customer.${userUpdate.status.toLowerCase()}` : "customer.update", "Customer", id, {
    changedFields: Object.keys(userUpdate),
    ...(userUpdate.status ? { status: userUpdate.status } : {}),
    ...(b.notes !== undefined ? { notesUpdated: true } : {}),
  });
  return { ok: true };
});
