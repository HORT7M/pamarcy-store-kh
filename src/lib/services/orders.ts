import "server-only";
import { Prisma, type OrderStatus } from "@prisma/client";
import { prisma, type Tx } from "@/lib/db";
import { badRequest, conflict, forbidden, notFound } from "@/lib/errors";
import { round2, toNum } from "@/lib/money";
import { nextNumber } from "@/lib/sequence";
import { computeDeliveryFee, getSettings } from "@/lib/settings";
import { findValidDiscount } from "./discounts";
import { fulfillOrderItems, releaseOrderReservations, reserveForOrderItem, restockOrder } from "./inventory";
import { notifyStaff, notifyUser } from "./notifications";
import { audit } from "@/lib/audit";
import { verifyAndResolvePrescriptionClaim } from "@/lib/upload";

const TX_OPTS = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20000, maxWait: 10000 } as const;

export type CartLine = { medicineId: string; quantity: number };

export type CreateOrderInput = {
  channel: "ONLINE" | "POS";
  items: CartLine[];
  customerId?: string | null;
  cashierId?: string | null;
  discountCode?: string | null;
  fullName: string;
  phone: string;
  email?: string | null;
  province?: string | null;
  district?: string | null;
  commune?: string | null;
  village?: string | null;
  street?: string | null;
  instructions?: string | null;
  prescriptionUrl?: string | null;
  notes?: string | null;
  /** POS: staff may sell Rx items only with prescriptions.review permission */
  staffCanDispenseRx?: boolean;
  /** POS: manual discount amount (USD) */
  manualDiscount?: number;
};

/** Price a cart from DB prices (never trusts the client). Used by cart preview and order creation. */
export async function quoteCart(tx: Tx, input: { items: CartLine[]; discountCode?: string | null; province?: string | null; channel: "ONLINE" | "POS"; manualDiscount?: number }) {
  const merged = new Map<string, number>();
  for (const l of input.items) merged.set(l.medicineId, (merged.get(l.medicineId) ?? 0) + l.quantity);
  if (!merged.size) throw badRequest("Cart is empty");
  const medicines = await tx.medicine.findMany({
    where: { id: { in: [...merged.keys()] }, deletedAt: null, isActive: true },
    include: { inventory: true },
  });
  if (medicines.length !== merged.size) throw badRequest("Some products are no longer available");
  const lines = medicines.map((m) => {
    const qty = merged.get(m.id)!;
    return { medicine: m, quantity: qty, unitPrice: toNum(m.price), lineTotal: round2(toNum(m.price) * qty) };
  });
  const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
  let discountAmount = 0;
  let discount: Awaited<ReturnType<typeof findValidDiscount>>["discount"] | null = null;
  if (input.discountCode) {
    const r = await findValidDiscount(tx, input.discountCode, subtotal);
    discount = r.discount;
    discountAmount = r.amount;
  }
  if (input.manualDiscount && input.manualDiscount > 0) discountAmount = round2(Math.min(subtotal, discountAmount + input.manualDiscount));
  const settings = await getSettings();
  const deliveryFee = input.channel === "ONLINE" ? computeDeliveryFee(settings, input.province, subtotal - discountAmount) : 0;
  const total = round2(subtotal - discountAmount + deliveryFee);
  return { lines, subtotal, discountAmount, discount, deliveryFee, total, settings, requiresPrescription: lines.some((l) => l.medicine.requiresPrescription) };
}

