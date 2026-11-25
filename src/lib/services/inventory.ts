import "server-only";
import { Prisma, type StockMovementType } from "@prisma/client";
import type { Tx } from "@/lib/db";
import { conflict, badRequest } from "@/lib/errors";
import { startOfDayPP } from "@/lib/date";

/**
 * Inventory model
 *  - MedicineBatch.quantity  = units physically on hand in that batch
 *  - MedicineBatch.reserved  = units held for unpaid / unfulfilled orders
 *  - Inventory.quantity / reserved = per-medicine aggregates kept in sync in the same tx
 *  - Sellable = non-expired batches: quantity - reserved
 * All mutating functions must run inside a transaction; they lock batch rows (FOR UPDATE)
 * so concurrent checkouts cannot oversell.
 */

type LockedBatch = { id: string; quantity: number; reserved: number; expiryDate: Date | null; batchNumber: string };

/** Batches are sellable until the end of the day before expiry (expiry date itself is not sellable). */
export function sellableCutoff(): Date {
  return startOfDayPP(new Date(Date.now() + 86400000));
}

async function lockBatches(tx: Tx, medicineId: string): Promise<LockedBatch[]> {
  return tx.$queryRaw<LockedBatch[]>`
    SELECT "id", "quantity", "reserved", "expiryDate", "batchNumber"
    FROM "MedicineBatch"
    WHERE "medicineId" = ${medicineId}
    ORDER BY "expiryDate" ASC NULLS LAST, "receivedAt" ASC
    FOR UPDATE`;
}

async function syncInventory(tx: Tx, medicineId: string) {
  const agg = await tx.medicineBatch.aggregate({ where: { medicineId }, _sum: { quantity: true, reserved: true } });
  await tx.inventory.upsert({
    where: { medicineId },
    update: { quantity: agg._sum.quantity ?? 0, reserved: agg._sum.reserved ?? 0 },
    create: { medicineId, quantity: agg._sum.quantity ?? 0, reserved: agg._sum.reserved ?? 0 },
  });
  return (agg._sum.quantity ?? 0) as number;
}

async function movement(
  tx: Tx,
  data: { medicineId: string; batchId?: string | null; type: StockMovementType; quantity: number; reference?: string | null; reason?: string | null; userId?: string | null; unitCost?: number | Prisma.Decimal | null; balanceAfter?: number },
) {
  await tx.stockMovement.create({ data: { ...data, unitCost: data.unitCost ?? undefined } });
}

/** Sellable quantity per medicine (non-expired batches only). */
export async function getAvailability(tx: Tx, medicineIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>(medicineIds.map((id) => [id, 0]));
  if (!medicineIds.length) return map;
  const rows = await tx.medicineBatch.groupBy({
    by: ["medicineId"],
    where: {
      medicineId: { in: medicineIds },
      OR: [{ expiryDate: null }, { expiryDate: { gte: sellableCutoff() } }],
    },
    _sum: { quantity: true, reserved: true },
  });
  for (const r of rows) map.set(r.medicineId, Math.max(0, (r._sum.quantity ?? 0) - (r._sum.reserved ?? 0)));
  return map;
}

/**
 * Reserve `qty` units for an order line using FEFO (first-expired-first-out), skipping expired batches.
 * If `allowPartial` is false and stock is insufficient, throws 409.
 * Returns the number of units reserved.
 */
