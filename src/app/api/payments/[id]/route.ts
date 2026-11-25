import { apiHandler, parseParams, parseQuery } from "@/lib/api";
import { prisma } from "@/lib/db";
import { assertPaymentAccess } from "@/lib/order-access";
import { paymentView } from "@/lib/services/payments";
import { idParamSchema, orderTokenQuerySchema } from "@/lib/validators";

export const GET = apiHandler<{ id: string }>(async (req, { params }) => {
  const { id } = await parseParams(params, idParamSchema);
  const { token } = parseQuery(req, orderTokenQuerySchema);
  await assertPaymentAccess(id, token);
  return paymentView(await prisma.payment.findUniqueOrThrow({ where: { id }, include: { method: { select: { code: true } } } }));
});
