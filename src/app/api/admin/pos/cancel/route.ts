import { apiHandler, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { cancelOrder } from "@/lib/services/orders";
import { conflict, notFound } from "@/lib/errors";
import { posCancelSchema } from "@/lib/validators";

/** POST /api/admin/pos/cancel – cancel an unpaid POS sale and immediately release reserved stock */
export const POST = apiHandler(async (req) => {
  const user = await requireStaff("pos.use");
  const { orderId } = await parseBody(req, posCancelSchema);
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.channel !== "POS") throw notFound("POS order not found");
  if (order.status !== "PENDING" || order.paymentStatus === "PAID") throw conflict("Only unpaid pending POS sales can be cancelled here");
  await cancelOrder(orderId, user.id, "Cancelled at POS");
  return { ok: true };
});
