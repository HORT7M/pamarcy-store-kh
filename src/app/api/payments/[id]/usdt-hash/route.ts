import { NextResponse } from "next/server";
import { apiHandler, clientIp, parseBody, parseParams, parseQuery } from "@/lib/api";
import { idParamSchema, orderTokenQuerySchema, usdtHashSchema } from "@/lib/validators";
import { assertPaymentMutationAccess, resolveOrderToken } from "@/lib/order-access";
import { submitUsdtHash, paymentView } from "@/lib/services/payments";
import { prisma } from "@/lib/db";
import { rateLimitHeaders, rateLimitMulti } from "@/lib/rate-limit";
import { formatWaitDuration } from "@/lib/auth/rate-limits";
import { tooManyRequests } from "@/lib/errors";

/** POST /api/payments/:id/usdt-hash – submit a blockchain transaction hash for on-chain verification */
export const POST = apiHandler<{ id: string }>(
  async (req, { params }) => {
    const ip = clientIp(req);
    const { id } = await parseParams(params, idParamSchema);
    const { token } = parseQuery(req, orderTokenQuerySchema);
    const rl = rateLimitMulti([
      { key: `payments:usdt_hash:1m:${ip}`, limit: 6, windowMs: 60_000 },
      { key: `payments:usdt_hash:15m:${ip}`, limit: 15, windowMs: 15 * 60_000 },
    ]);
    if (!rl.ok) {
      throw tooManyRequests(
        `Too many transaction verification attempts. Please wait ${formatWaitDuration(rl.retryAfter)}.`,
        rl.retryAfter,
      );
    }

    await assertPaymentMutationAccess(id, resolveOrderToken(req, token));
    const { txHash } = await parseBody(req, usdtHashSchema);
    await submitUsdtHash(id, txHash);
    const view = await paymentView(
      await prisma.payment.findUniqueOrThrow({ where: { id }, include: { method: { select: { code: true } } } }),
    );
    return NextResponse.json(view, { headers: rateLimitHeaders(rl) });
  },
  { rateLimit: false },
);