export async function reserveForOrderItem(
  tx: Tx,
  opts: { medicineId: string; orderItemId: string; qty: number; reference: string; userId?: string | null; allowPartial?: boolean; label?: string },
): Promise<number> {
  const cutoff = sellableCutoff();
  const batches = await lockBatches(tx, opts.medicineId);
  const usable = batches.filter((b) => !b.expiryDate || b.expiryDate >= cutoff);
  const available = usable.reduce((s, b) => s + Math.max(0, b.quantity - b.reserved), 0);
  if (available < opts.qty && !opts.allowPartial) {
    throw conflict(`Insufficient stock for ${opts.label ?? "item"}: requested ${opts.qty}, available ${available}`, {
      medicineId: opts.medicineId,
      available,
    });
  }
  let remaining = Math.min(opts.qty, available);
  const reservedTotal = remaining;
  for (const b of usable) {
    if (remaining <= 0) break;
    const free = b.quantity - b.reserved;
    if (free <= 0) continue;
    const take = Math.min(free, remaining);
    await tx.medicineBatch.update({ where: { id: b.id }, data: { reserved: { increment: take } } });
    await tx.orderItemAllocation.upsert({
      where: { orderItemId_batchId: { orderItemId: opts.orderItemId, batchId: b.id } },
      update: { quantity: { increment: take } },
      create: { orderItemId: opts.orderItemId, batchId: b.id, quantity: take },
    });
    await movement(tx, { medicineId: opts.medicineId, batchId: b.id, type: "RESERVE", quantity: 0, reference: opts.reference, reason: `Reserved ${take}`, userId: opts.userId });
    remaining -= take;
  }
  await syncInventory(tx, opts.medicineId);
  return reservedTotal;
}

/** Release all still-reserved (unfulfilled) units of an order back to sellable stock. */
export async function releaseOrderReservations(tx: Tx, orderId: string, reference: string, userId?: string | null) {
  const allocs = await tx.orderItemAllocation.findMany({
    where: { orderItem: { orderId }, quantity: { gt: 0 } },
    include: { orderItem: { select: { medicineId: true } } },
  });
  const touched = new Set<string>();
  for (const a of allocs) {
    await lockBatches(tx, a.orderItem.medicineId);
    await tx.medicineBatch.update({ where: { id: a.batchId }, data: { reserved: { decrement: a.quantity } } });
    await tx.orderItemAllocation.update({ where: { id: a.id }, data: { quantity: 0 } });
    await movement(tx, { medicineId: a.orderItem.medicineId, batchId: a.batchId, type: "RELEASE", quantity: 0, reference, reason: `Released ${a.quantity}`, userId });
    touched.add(a.orderItem.medicineId);
  }
  for (const m of touched) await syncInventory(tx, m);
}

/**
 * Deduct stock for order lines (sale). `quantities` maps orderItemId → units to fulfil now;
 * omit to fulfil everything outstanding. Uses existing reservations first; if a reserved batch
 * has expired in the meantime it is released and replaced via FEFO. Throws if stock is short.
 */
