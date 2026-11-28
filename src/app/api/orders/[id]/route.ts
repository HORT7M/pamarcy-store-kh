import { apiHandler, parseParams, parseQuery } from "@/lib/api";
import { prisma } from "@/lib/db";
import { roleHas } from "@/lib/auth/permissions";
import { assertOrderAccess, resolveOrderToken } from "@/lib/order-access";
import { paymentView } from "@/lib/services/payments";
import { idParamSchema, orderTokenQuerySchema } from "@/lib/validators";

/** GET /api/orders/:id – order detail (owner, authorized staff, or valid guest token for guest orders) */
export const GET = apiHandler<{ id: string }>(async (req, { params }) => {
  const { id } = await parseParams(params, idParamSchema);
  const { token } = parseQuery(req, orderTokenQuerySchema);
  const { user } = await assertOrderAccess(id, resolveOrderToken(req, token), { mode: "read" });
  const order = await prisma.order.findUniqueOrThrow({
    where: { id },
    include: {
      items: {
        select: {
          id: true,
          orderId: true,
          medicineId: true,
          nameEn: true,
          nameKm: true,
          sku: true,
          quantity: true,
          fulfilledQuantity: true,
          unitPrice: true,
          lineTotal: true,
        },
      },
      statusHistory: {
        orderBy: { createdAt: "asc" },
        select: { id: true, status: true, note: true, createdAt: true },
      },
      payments: { orderBy: { createdAt: "desc" }, include: { method: { select: { code: true } } } },
    },
  });
  const payments = await Promise.all(order.payments.map((p) => paymentView(p)));
  const { cashierId: _c, reviewedById: _r, notes: _n, ...safeOrder } = order;
  void _c; void _r; void _n;
  const canViewRx = !user?.isStaff || roleHas(user.role, "prescriptions.review");
  return {
    ...safeOrder,
    prescriptionUrl: canViewRx ? safeOrder.prescriptionUrl : null,
    payments,
  };
});