export async function createOrder(input: CreateOrderInput, actorUserId: string | null) {
  const order = await prisma.$transaction(async (tx) => {
    const q = await quoteCart(tx, input);
    let resolvedPrescriptionUrl: string | null = null;
    if (q.requiresPrescription) {
      if (input.channel === "ONLINE") {
        if (!input.prescriptionUrl) throw badRequest("A prescription image is required for prescription-only medicines");
        const claimed = await verifyAndResolvePrescriptionClaim(input.prescriptionUrl, actorUserId);
        const alreadyUsed = await tx.order.findFirst({
          where: { prescriptionUrl: claimed.canonicalUrl },
          select: { id: true },
        });
        if (alreadyUsed) {
          throw conflict("This prescription upload has already been linked to another order – please upload again");
        }
        resolvedPrescriptionUrl = claimed.canonicalUrl;
      }
      if (input.channel === "POS" && !input.staffCanDispenseRx) throw forbidden("Prescription-only medicines must be dispensed by a pharmacist");
    }
    if (q.discount) {
      const ok = await tx.discount.updateMany({
        where: { id: q.discount.id, OR: [{ usageLimit: null }, { usedCount: { lt: q.discount.usageLimit ?? 0 } }] },
        data: { usedCount: { increment: 1 } },
      });
      if (!ok.count) throw badRequest("This discount code has reached its usage limit");
    }
    const number = await nextNumber(tx, input.channel === "POS" ? "POS" : "PM");
    const rxPending = q.requiresPrescription && input.channel === "ONLINE";
    const reservationMinutes = rxPending ? 48 * 60 : q.settings.reservationMinutes;
    const created = await tx.order.create({
      data: {
        number,
        channel: input.channel,
        customerId: input.customerId ?? null,
        cashierId: input.cashierId ?? null,
        prescriptionStatus: q.requiresPrescription ? (rxPending ? "PENDING_REVIEW" : "APPROVED") : "NOT_REQUIRED",
        prescriptionUrl: resolvedPrescriptionUrl,
        reviewedById: q.requiresPrescription && !rxPending ? input.cashierId : null,
        reviewedAt: q.requiresPrescription && !rxPending ? new Date() : null,
        fullName: input.fullName,
        phone: input.phone,
        email: input.email ?? null,
        province: input.province ?? null,
        district: input.district ?? null,
        commune: input.commune ?? null,
        village: input.village ?? null,
        street: input.street ?? null,
        instructions: input.instructions ?? null,
        notes: input.notes ?? null,
        subtotal: q.subtotal,
        discountAmount: q.discountAmount,
        deliveryFee: q.deliveryFee,
        total: q.total,
        exchangeRate: q.settings.exchangeRate,
        discountId: q.discount?.id ?? null,
        discountCode: q.discount?.code ?? null,
        reservationExpiresAt: input.channel === "ONLINE" ? new Date(Date.now() + reservationMinutes * 60_000) : null,
        items: {
          create: q.lines.map((l) => ({
            medicineId: l.medicine.id,
            nameEn: l.medicine.nameEn,
            nameKm: l.medicine.nameKm,
            sku: l.medicine.sku,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            unitCost: l.medicine.costPrice,
            lineTotal: l.lineTotal,
          })),
        },
        statusHistory: { create: { status: "PENDING", userId: actorUserId, note: input.channel === "POS" ? "POS sale started" : "Order placed" } },
      },
      include: { items: true },
    });
    for (const item of created.items) {
      await reserveForOrderItem(tx, { medicineId: item.medicineId, orderItemId: item.id, qty: item.quantity, reference: number, userId: actorUserId, label: item.nameEn });
    }
    return created;
  }, TX_OPTS);

  if (order.channel === "ONLINE") {
    await notifyStaff({ type: "ORDER_NEW", title: `New order ${order.number}`, message: `${order.fullName} · $${toNum(order.total).toFixed(2)}`, link: `/admin/orders/${order.id}` });
    if (order.prescriptionStatus === "PENDING_REVIEW") {
      await notifyStaff({ type: "PRESCRIPTION_REVIEW", title: `Prescription review needed – ${order.number}`, message: "An order with prescription-only medicines is waiting for pharmacist review.", link: `/admin/orders/${order.id}` });
    }
  }
  return order;
}

async function addHistory(tx: Tx, orderId: string, status: OrderStatus, userId: string | null, note?: string) {
  await tx.orderStatusHistory.create({ data: { orderId, status, userId, note } });
}

/**
 * Confirm a paid order: deducts reserved stock (FEFO) — partial fulfilment allowed if a reserved
 * batch expired meanwhile; remaining units are back-ordered and can be fulfilled later.
 */
