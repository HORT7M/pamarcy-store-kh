import { apiHandler, parseBody, parseParams } from "@/lib/api";
import { requireStaff } from "@/lib/auth/session";
import { idParamSchema, orderRefundSchema } from "@/lib/validators";
import { refundPayment } from "@/lib/services/payments";
import { prisma } from "@/lib/db";
import { conflict } from "@/lib/errors";

/** POST – refund the paid payment of an order (PayPal via API; KHQR/USDT/cash record manual refund reference) */
export const POST = apiHandler<{ id: string }>(async (req, { params }) => {
  const user = await requireStaff("orders.refund");
  const { id } = await parseParams(params, idParamSchema);
  const body = await parseBody(req, orderRefundSchema);
  const p = await prisma.payment.findFirst({ where: { orderId: id, status: "PAID", ...(body.paymentId ? { id: body.paymentId } : {}) } });
  if (!p) throw conflict("No paid payment found for this order");
  return refundPayment(p.id, user.id, body.reason, { manualReference: body.manualReference ?? undefined });
});
