import { NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler, parseQuery } from "@/lib/api";
import { getCurrentUser } from "@/lib/auth/session";
import { normalizeAuthIdentifier } from "@/lib/auth/rate-limits";
import { getLocale } from "@/lib/i18n/server";
import { isBotAction, issueBotChallenge } from "@/lib/security/bot-protection";
import { optionalQuery } from "@/lib/validators";

const querySchema = z
  .object({
    action: z.string().trim().min(1).max(40).refine(isBotAction, "Invalid verification action"),
    mode: optionalQuery(z.enum(["auto", "interactive", "accessible"])).default("auto"),
    fallback: optionalQuery(z.enum(["0", "1"])).default("0"),
    identifier: optionalQuery(z.string().trim().max(200)),
  })
  .strict();

/**
 * GET /api/bot-protection/challenge
 * Issues a signed single-use bot-protection challenge (or returns public site key for Turnstile/hCaptcha).
 */
export const GET = apiHandler(
  async (req) => {
    const q = parseQuery(req, querySchema);

    const [user, locale] = await Promise.all([getCurrentUser(), getLocale()]);
    const normalizedId = q.identifier?.trim() ? normalizeAuthIdentifier(q.identifier) : null;

    const challenge = issueBotChallenge(req, {
      action: q.action,
      requestedMode: q.mode ?? "auto",
      fallbackBuiltin: (q.fallback ?? "0") === "1",
      locale,
      identifier: normalizedId,
      authenticated: Boolean(user),
    });

    return NextResponse.json(challenge, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        Pragma: "no-cache",
      },
    });
  },
  { rateLimit: { limit: 30, windowMs: 60_000, keyPrefix: "bot:challenge" } },
);
