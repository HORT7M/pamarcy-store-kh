import { apiHandler, parseParams } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireCustomer } from "@/lib/auth/session";
import { cancelOrder } from "@/lib/services/orders";
import { conflict, forbidden } from "@/lib/errors";
import { idParamSchema } from "@/lib/validators";

/** POST /api/orders/:id/cancel – customer cancels own unpaid order */
export const POST = apiHandler<{ id: string }>(async (_req, { params }) => {
  const { id } = await parseParams(params, idParamSchema);
  const user = await requireCustomer();
  const order = await prisma.order.findUnique({ where: { id } });
  if (!order || order.customerId !== user.customerId) throw forbidden();
  if (order.status !== "PENDING" || order.paymentStatus === "PAID" || order.paymentStatus === "PROCESSING") throw conflict("This order can no longer be cancelled online. Please contact us.");
  await cancelOrder(id, user.id, "Cancelled by customer");
  return { ok: true };
});
