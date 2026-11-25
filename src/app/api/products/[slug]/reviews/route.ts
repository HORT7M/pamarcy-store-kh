import { NextResponse } from "next/server";
import { apiHandler, clientIp, parseBody, parseParams } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireCustomer } from "@/lib/auth/session";
import { notFound, tooManyRequests } from "@/lib/errors";
import { rateLimitHeaders, rateLimitMulti } from "@/lib/rate-limit";
import { formatWaitDuration } from "@/lib/auth/rate-limits";
import { reviewSchema, slugOnlyParamSchema } from "@/lib/validators";
import {
  botVerificationSchema,
  recordReviewSignal,
  verifyBotProtection,
} from "@/lib/security/bot-protection";

const schema = reviewSchema.extend({ _bot: botVerificationSchema });

export const POST = apiHandler<{ slug: string }>(
  async (req, { params }) => {
    const user = await requireCustomer();
    const ip = clientIp(req);
    const rl = rateLimitMulti([
      { key: `reviews:1m:${ip}`, limit: 5, windowMs: 60_000 },
      { key: `reviews:1h:${user.customerId}`, limit: 15, windowMs: 60 * 60_000 },
    ]);
    if (!rl.ok) {
      throw tooManyRequests(
        `Too many review submissions. Please wait ${formatWaitDuration(rl.retryAfter)}.`,
        rl.retryAfter,
        { limit: rl.limit, resetAt: rl.resetAt },
      );
    }

    const { slug } = await parseParams(params, slugOnlyParamSchema);
    const med = await prisma.medicine.findFirst({ where: { slug, deletedAt: null, isActive: true } });
    if (!med) throw notFound("Product not found");
    const { rating, comment, _bot } = await parseBody(req, schema);

    await verifyBotProtection(req, {
      action: "review",
      bot: _bot,
      authenticated: true,
      userId: user.id,
      identifier: user.customerId,
    });

    const r = await prisma.review.upsert({
      where: { medicineId_customerId: { medicineId: med.id, customerId: user.customerId } },
      update: { rating, comment },
      create: { medicineId: med.id, customerId: user.customerId, rating, comment },
    });

    recordReviewSignal(ip, user.customerId);
    return NextResponse.json(r, { headers: rateLimitHeaders(rl) });
  },
  { rateLimit: false },
);
