import { NextResponse } from "next/server";
import { apiHandler, clientIp, parseBody, parseParams } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireCustomer } from "@/lib/auth/session";
import { notFound, tooManyRequests } from "@/lib/errors";
import { rateLimitHeaders, rateLimitMulti } from "@/lib/rate-limit";
import { formatWaitDuration } from "@/lib/auth/rate-limits";
import { reviewSchema, slugOnlyParamSchema } from "@/lib/validators";
import { pickAllowed, REVIEW_WRITE_FIELDS } from "@/lib/allowlist";
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
    const med = await prisma.medicine.findFirst({ where: { slug, deletedAt: null, isActive: true }, select: { id: true } });
    if (!med) throw notFound("Product not found");
    const parsed = await parseBody(req, schema);
    const allowed = pickAllowed(parsed, REVIEW_WRITE_FIELDS);

    await verifyBotProtection(req, {
      action: "review",
      bot: parsed._bot,
      authenticated: true,
      userId: user.id,
      identifier: user.customerId,
    });

    const r = await prisma.review.upsert({
      where: { medicineId_customerId: { medicineId: med.id, customerId: user.customerId } },
      update: { rating: allowed.rating, comment: allowed.comment },
      create: { medicineId: med.id, customerId: user.customerId, rating: allowed.rating, comment: allowed.comment },
      select: { id: true, medicineId: true, rating: true, comment: true, createdAt: true },
    });

    recordReviewSignal(ip, user.customerId);
    return NextResponse.json(r, { headers: rateLimitHeaders(rl) });
  },
  { rateLimit: false },
);
