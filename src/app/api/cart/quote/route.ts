import { apiHandler, clientIp, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { cartQuoteSchema } from "@/lib/validators";
import { quoteCart } from "@/lib/services/orders";
import { getAvailability } from "@/lib/services/inventory";
import { ApiError, tooManyRequests } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { formatWaitDuration } from "@/lib/auth/rate-limits";
import {
  botVerificationSchema,
  clearPromoFailureSignal,
  recordPromoFailureSignal,
  verifyBotProtection,
} from "@/lib/security/bot-protection";

const schema = cartQuoteSchema.extend({ _bot: botVerificationSchema });

/** POST /api/cart/quote – server-side prices, stock check, discount & delivery fee */
export const POST = apiHandler(
  async (req) => {
    const ip = clientIp(req);
    const { _bot, ...body } = await parseBody(req, schema);

    // Normal cart recalculations stay 100% frictionless; only promo-code attempts undergo anti-guessing protection
    if (body.discountCode) {
      const check = await verifyBotProtection(req, {
        action: "promo_code",
        bot: _bot,
      });
      if (check.verified) {
        clearPromoFailureSignal(ip);
      }
    }

    let discountError: string | null = null;
    let q;
    try {
      q = await quoteCart(prisma, { ...body, channel: "ONLINE" });
    } catch (e) {
      if (e instanceof ApiError && body.discountCode && e.status === 400 && !/cart|available/i.test(e.message)) {
        discountError = e.message;
        if (/invalid discount code/i.test(e.message)) {
          recordPromoFailureSignal(ip);
          const probeRl = rateLimit(`promo:invalid:15m:${ip}`, 15, 15 * 60_000);
          if (!probeRl.ok) {
            throw tooManyRequests(
              `Too many invalid discount code attempts. Please wait ${formatWaitDuration(probeRl.retryAfter)}.`,
              probeRl.retryAfter,
              { limit: probeRl.limit, resetAt: probeRl.resetAt },
            );
          }
        }
        q = await quoteCart(prisma, { ...body, discountCode: null, channel: "ONLINE" });
      } else {
        throw e;
      }
    }

    const avail = await getAvailability(prisma, q.lines.map((l) => l.medicine.id));
    return {
      lines: q.lines.map((l) => ({
        medicineId: l.medicine.id,
        nameEn: l.medicine.nameEn,
        nameKm: l.medicine.nameKm,
        slug: l.medicine.slug,
        imageUrl: l.medicine.imageUrl,
        unitPrice: l.unitPrice,
        quantity: l.quantity,
        lineTotal: l.lineTotal,
        available: avail.get(l.medicine.id) ?? 0,
        requiresPrescription: l.medicine.requiresPrescription,
      })),
      subtotal: q.subtotal,
      discountAmount: q.discountAmount,
      discountCode: q.discount?.code ?? null,
      discountError,
      deliveryFee: q.deliveryFee,
      total: q.total,
      requiresPrescription: q.requiresPrescription,
      freeDeliveryThreshold: q.settings.freeDeliveryThreshold,
      stockOk: q.lines.every((l) => (avail.get(l.medicine.id) ?? 0) >= l.quantity),
    };
  },
  { rateLimit: 120 },
);
