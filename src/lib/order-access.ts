import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "./db";
import { getAuthSecret } from "./auth/secret";
import { getCurrentUser, type SessionUser } from "./auth/session";
import { roleHas } from "./auth/permissions";
import { forbidden, notFound } from "./errors";

/** Guest checkout: an HMAC token bound to the order id grants access to its payment page. */
export function orderAccessToken(orderId: string) {
  return createHmac("sha256", getAuthSecret()).update(`order:${orderId}`).digest("base64url").slice(0, 32);
}

function tokenOk(orderId: string, token: string | null | undefined) {
  if (!token) return false;
  const a = Buffer.from(orderAccessToken(orderId));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Authorize access to an order for the current requester (owner customer, staff with orders.read/pos.use, or valid guest token). */
export async function assertOrderAccess(orderId: string, token?: string | null): Promise<{ user: SessionUser | null }> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { customerId: true } });
  if (!order) throw notFound("Order not found");
  const user = await getCurrentUser();
  if (user?.isStaff && (roleHas(user.role, "orders.read") || roleHas(user.role, "pos.use"))) return { user };
  if (user?.customerId && order.customerId === user.customerId) return { user };
  if (tokenOk(orderId, token)) return { user };
  throw forbidden("You do not have access to this order");
}

export async function assertPaymentAccess(paymentId: string, token?: string | null) {
  const p = await prisma.payment.findUnique({ where: { id: paymentId }, select: { orderId: true } });
  if (!p) throw notFound("Payment not found");
  return { ...(await assertOrderAccess(p.orderId, token)), orderId: p.orderId };
}
