import { apiHandler, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { roleHas } from "@/lib/auth/permissions";
import { posSaleSchema } from "@/lib/validators";
import { createOrder, cancelOrder } from "@/lib/services/orders";
import { initiatePayment, paymentView } from "@/lib/services/payments";
import { audit } from "@/lib/audit";
import { badRequest, forbidden } from "@/lib/errors";

/**
 * POST /api/admin/pos/sale – create a POS order (stock reserved FEFO) and its payment request.
 * Stock is deducted only when the payment is verified (cash: cashier confirms; KHQR/USDT/PayPal: provider verification).
 */
export const POST = apiHandler(async (req) => {
  const user = await requireStaff("pos.use");
  const b = await parseBody(req, posSaleSchema);
  if (b.manualDiscount && !roleHas(user.role, "orders.write") && !roleHas(user.role, "discounts.write")) {
    if (b.manualDiscount > 0) throw forbidden("Manual discounts require supervisor permission");
  }
  let customerName = b.customerName ?? "Walk-in customer";
  let phone = b.customerPhone ?? "+85500000000";
  if (b.customerId) {
    const c = await prisma.customer.findUnique({ where: { id: b.customerId }, include: { user: true } });
    if (!c || c.user.deletedAt) throw badRequest("Customer not found");
    customerName = c.user.name;
    phone = c.user.phone ?? phone;
  }
  const order = await createOrder({
    channel: "POS", items: b.items, discountCode: b.discountCode, manualDiscount: b.manualDiscount, cashierId: user.id, customerId: b.customerId ?? null,
    fullName: customerName, phone, notes: b.notes, staffCanDispenseRx: roleHas(user.role, "prescriptions.review"),
  }, user.id);
  try {
    const p = await initiatePayment(order.id, { method: b.method, currency: b.currency, network: b.network, channel: "pos" }, user.id);
    await audit(user.id, "pos.sale_start", "Order", order.id, { number: order.number, total: order.total.toString(), method: b.method });
    return { order: { id: order.id, number: order.number, total: order.total.toString(), subtotal: order.subtotal.toString(), discountAmount: order.discountAmount.toString(), exchangeRate: order.exchangeRate }, payment: await paymentView(p, { audience: "admin" }) };
  } catch (e) {
    await cancelOrder(order.id, user.id, "Payment could not be initiated", { system: true });
    throw e;
  }
});
