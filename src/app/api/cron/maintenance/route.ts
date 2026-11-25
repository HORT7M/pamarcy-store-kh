import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { clientIp, errorResponse } from "@/lib/api";
import { runMaintenance } from "@/lib/services/maintenance";
import { getCronSecret } from "@/lib/env";
import { enforceCronLimit, handleCronAuthFailure, handleCronAuthSuccess } from "@/lib/auth/rate-limits";
import { rateLimitHeaders } from "@/lib/rate-limit";

/**
 * GET|POST /api/cron/maintenance – re-checks open payments, expires stale reservations, sends expiry alerts.
 * Protect with CRON_SECRET (header `x-cron-secret` or `Authorization: Bearer <secret>` for Vercel Cron).
 */
async function handle(req: NextRequest) {
  const ip = clientIp(req);
  let rl;
  try {
    rl = enforceCronLimit(ip);
  } catch (e) {
    return errorResponse(e);
  }

  const secret = getCronSecret();
  const given = req.headers.get("x-cron-secret") ?? req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    try {
      handleCronAuthFailure(ip);
    } catch (e) {
      return errorResponse(e);
    }
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: rateLimitHeaders(rl) });
  }

  handleCronAuthSuccess(ip);
  return NextResponse.json(await runMaintenance(), { headers: rateLimitHeaders(rl) });
}
export const GET = handle;
export const POST = handle;
