import { NextResponse } from "next/server";
import { apiHandler, clientIp, parseBody } from "@/lib/api";
import { destroySession } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { enforceLogoutLimit } from "@/lib/auth/rate-limits";
import { rateLimitHeaders } from "@/lib/rate-limit";
import { logoutSchema } from "@/lib/validators";

export const POST = apiHandler(
  async (req) => {
    const ip = clientIp(req);
    const rl = enforceLogoutLimit(ip);
    const { all } = await parseBody(req, logoutSchema, { allowEmpty: true, maxBytes: 1024 });

    const { userId, isStaff } = await destroySession({ all });
    if (userId && isStaff) {
      await audit(userId, all ? "auth.logout_all" : "auth.logout", "User", userId, { ip });
    }
    return NextResponse.json(
      { ok: true },
      { headers: { ...rateLimitHeaders(rl), "Cache-Control": "no-store" } },
    );
  },
  { rateLimit: false },
);
