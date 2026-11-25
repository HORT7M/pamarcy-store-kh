import { apiHandler, parseParams, parseQuery } from "@/lib/api";
import { assertPaymentAccess } from "@/lib/order-access";
import { checkPayment, paymentView } from "@/lib/services/payments";
import { prisma } from "@/lib/db";
import { idParamSchema, orderTokenQuerySchema } from "@/lib/validators";

/** POST /api/payments/:id/check – ask the provider (Bakong / blockchain / PayPal) for the current status */
export const POST = apiHandler<{ id: string }>(async (req, { params }) => {
  const { id } = await parseParams(params, idParamSchema);
  const { token } = parseQuery(req, orderTokenQuerySchema);
  await assertPaymentAccess(id, token);
  await checkPayment(id);
  return paymentView(await prisma.payment.findUniqueOrThrow({ where: { id }, include: { method: { select: { code: true } } } }));
}, { rateLimit: 40 });