export async function fulfillOrderItems(
  tx: Tx,
  orderId: string,
  reference: string,
  userId?: string | null,
  quantities?: Record<string, number>,
  opts: { partial?: boolean } = {},
) {
  const items = await tx.orderItem.findMany({ where: { orderId }, include: { allocations: { include: { batch: true } } } });
  const cutoff = sellableCutoff();
  const touched = new Set<string>();
  for (const item of items) {
    const outstanding = item.quantity - item.fulfilledQuantity;
    let want = quantities ? Math.min(quantities[item.id] ?? 0, outstanding) : outstanding;
    if (want <= 0) continue;
    if (quantities && (quantities[item.id] ?? 0) > outstanding) throw badRequest(`Cannot fulfil more than ordered for ${item.nameEn}`);
    await lockBatches(tx, item.medicineId);

    // release reservations sitting on now-expired batches
    for (const a of item.allocations) {
      if (a.quantity > 0 && a.batch.expiryDate && a.batch.expiryDate < cutoff) {
        await tx.medicineBatch.update({ where: { id: a.batchId }, data: { reserved: { decrement: a.quantity } } });
        await tx.orderItemAllocation.update({ where: { id: a.id }, data: { quantity: 0 } });
      }
    }
    const fresh = await tx.orderItemAllocation.findMany({
      where: { orderItemId: item.id, quantity: { gt: 0 } },
      include: { batch: true },
      orderBy: [{ batch: { expiryDate: "asc" } }],
    });
    const reservedNow = fresh.reduce((s, a) => s + a.quantity, 0);
    if (reservedNow < want) {
      await reserveForOrderItem(tx, { medicineId: item.medicineId, orderItemId: item.id, qty: want - reservedNow, reference, userId, label: item.nameEn, allowPartial: opts.partial });
    }
    const allocs = await tx.orderItemAllocation.findMany({
      where: { orderItemId: item.id, quantity: { gt: 0 } },
      include: { batch: true },
      orderBy: [{ batch: { expiryDate: "asc" } }],
    });
    let costSum = new Prisma.Decimal(0);
    const requested = want;
    for (const a of allocs) {
      if (want <= 0) break;
      const take = Math.min(a.quantity, want);
      const b = await tx.medicineBatch.update({
        where: { id: a.batchId },
        data: { quantity: { decrement: take }, reserved: { decrement: take } },
      });
      if (b.quantity < 0 || b.reserved < 0) throw conflict(`Stock integrity error on batch ${b.batchNumber}`);
      await tx.orderItemAllocation.update({ where: { id: a.id }, data: { quantity: { decrement: take }, fulfilled: { increment: take } } });
      costSum = costSum.add(a.batch.costPrice.mul(take));
      const total = await syncInventory(tx, item.medicineId);
      await movement(tx, { medicineId: item.medicineId, batchId: a.batchId, type: "SALE", quantity: -take, reference, userId, unitCost: a.batch.costPrice, balanceAfter: total });
      want -= take;
    }
    const fulfilNow = requested - want;
    if (fulfilNow <= 0) continue;
    const prevCost = item.unitCost.mul(item.fulfilledQuantity);
    const newFulfilled = item.fulfilledQuantity + fulfilNow;
    await tx.orderItem.update({
      where: { id: item.id },
      data: { fulfilledQuantity: newFulfilled, unitCost: prevCost.add(costSum).div(newFulfilled).toDecimalPlaces(2) },
    });
    await tx.medicine.update({ where: { id: item.medicineId }, data: { soldCount: { increment: fulfilNow } } });
    touched.add(item.medicineId);
  }
  const after = await tx.orderItem.findMany({ where: { orderId }, select: { quantity: true, fulfilledQuantity: true } });
  const done = after.every((i) => i.fulfilledQuantity >= i.quantity);
  const any = after.some((i) => i.fulfilledQuantity > 0);
  await tx.order.update({ where: { id: orderId }, data: { fulfillmentStatus: done ? "FULFILLED" : any ? "PARTIAL" : "UNFULFILLED" } });
  return { touched: [...touched], fulfilled: done };
}

/** Return fulfilled units to stock (on cancellation after fulfilment / refund with restock). */
export async function restockOrder(tx: Tx, orderId: string, reference: string, userId?: string | null) {
  const allocs = await tx.orderItemAllocation.findMany({
    where: { orderItem: { orderId }, fulfilled: { gt: 0 } },
    include: { orderItem: true },
  });
  for (const a of allocs) {
    await lockBatches(tx, a.orderItem.medicineId);
    await tx.medicineBatch.update({ where: { id: a.batchId }, data: { quantity: { increment: a.fulfilled } } });
    await tx.orderItemAllocation.update({ where: { id: a.id }, data: { fulfilled: 0 } });
    await tx.orderItem.update({ where: { id: a.orderItemId }, data: { fulfilledQuantity: { decrement: a.fulfilled } } });
    await tx.medicine.update({ where: { id: a.orderItem.medicineId }, data: { soldCount: { decrement: a.fulfilled } } });
    const total = await syncInventory(tx, a.orderItem.medicineId);
    await movement(tx, { medicineId: a.orderItem.medicineId, batchId: a.batchId, type: "RETURN", quantity: a.fulfilled, reference, userId, balanceAfter: total });
  }
}

