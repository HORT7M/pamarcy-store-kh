import { apiHandler, parseParams } from "@/lib/api";
import { requireStaff } from "@/lib/auth/session";
import { checkPayment, paymentView } from "@/lib/services/payments";
import { prisma } from "@/lib/db";
import { idParamSchema } from "@/lib/validators";

export const POST = apiHandler<{ id: string }>(async (_req, { params }) => {
  await requireStaff("payments.read");
  const { id } = await parseParams(params, idParamSchema);
  await checkPayment(id, { force: true });
  return paymentView(await prisma.payment.findUniqueOrThrow({ where: { id }, include: { method: { select: { code: true } } } }), { audience: "admin" });
});
