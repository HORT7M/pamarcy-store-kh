import { NextResponse } from "next/server";
import { apiHandler, clientIp } from "@/lib/api";
import { getCurrentUser, SESSION_COOKIE } from "@/lib/auth/session";
import { enforceSessionMeLimit, handleInvalidSessionCookie } from "@/lib/auth/rate-limits";
import { rateLimitHeaders } from "@/lib/rate-limit";

export const GET = apiHandler(
  async (req) => {
    const ip = clientIp(req);
    const rl = enforceSessionMeLimit(ip);
    const hasCookie = Boolean(req.cookies.get(SESSION_COOKIE)?.value);
    const user = await getCurrentUser();
    if (hasCookie && !user) {
      handleInvalidSessionCookie(ip);
    }
    return NextResponse.json({ user }, { headers: rateLimitHeaders(rl) });
  },
  { rateLimit: false },
);
