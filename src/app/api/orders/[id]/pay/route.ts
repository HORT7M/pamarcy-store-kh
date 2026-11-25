import { NextResponse } from "next/server";
import { apiHandler, clientIp, parseBody, parseParams, parseQuery } from "@/lib/api";
import { idParamSchema, onlineInitiatePaymentSchema, orderTokenQuerySchema } from "@/lib/validators";
import { assertOrderAccess } from "@/lib/order-access";
import { initiatePayment, paymentView } from "@/lib/services/payments";
import { tooManyRequests } from "@/lib/errors";
import { rateLimitHeaders, rateLimitMulti } from "@/lib/rate-limit";
import { formatWaitDuration } from "@/lib/auth/rate-limits";

/** POST /api/orders/:id/pay – create (or reuse) a payment request for an online order */
export const POST = apiHandler<{ id: string }>(
  async (req, { params }) => {
    const ip = clientIp(req);
    const { id } = await parseParams(params, idParamSchema);
    const { token } = parseQuery(req, orderTokenQuerySchema);
    const rl = rateLimitMulti([
      { key: `orders:pay:1m:${ip}`, limit: 10, windowMs: 60_000 },
      { key: `orders:pay:15m:${ip}`, limit: 30, windowMs: 15 * 60_000 },
    ]);
    if (!rl.ok) {
      throw tooManyRequests(
        `Too many payment initiation attempts. Please wait ${formatWaitDuration(rl.retryAfter)}.`,
        rl.retryAfter,
      );
    }

    const { user } = await assertOrderAccess(id, token);
    const body = await parseBody(req, onlineInitiatePaymentSchema);
    const p = await initiatePayment(id, { ...body, channel: "online" }, user?.id ?? null);
    return NextResponse.json(await paymentView(p), { headers: rateLimitHeaders(rl) });
  },
  { rateLimit: false },
);
