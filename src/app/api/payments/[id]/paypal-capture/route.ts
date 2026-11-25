import { apiHandler, parseParams, parseQuery } from "@/lib/api";
import { assertPaymentAccess } from "@/lib/order-access";
import { capturePaypal, paymentView } from "@/lib/services/payments";
import { prisma } from "@/lib/db";
import { idParamSchema, orderTokenQuerySchema } from "@/lib/validators";

/** POST /api/payments/:id/paypal-capture – server-side capture after buyer approval */
export const POST = apiHandler<{ id: string }>(async (req, { params }) => {
  const { id } = await parseParams(params, idParamSchema);
  const { token } = parseQuery(req, orderTokenQuerySchema);
  const { user } = await assertPaymentAccess(id, token);
  await capturePaypal(id, user?.id ?? null);
  return paymentView(await prisma.payment.findUniqueOrThrow({ where: { id }, include: { method: { select: { code: true } } } }));
}, { rateLimit: 10 });
