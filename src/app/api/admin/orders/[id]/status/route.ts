import { apiHandler, parseBody, parseParams } from "@/lib/api";
import { requireStaff } from "@/lib/auth/session";
import { idParamSchema, orderStatusSchema } from "@/lib/validators";
import { updateOrderStatus } from "@/lib/services/orders";
import { roleHas } from "@/lib/auth/permissions";
import { forbidden } from "@/lib/errors";

export const POST = apiHandler<{ id: string }>(async (req, { params }) => {
  const user = await requireStaff("orders.write");
  const { id } = await parseParams(params, idParamSchema);
  const { status, note } = await parseBody(req, orderStatusSchema);
  if (status === "CANCELLED" && !roleHas(user.role, "orders.cancel")) throw forbidden("You cannot cancel orders");
  return updateOrderStatus(id, status, user.id, note ?? undefined);
});
