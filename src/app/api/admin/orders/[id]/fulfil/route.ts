import { apiHandler, parseBody, parseParams } from "@/lib/api";
import { requireStaff } from "@/lib/auth/session";
import { fulfilSchema, idParamSchema } from "@/lib/validators";
import { fulfilOrderQuantities } from "@/lib/services/orders";
import { prisma } from "@/lib/db";
import { badRequest, notFound } from "@/lib/errors";

/** POST – fulfil (pick from stock, FEFO) specific quantities; supports partial fulfilment */
export const POST = apiHandler<{ id: string }>(async (req, { params }) => {
  const user = await requireStaff("orders.write");
  const { id } = await parseParams(params, idParamSchema);
  const { quantities } = await parseBody(req, fulfilSchema);
  const order = await prisma.order.findUnique({ where: { id }, select: { items: { select: { id: true } } } });
  if (!order) throw notFound("Order not found");
  const validItemIds = new Set(order.items.map((i) => i.id));
  let totalToFulfil = 0;
  for (const [itemId, qty] of Object.entries(quantities)) {
    if (!validItemIds.has(itemId)) throw badRequest(`Unknown order item: ${itemId}`);
    totalToFulfil += qty;
  }
  if (totalToFulfil <= 0) throw badRequest("Enter at least one quantity to fulfil");
  await fulfilOrderQuantities(id, quantities, user.id);
  return { ok: true };
});
