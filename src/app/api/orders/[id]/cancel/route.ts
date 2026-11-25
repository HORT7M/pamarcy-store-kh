import { apiHandler, parseParams } from "@/lib/api";
import { requireCustomer } from "@/lib/auth/session";
import { cancelOrder } from "@/lib/services/orders";
import { idParamSchema } from "@/lib/validators";

/** POST /api/orders/:id/cancel – customer atomically cancels own unpaid pending online order */
export const POST = apiHandler<{ id: string }>(async (_req, { params }) => {
  const { id } = await parseParams(params, idParamSchema);
  const user = await requireCustomer();
  await cancelOrder(id, user.id, "Cancelled by customer", {
    requireCustomerId: user.customerId,
    requireChannel: "ONLINE",
    requirePendingUnpaid: true,
  });
  return { ok: true };
});
