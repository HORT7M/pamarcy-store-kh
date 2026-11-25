import { apiHandler, parseParams } from "@/lib/api";
import { prisma } from "@/lib/db";
import { roleHas } from "@/lib/auth/permissions";
import { requireStaff } from "@/lib/auth/session";
import { notFound } from "@/lib/errors";
import { paymentView } from "@/lib/services/payments";
import { idParamSchema } from "@/lib/validators";

export const GET = apiHandler<{ id: string }>(async (_req, { params }) => {
  const user = await requireStaff("orders.read");
  const { id } = await parseParams(params, idParamSchema);
  const o = await prisma.order.findUnique({
    where: { id },
    include: {
      items: { select: { id: true, nameEn: true, nameKm: true, sku: true, quantity: true, fulfilledQuantity: true, unitPrice: true, lineTotal: true, allocations: { select: { quantity: true, fulfilled: true, batch: { select: { batchNumber: true, expiryDate: true } } } } } },
      statusHistory: { orderBy: { createdAt: "asc" } },
      payments: { orderBy: { createdAt: "desc" }, include: { method: { select: { code: true } }, transactions: { orderBy: { createdAt: "desc" }, select: { id: true, type: true, status: true, message: true, externalId: true, createdAt: true } } } },
      customer: { select: { id: true, user: { select: { name: true, email: true, phone: true } } } },
    },
  });
  if (!o) throw notFound();
  const userIds = [...new Set([...o.statusHistory.map((h) => h.userId), o.reviewedById, o.cashierId].filter(Boolean))] as string[];
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
  const payments = await Promise.all(o.payments.map(async (p) => ({ ...(await paymentView(p, { audience: "admin" })), transactions: p.transactions })));
  return {
    ...o,
    prescriptionUrl: roleHas(user.role, "prescriptions.review") ? o.prescriptionUrl : null,
    payments,
    users: Object.fromEntries(users.map((u) => [u.id, u.name])),
  };
});