export async function confirmOrderTx(tx: Tx, orderId: string, userId: string | null, note = "Order confirmed") {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  if (order.status !== "PENDING") return order;
  if (order.paymentStatus !== "PAID") throw conflict("Order must be paid before confirmation");
  if (order.prescriptionStatus === "PENDING_REVIEW" || order.prescriptionStatus === "REJECTED") throw conflict("Prescription must be approved first");
  await fulfillOrderItems(tx, orderId, order.number, userId, undefined, { partial: true });
  const updated = await tx.order.update({
    where: { id: orderId },
    data: { status: order.channel === "POS" ? "DELIVERED" : "CONFIRMED", confirmedAt: new Date(), deliveredAt: order.channel === "POS" ? new Date() : null, reservationExpiresAt: null },
  });
  await addHistory(tx, orderId, "CONFIRMED", userId, note);
  if (order.channel === "POS") await addHistory(tx, orderId, "DELIVERED", userId, "Handed over at counter");
  return updated;
}

export async function confirmOrder(orderId: string, userId: string | null) {
  const o = await prisma.$transaction((tx) => confirmOrderTx(tx, orderId, userId), TX_OPTS);
  await audit(userId, "order.confirm", "Order", orderId);
  await checkLowStockForOrder(orderId);
  return o;
}

const FLOW: OrderStatus[] = ["PENDING", "CONFIRMED", "PROCESSING", "READY_FOR_DELIVERY", "SHIPPING", "DELIVERED"];

export async function updateOrderStatus(orderId: string, status: OrderStatus, userId: string, note?: string) {
  if (status === "CANCELLED") return cancelOrder(orderId, userId, note ?? "Cancelled by staff");
  if (status === "CONFIRMED") return confirmOrder(orderId, userId);
  const o = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) throw notFound("Order not found");
    if (order.status === "CANCELLED" || order.status === "DELIVERED") throw conflict(`Order is already ${order.status.toLowerCase()}`);
    if (FLOW.indexOf(status) <= FLOW.indexOf(order.status)) throw conflict(`Cannot move order from ${order.status} to ${status}`);
    if (order.status === "PENDING") throw conflict("Order must be confirmed first");
    if ((status === "SHIPPING" || status === "DELIVERED" || status === "READY_FOR_DELIVERY") && order.fulfillmentStatus === "UNFULFILLED") {
      throw conflict("No items have been fulfilled (picked from stock) yet");
    }
    const u = await tx.order.update({ where: { id: orderId }, data: { status, deliveredAt: status === "DELIVERED" ? new Date() : undefined } });
    await addHistory(tx, orderId, status, userId, note);
    return u;
  }, TX_OPTS);
  await audit(userId, "order.status", "Order", orderId, { status, note: note ?? null });
  if (o.customerId) {
    const c = await prisma.customer.findUnique({ where: { id: o.customerId }, select: { userId: true } });
    if (c) await notifyUser(c.userId, { type: "ORDER_STATUS", title: `Order ${o.number}`, message: `Status: ${status.replace(/_/g, " ").toLowerCase()}`, link: `/account/orders/${o.id}` });
  }
  return o;
}

/** Partial / additional fulfilment of specific quantities (e.g. back-ordered items once restocked). */
export async function fulfilOrderQuantities(orderId: string, quantities: Record<string, number>, userId: string) {
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) throw notFound();
    if (order.status === "PENDING" || order.status === "CANCELLED") throw conflict("Only confirmed orders can be fulfilled");
    await fulfillOrderItems(tx, orderId, order.number, userId, quantities);
  }, TX_OPTS);
  await audit(userId, "order.fulfil", "Order", orderId, quantities);
  await checkLowStockForOrder(orderId);
}