/** Manual stock in: creates or tops up a batch. */
export async function stockIn(
  tx: Tx,
  d: { medicineId: string; batchNumber: string; lotNumber?: string | null; expiryDate?: Date | null; manufactureDate?: Date | null; quantity: number; costPrice: number; supplierId?: string | null; purchaseItemId?: string | null; reference?: string | null; reason?: string | null; userId?: string | null; type?: StockMovementType },
) {
  if (d.quantity <= 0) throw badRequest("Quantity must be positive");
  await lockBatches(tx, d.medicineId);
  const existing = await tx.medicineBatch.findUnique({ where: { medicineId_batchNumber: { medicineId: d.medicineId, batchNumber: d.batchNumber } } });
  let batchId: string;
  if (existing) {
    if (d.expiryDate && existing.expiryDate && existing.expiryDate.getTime() !== d.expiryDate.getTime()) {
      throw conflict(`Batch ${d.batchNumber} already exists with a different expiry date`);
    }
    const totalQty = existing.quantity + d.quantity;
    const avgCost = totalQty > 0 ? existing.costPrice.mul(existing.quantity).add(new Prisma.Decimal(d.costPrice).mul(d.quantity)).div(totalQty) : new Prisma.Decimal(d.costPrice);
    const b = await tx.medicineBatch.update({ where: { id: existing.id }, data: { quantity: { increment: d.quantity }, costPrice: avgCost.toDecimalPlaces(2) } });
    batchId = b.id;
  } else {
    const b = await tx.medicineBatch.create({
      data: {
        medicineId: d.medicineId, batchNumber: d.batchNumber, lotNumber: d.lotNumber, expiryDate: d.expiryDate, manufactureDate: d.manufactureDate,
        quantity: d.quantity, costPrice: d.costPrice, supplierId: d.supplierId, purchaseItemId: d.purchaseItemId,
      },
    });
    batchId = b.id;
  }
  const total = await syncInventory(tx, d.medicineId);
  await movement(tx, { medicineId: d.medicineId, batchId, type: d.type ?? "STOCK_IN", quantity: d.quantity, reference: d.reference, reason: d.reason, userId: d.userId, unitCost: d.costPrice, balanceAfter: total });
  return batchId;
}

/** Stock out (damage, loss, expired write-off) or adjustment (set counted quantity) on a batch. */
export async function adjustBatch(
  tx: Tx,
  d: { batchId: string; mode: "out" | "set"; quantity: number; reason: string; userId?: string | null; type?: StockMovementType },
) {
  const batch = await tx.medicineBatch.findUnique({ where: { id: d.batchId } });
  if (!batch) throw badRequest("Batch not found");
  await lockBatches(tx, batch.medicineId);
  const locked = await tx.medicineBatch.findUniqueOrThrow({ where: { id: d.batchId } });
  let delta: number;
  if (d.mode === "out") {
    if (d.quantity <= 0) throw badRequest("Quantity must be positive");
    delta = -d.quantity;
  } else {
    if (d.quantity < 0) throw badRequest("Counted quantity cannot be negative");
    delta = d.quantity - locked.quantity;
  }
  const newQty = locked.quantity + delta;
  if (newQty < locked.reserved) {
    throw conflict(`Cannot reduce below reserved quantity (${locked.reserved} units are reserved for orders)`);
  }
  await tx.medicineBatch.update({ where: { id: locked.id }, data: { quantity: newQty } });
  const total = await syncInventory(tx, batch.medicineId);
  await movement(tx, {
    medicineId: batch.medicineId, batchId: batch.id, type: d.type ?? (d.mode === "out" ? "STOCK_OUT" : "ADJUSTMENT"),
    quantity: delta, reason: d.reason, userId: d.userId, unitCost: locked.costPrice, balanceAfter: total,
  });
  return { delta, newQty };
}
