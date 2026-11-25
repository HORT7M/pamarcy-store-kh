import { apiHandler, parseBody } from "@/lib/api";
import { requireStaff } from "@/lib/auth/session";
import { roleHas } from "@/lib/auth/permissions";
import { cancelOrder } from "@/lib/services/orders";
import { posCancelSchema } from "@/lib/validators";

/** POST /api/admin/pos/cancel – atomically cancel an unpaid pending POS sale and release reserved stock */
export const POST = apiHandler(async (req) => {
  const user = await requireStaff("pos.use");
  const { orderId } = await parseBody(req, posCancelSchema);
  await cancelOrder(orderId, user.id, "Cancelled at POS", {
    requireChannel: "POS",
    requireCashierId: roleHas(user.role, "orders.cancel") ? undefined : user.id,
    requirePendingUnpaid: true,
  });
  return { ok: true };
});
