import { apiHandler, parseBody, parseParams } from "@/lib/api";
import { requireStaff } from "@/lib/auth/session";
import { roleHas } from "@/lib/auth/permissions";
import { recordCashPayment, paymentView } from "@/lib/services/payments";
import { cashPaymentSchema, idParamSchema } from "@/lib/validators";

export const POST = apiHandler<{ id: string }>(async (req, { params }) => {
  const user = await requireStaff("pos.use");
  const { id } = await parseParams(params, idParamSchema);
  const { tendered } = await parseBody(req, cashPaymentSchema);
  return paymentView(
    await recordCashPayment(id, tendered, user.id, { allowAnyCashier: roleHas(user.role, "orders.write") }),
    { audience: "admin" },
  );
});
