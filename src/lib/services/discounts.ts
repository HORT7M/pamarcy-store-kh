import "server-only";
import type { Discount } from "@prisma/client";
import type { Tx } from "@/lib/db";
import { badRequest } from "@/lib/errors";
import { round2, toNum } from "@/lib/money";
import { DISCOUNT_CODE_RE } from "@/lib/validators";

export async function findValidDiscount(tx: Tx, code: string, subtotal: number): Promise<{ discount: Discount; amount: number }> {
  const clean = code.trim();
  if (!DISCOUNT_CODE_RE.test(clean)) throw badRequest("Invalid discount code");
  const d = await tx.discount.findFirst({ where: { code: { equals: clean, mode: "insensitive" }, deletedAt: null } });
  const now = new Date();
  if (!d || !d.isActive) throw badRequest("Invalid discount code");
  if (d.startsAt && d.startsAt > now) throw badRequest("This discount code is not active yet");
  if (d.endsAt && d.endsAt < now) throw badRequest("This discount code has expired");
  if (d.usageLimit !== null && d.usedCount >= d.usageLimit) throw badRequest("This discount code has reached its usage limit");
  if (subtotal < toNum(d.minSubtotal)) throw badRequest(`Minimum order of $${toNum(d.minSubtotal).toFixed(2)} required for this code`);
  let amount = d.type === "PERCENTAGE" ? (subtotal * toNum(d.value)) / 100 : toNum(d.value);
  if (d.maxDiscount !== null) amount = Math.min(amount, toNum(d.maxDiscount));
  amount = round2(Math.min(amount, subtotal));
  return { discount: d, amount };
}
