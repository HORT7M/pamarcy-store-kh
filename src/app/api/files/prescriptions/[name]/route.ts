import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { apiHandler, parseQuery } from "@/lib/api";
import { audit } from "@/lib/audit";
import { roleHas } from "@/lib/auth/permissions";
import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { forbidden, notFound, unauthorized } from "@/lib/errors";
import { orderAccessToken } from "@/lib/order-access";
import { buildSafeFileHeaders, readStoredPrescription } from "@/lib/upload";
import { prescriptionFileQuerySchema } from "@/lib/validators";

const SAFE_NAME_RE = /^[a-z0-9-]+\.(jpg|png|webp|pdf)$/;

function validGuestToken(orderId: string, token: string): boolean {
  const expected = Buffer.from(orderAccessToken(orderId));
  const provided = Buffer.from(token);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

/**
 * GET /api/files/prescriptions/:name
 * Serves private prescription uploads ONLY to:
 *  - Staff with explicit `prescriptions.review` permission (Pharmacist, Admin, Super Admin)
 *  - The signed-in customer who owns the order referencing this prescription
 *  - A guest presenting a valid HMAC order access token (`?orderId=...&token=...`) for that order
 */
export const GET = apiHandler<{ name: string }>(
  async (req, { params }) => {
    const { name } = await params;
    if (!SAFE_NAME_RE.test(name)) throw notFound();
    const { orderId, token } = parseQuery(req, prescriptionFileQuerySchema);

    const canonicalUrl = `/api/files/prescriptions/${name}`;
    const user = await getCurrentUser();

    let allowed = false;
    if (user?.isStaff) {
      allowed = roleHas(user.role, "prescriptions.review");
    } else if (user?.customerId) {
      const order = await prisma.order.findFirst({
        where: { prescriptionUrl: canonicalUrl, customerId: user.customerId },
        select: { id: true },
      });
      allowed = Boolean(order);
    } else {
      if (!orderId || !token) throw unauthorized();
      if (validGuestToken(orderId, token)) {
        const order = await prisma.order.findFirst({
          where: { id: orderId, prescriptionUrl: canonicalUrl },
          select: { id: true },
        });
        allowed = Boolean(order);
      }
    }

    if (!allowed) throw forbidden("You do not have permission to view this prescription");

    const file = await readStoredPrescription(name);
    await audit(user?.id ?? null, "prescription.view", "Upload", null, { fileName: name });

    return new NextResponse(new Uint8Array(file.buffer), {
      status: 200,
      headers: buildSafeFileHeaders(file.mime, name, "private"),
    });
  },
  { rateLimit: { limit: 60, windowMs: 60_000, keyPrefix: "rx-files" } },
);
