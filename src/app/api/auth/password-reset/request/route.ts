import { NextResponse } from "next/server";
import { apiHandler, clientIp, parseBody } from "@/lib/api";
import { passwordResetRequestSchema } from "@/lib/validators";
import { issuePasswordResetToken } from "@/lib/auth/password-reset";
import {
  enforcePasswordResetRequestIdentifierLimit,
  enforcePasswordResetRequestIpLimit,
  normalizeAuthIdentifier,
} from "@/lib/auth/rate-limits";
import { rateLimitHeaders } from "@/lib/rate-limit";
import {
  botVerificationSchema,
  recordPasswordResetRequestSignal,
  verifyBotProtection,
} from "@/lib/security/bot-protection";

const schema = passwordResetRequestSchema.extend({ _bot: botVerificationSchema });

const GENERIC_MESSAGE =
  "If an account matches that email or phone number, password reset instructions have been sent.";

export const POST = apiHandler(
  async (req) => {
    const ip = clientIp(req);
    const ipRl = enforcePasswordResetRequestIpLimit(ip);

    const { identifier, _bot } = await parseBody(req, schema);
    const normalizedId = normalizeAuthIdentifier(identifier);

    await verifyBotProtection(req, {
      action: "password_reset",
      bot: _bot,
      identifier: normalizedId,
    });

    const idRl = enforcePasswordResetRequestIdentifierLimit(normalizedId);

    await issuePasswordResetToken(identifier, ip);
    recordPasswordResetRequestSignal(ip);

    const tightest = ipRl.remaining < idRl.remaining ? ipRl : idRl;
    return NextResponse.json(
      { ok: true, message: GENERIC_MESSAGE },
      { headers: { ...rateLimitHeaders(tightest), "Cache-Control": "no-store" } },
    );
  },
  { rateLimit: false },
);
