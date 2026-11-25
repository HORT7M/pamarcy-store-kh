import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { OrderChannel } from "@prisma/client";
import { prisma } from "./db";
import { getAuthSecret } from "./env";
import { getCurrentUser, type SessionUser } from "./auth/session";
import { roleHas } from "./auth/permissions";
import { forbidden, notFound, unauthorized } from "./errors";

export type OrderAccessMode = "read" | "online_pay" | "payment_action";

export type OrderAccessResult = {
  user: SessionUser | null;
  via: "staff" | "customer" | "token";
  isOwner: boolean;
  hasValidToken: boolean;
  order: { customerId: string | null; channel: OrderChannel; cashierId: string | null };
};

/** Guest checkout: an HMAC token bound to the order id grants access ONLY to unowned online guest orders. */
export function orderAccessToken(orderId: string) {
  return createHmac("sha256", getAuthSecret()).update(`order:${orderId}`).digest("base64url").slice(0, 32);
}

/**
 * Prefer the `x-order-token` request header over query-string `?token=` so guest HMAC
 * order tokens stay out of server/proxy URL access logs while keeping query links compatible.
 */
export function resolveOrderToken(
  req: { headers: { get(name: string): string | null } },
  queryToken?: string | null,
): string | null {
  const hdr = req.headers.get("x-order-token")?.trim();
  if (hdr && /^[A-Za-z0-9_-]{16,128}$/.test(hdr)) return hdr;
  return queryToken ?? null;
}

export function isValidOrderAccessToken(orderId: string, token: string | null | undefined): boolean {
  if (!token) return false;
  const a = Buffer.from(orderAccessToken(orderId));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Authorize access to an order for the current requester without leaking order existence to
 * unauthenticated or unauthorized callers.
 *
 * Security invariants:
 *  - Guest HMAC tokens ONLY authorize unowned ONLINE guest orders (`customerId === null && channel === "ONLINE"`).
 *    They never unlock signed-in customers' orders or in-store POS orders.
 *  - Unauthenticated requests without a token fail with 401 before querying the DB.
 *  - Unauthenticated requests with an invalid token fail with 403 before querying the DB.
 *  - Unauthorized callers receive uniform 403 for both missing and foreign orders (no IDOR existence oracle).
 *
 * Modes:
 *  - `read` (default): owning customer, valid guest token (guest online orders only), or staff with
 *    `orders.read` (or `pos.use` on POS orders).
 *  - `online_pay`: ONLINE orders only; owning customer or valid guest token (guest online orders only).
 *    Blocks staff from minting customer tokens or superseding customer online payments, and blocks
 *    customers from initiating online payments against POS orders.
 *  - `payment_action`:
 *      • ONLINE orders: owning customer or valid guest token (guest online orders only).
 *      • POS orders: staff with `orders.write`, or the cashier (`pos.use`) who created that POS order.
 */
export async function assertOrderAccess(
  orderId: string,
  token?: string | null,
  opts: { mode?: OrderAccessMode } = {},
): Promise<OrderAccessResult> {
  const mode = opts.mode ?? "read";
  const user = await getCurrentUser();
  const hasToken = Boolean(token && token.length > 0);

  // Reject completely unauthenticated callers before revealing whether the order ID exists
  if (!user && !hasToken) {
    throw unauthorized("Authentication required");
  }

  // Short-circuit forged/malformed guest tokens before hitting the database
  if (!user && !isValidOrderAccessToken(orderId, token)) {
    throw forbidden("You do not have access to this order");
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { customerId: true, channel: true, cashierId: true },
  });

  const canStaffRead = Boolean(user?.isStaff && (roleHas(user.role, "orders.read") || roleHas(user.role, "pos.use")));

  if (!order) {
    if (canStaffRead && mode !== "online_pay") throw notFound("Order not found");
    throw forbidden("You do not have access to this order");
  }

  const isOwner = Boolean(user && !user.isStaff && user.customerId && order.customerId === user.customerId);
  const isGuestOnlineOrder = order.customerId === null && order.channel === "ONLINE";
  const hasValidToken = isGuestOnlineOrder && isValidOrderAccessToken(orderId, token);

  if (mode === "online_pay") {
    if (order.channel !== "ONLINE") throw forbidden("You do not have access to this order");
    if (isOwner) return { user, via: "customer", isOwner, hasValidToken, order };
    if (hasValidToken) return { user, via: "token", isOwner, hasValidToken, order };
    throw forbidden("You do not have access to this order");
  }

  if (mode === "payment_action") {
    if (order.channel === "POS") {
      if (
        user?.isStaff &&
        (roleHas(user.role, "orders.write") ||
          (roleHas(user.role, "pos.use") && (!order.cashierId || order.cashierId === user.id)))
      ) {
        return { user, via: "staff", isOwner: false, hasValidToken: false, order };
      }
      throw forbidden("You do not have access to this order");
    }
    if (isOwner) return { user, via: "customer", isOwner, hasValidToken, order };
    if (hasValidToken) return { user, via: "token", isOwner, hasValidToken, order };
    throw forbidden("You do not have access to this order");
  }

  // mode === "read"
  if (
    user?.isStaff &&
    (roleHas(user.role, "orders.read") || (order.channel === "POS" && roleHas(user.role, "pos.use")))
  ) {
    return { user, via: "staff", isOwner: false, hasValidToken, order };
  }
  if (isOwner) return { user, via: "customer", isOwner, hasValidToken, order };
  if (hasValidToken) return { user, via: "token", isOwner, hasValidToken, order };
  throw forbidden("You do not have access to this order");
}

/** Authorize initiating or viewing online payment checkout for an ONLINE order. */
export async function assertOnlineOrderPayAccess(orderId: string, token?: string | null): Promise<OrderAccessResult> {
  return assertOrderAccess(orderId, token, { mode: "online_pay" });
}

export async function assertPaymentAccess(
  paymentId: string,
  token?: string | null,
  opts: { mode?: "read" | "payment_action" } = {},
) {
  const user = await getCurrentUser();
  const hasToken = Boolean(token && token.length > 0);
  if (!user && !hasToken) {
    throw unauthorized("Authentication required");
  }

  const p = await prisma.payment.findUnique({ where: { id: paymentId }, select: { orderId: true } });
  if (!p) {
    const canStaffRead = Boolean(
      user?.isStaff &&
        (roleHas(user.role, "payments.read") || roleHas(user.role, "orders.read") || roleHas(user.role, "pos.use")),
    );
    if (canStaffRead) throw notFound("Payment not found");
    throw forbidden("You do not have access to this payment");
  }
  return { ...(await assertOrderAccess(p.orderId, token, opts)), orderId: p.orderId };
}

/** Authorize mutating a payment (USDT tx hash submission, PayPal capture) based on order channel. */
export async function assertPaymentMutationAccess(paymentId: string, token?: string | null) {
  return assertPaymentAccess(paymentId, token, { mode: "payment_action" });
}