export async function cancelOrder(orderId: string, userId: string | null, reason: string, opts: { system?: boolean } = {}) {
  const o = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { payments: true } });
    if (!order) throw notFound("Order not found");
    if (order.status === "CANCELLED") return order;
    if (order.status === "DELIVERED") throw conflict("Delivered orders cannot be cancelled");
    await releaseOrderReservations(tx, orderId, order.number, userId);
    if (order.fulfillmentStatus !== "UNFULFILLED") await restockOrder(tx, orderId, order.number, userId);
    // expire any open payments
    for (const p of order.payments.filter((p) => p.status === "PENDING" || p.status === "PROCESSING")) {
      await tx.payment.update({ where: { id: p.id }, data: { status: "EXPIRED", failureReason: "Order cancelled" } });
      await tx.paymentTransaction.create({ data: { paymentId: p.id, type: "EXPIRE", status: "ok", message: "Order cancelled" } });
    }
    if (order.discountId) await tx.discount.update({ where: { id: order.discountId }, data: { usedCount: { decrement: 1 } } });
    const u = await tx.order.update({
      where: { id: orderId },
      data: { status: "CANCELLED", cancelReason: reason, cancelledAt: new Date(), reservationExpiresAt: null, paymentStatus: order.paymentStatus === "PENDING" ? "EXPIRED" : undefined },
    });
    await addHistory(tx, orderId, "CANCELLED", userId, reason);
    return u;
  }, TX_OPTS);
  if (!opts.system) await audit(userId, "order.cancel", "Order", orderId, { reason });
  await notifyStaff({
    type: "ORDER_CANCELLED",
    title: `Order ${o.number} cancelled`,
    message: reason + (o.paymentStatus === "PAID" ? " · Payment was received – refund required." : ""),
    link: `/admin/orders/${o.id}`,
  });
  return o;
}

export async function reviewPrescription(orderId: string, approve: boolean, note: string | null, userId: string) {
  const o = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) throw notFound();
    if (order.prescriptionStatus !== "PENDING_REVIEW") throw conflict("Order is not awaiting prescription review");
    const s = await getSettings();
    const u = await tx.order.update({
      where: { id: orderId },
      data: {
        prescriptionStatus: approve ? "APPROVED" : "REJECTED",
        prescriptionNote: note,
        reviewedById: userId,
        reviewedAt: new Date(),
        // give the customer time to pay after approval
        reservationExpiresAt: approve ? new Date(Date.now() + Math.max(s.reservationMinutes, 60 * 24) * 60_000) : order.reservationExpiresAt,
      },
    });
    await addHistory(tx, orderId, order.status, userId, `Prescription ${approve ? "approved" : "rejected"}${note ? `: ${note}` : ""}`);
    return u;
  }, TX_OPTS);
  await audit(userId, approve ? "prescription.approve" : "prescription.reject", "Order", orderId, { note });
  if (!approve) await cancelOrder(orderId, userId, `Prescription rejected${note ? `: ${note}` : ""}`);
  if (o.customerId) {
    const c = await prisma.customer.findUnique({ where: { id: o.customerId }, select: { userId: true } });
    if (c)
      await notifyUser(c.userId, {
        type: "ORDER_STATUS",
        title: `Prescription ${approve ? "approved" : "rejected"} – ${o.number}`,
        message: approve ? "Your prescription was approved. You can now complete payment." : note ?? "Your prescription could not be approved.",
        link: `/account/orders/${o.id}`,
      });
  }
  return o;
}

/** Cancel unpaid online orders whose stock reservation window passed. Idempotent; run by cron. */
export async function expireStaleOrders() {
  const stale = await prisma.order.findMany({
    where: { status: "PENDING", paymentStatus: { in: ["PENDING", "EXPIRED", "FAILED"] }, reservationExpiresAt: { lt: new Date() } },
    select: { id: true },
    take: 100,
  });
  for (const o of stale) {
    try {
      await cancelOrder(o.id, null, "Payment not received in time – reservation expired", { system: true });
    } catch (e) {
      console.error("[expireStaleOrders]", o.id, e);
    }
  }
  return stale.length;
}

export async function checkLowStockForOrder(orderId: string) {
  const items = await prisma.orderItem.findMany({ where: { orderId }, select: { medicineId: true } });
  await checkLowStock(items.map((i) => i.medicineId));
}

export async function checkLowStock(medicineIds: string[]) {
  if (!medicineIds.length) return;
  const inv = await prisma.inventory.findMany({ where: { medicineId: { in: medicineIds } }, include: { medicine: { select: { nameEn: true, sku: true } } } });
  for (const i of inv) {
    const free = i.quantity - i.reserved;
    if (free <= i.minStock) {
      await notifyStaff({
        type: "STOCK_LOW",
        title: `Low stock: ${i.medicine.nameEn}`,
        message: `${i.medicine.sku} has ${free} units available (minimum ${i.minStock}).`,
        link: `/admin/inventory?q=${encodeURIComponent(i.medicine.sku)}`,
        dedupeKey: `low:${i.medicineId}:${new Date().toISOString().slice(0, 10)}`,
      });
    }
  }
}
