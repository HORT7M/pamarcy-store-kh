import { NextResponse } from "next/server";
import { apiHandler, clientIp, parseBody, parseQuery, paginate } from "@/lib/api";
import { prisma } from "@/lib/db";
import { checkoutSchema, customerOrdersQuerySchema } from "@/lib/validators";
import { ONLINE_ORDER_CREATE_FIELDS, pickAllowed } from "@/lib/allowlist";
import { getCurrentUser, requireCustomer } from "@/lib/auth/session";
import { createOrder } from "@/lib/services/orders";
import { orderAccessToken } from "@/lib/order-access";
import { rateLimitHeaders, rateLimitMulti } from "@/lib/rate-limit";
import { formatWaitDuration } from "@/lib/auth/rate-limits";
import { tooManyRequests } from "@/lib/errors";
import {
  botVerificationSchema,
  recordGuestCheckoutSignal,
  verifyBotProtection,
} from "@/lib/security/bot-protection";

const createOrderSchema = checkoutSchema.extend({ _bot: botVerificationSchema });

const publicItemSelect = {
  id: true,
  orderId: true,
  medicineId: true,
  nameEn: true,
  nameKm: true,
  sku: true,
  quantity: true,
  fulfilledQuantity: true,
  unitPrice: true,
  lineTotal: true,
} as const;

/** POST /api/orders – place an online order (guest or signed-in customer). Stock is reserved atomically (FEFO). */
export const POST = apiHandler(
  async (req) => {
    const ip = clientIp(req);
    const user = await getCurrentUser();
    const customerId = user?.customerId ?? null;

    // Multi-window anti-hoarding rate limits (tighter for unauthenticated guests, generous for signed-in customers)
    const rl = rateLimitMulti(
      user
        ? [
            { key: `orders:create:auth:1m:${ip}`, limit: 6, windowMs: 60_000 },
            { key: `orders:create:auth:15m:${user.id}`, limit: 15, windowMs: 15 * 60_000 },
          ]
        : [
            { key: `orders:create:guest:10m:${ip}`, limit: 3, windowMs: 10 * 60_000 },
            { key: `orders:create:guest:1h:${ip}`, limit: 8, windowMs: 60 * 60_000 },
          ],
    );
    if (!rl.ok) {
      throw tooManyRequests(
        `Too many order attempts. Please wait ${formatWaitDuration(rl.retryAfter)} before placing another order.`,
        rl.retryAfter,
        { limit: rl.limit, resetAt: rl.resetAt },
      );
    }

    const parsed = await parseBody(req, createOrderSchema);
    const orderFields = pickAllowed(parsed, ONLINE_ORDER_CREATE_FIELDS);

    // Check recent unpaid pending orders to protect FEFO inventory from automated reservation hoarding
    const thirtyMinAgo = new Date(Date.now() - 30 * 60_000);
    const recentUnpaidOrders = await prisma.order.count({
      where: {
        channel: "ONLINE",
        status: "PENDING",
        paymentStatus: "PENDING",
        createdAt: { gte: thirtyMinAgo },
        ...(customerId ? { customerId } : { phone: orderFields.phone }),
      },
    });

    await verifyBotProtection(req, {
      action: "checkout",
      bot: parsed._bot,
      authenticated: Boolean(user),
      userId: user?.id ?? null,
      identifier: orderFields.phone,
      recentUnpaidOrders,
    });

    // Explicit allowlist prevents injecting privileged CreateOrderInput fields (manualDiscount, staffCanDispenseRx, cashierId, notes, channel)
    const order = await createOrder(
      {
        ...orderFields,
        channel: "ONLINE",
        customerId,
      },
      user?.id ?? null,
    );

    if (!user) {
      recordGuestCheckoutSignal(ip, orderFields.phone);
    }

    if (customerId && parsed.saveAddress) {
      const sameArea = await prisma.address.findMany({
        where: { customerId, province: orderFields.province, district: orderFields.district },
        select: { id: true, street: true },
      });
      const exists = sameArea.find((a) => (a.street ?? null) === (orderFields.street ?? null));
      if (!exists) {
        const count = await prisma.address.count({ where: { customerId } });
        if (count < 25) {
          await prisma.address.create({
            data: {
              customerId,
              fullName: orderFields.fullName,
              phone: orderFields.phone,
              province: orderFields.province,
              district: orderFields.district,
              commune: orderFields.commune,
              village: orderFields.village,
              street: orderFields.street,
              instructions: orderFields.instructions,
              isDefault: count === 0,
            },
          });
        }
      }
    }

    return NextResponse.json(
      {
        id: order.id,
        number: order.number,
        total: order.total.toString(),
        prescriptionStatus: order.prescriptionStatus,
        token: customerId ? null : orderAccessToken(order.id),
      },
      { headers: rateLimitHeaders(rl) },
    );
  },
  { rateLimit: false },
);

/** GET /api/orders – current customer's orders */
export const GET = apiHandler(async (req) => {
  const user = await requireCustomer();
  const { page, pageSize } = parseQuery(req, customerOrdersQuerySchema);
  const pg = paginate(page, pageSize);
  const [total, rawOrders] = await Promise.all([
    prisma.order.count({ where: { customerId: user.customerId } }),
    prisma.order.findMany({ where: { customerId: user.customerId }, orderBy: { createdAt: "desc" }, skip: pg.skip, take: pg.take, include: { items: { select: publicItemSelect } } }),
  ]);
  const orders = rawOrders.map(({ cashierId: _c, reviewedById: _r, notes: _n, ...o }) => o);
  return { total, orders };
});
