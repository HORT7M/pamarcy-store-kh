import { apiHandler, parseBody, parseParams } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { idParamSchema, receiveSchema } from "@/lib/validators";
import { sellableCutoff, stockIn } from "@/lib/services/inventory";
import { parseDateInput } from "@/lib/date";
import { audit } from "@/lib/audit";
import { badRequest, conflict, notFound } from "@/lib/errors";

/** POST – record received stock (full or partial) → creates batches + stock movements */
export const POST = apiHandler<{ id: string }>(async (req, { params }) => {
  const user = await requireStaff("purchases.write");
  const { id } = await parseParams(params, idParamSchema);
  const b = await parseBody(req, receiveSchema);
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Purchase" WHERE id = ${id} FOR UPDATE`;
    const po = await tx.purchase.findUnique({ where: { id }, include: { items: { include: { medicine: true } } } });
    if (!po) throw notFound();
    if (po.status === "CANCELLED" || po.status === "RECEIVED") throw conflict(`Purchase order is ${po.status.toLowerCase()}`);
    let received = 0;
    for (const r of b.items) {
      if (r.quantity <= 0) continue;
      const item = po.items.find((i) => i.id === r.purchaseItemId);
      if (!item) throw badRequest("Invalid purchase item");
      const remaining = item.quantity - item.receivedQuantity;
      if (r.quantity > remaining) throw badRequest(`${item.medicine.nameEn}: cannot receive ${r.quantity}, only ${remaining} outstanding`);
      if (item.medicine.tracksExpiry && !r.expiryDate) throw badRequest(`${item.medicine.nameEn}: expiry date is required`);
      if (r.expiryDate && parseDateInput(r.expiryDate) < sellableCutoff()) throw badRequest(`${item.medicine.nameEn}: stock is already expired`);
      await stockIn(tx, {
        medicineId: item.medicineId, batchNumber: r.batchNumber, lotNumber: r.lotNumber, quantity: r.quantity, costPrice: Number(item.unitCost),
        expiryDate: r.expiryDate ? parseDateInput(r.expiryDate) : null, manufactureDate: r.manufactureDate ? parseDateInput(r.manufactureDate) : null,
        supplierId: po.supplierId, purchaseItemId: item.id, reference: po.number, userId: user.id, type: "PURCHASE_RECEIVE",
      });
      await tx.purchaseItem.update({ where: { id: item.id }, data: { receivedQuantity: { increment: r.quantity } } });
      await tx.medicine.update({ where: { id: item.medicineId }, data: { costPrice: item.unitCost } });
      received += r.quantity;
    }
    if (!received) throw badRequest("Enter at least one received quantity");
    const items = await tx.purchaseItem.findMany({ where: { purchaseId: id } });
    const complete = items.every((i) => i.receivedQuantity >= i.quantity);
    await tx.purchase.update({ where: { id }, data: { status: complete ? "RECEIVED" : "PARTIALLY_RECEIVED", receivedAt: complete ? new Date() : undefined } });
    return { received, complete, number: po.number };
  }, { timeout: 30000 });
  await audit(user.id, "purchase.receive", "Purchase", id, result);
  return result;
});
