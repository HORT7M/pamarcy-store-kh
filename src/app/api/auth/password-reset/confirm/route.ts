import { NextResponse } from "next/server";
import { apiHandler, clientIp, parseBody } from "@/lib/api";
import { passwordResetConfirmSchema } from "@/lib/validators";
import { consumePasswordResetToken } from "@/lib/auth/password-reset";
import { badRequest } from "@/lib/errors";
import {
  enforcePasswordResetConfirmLimit,
  handlePasswordResetConfirmFailure,
  handlePasswordResetConfirmSuccess,
} from "@/lib/auth/rate-limits";
import { rateLimitHeaders } from "@/lib/rate-limit";
import { botVerificationSchema, verifyBotProtection } from "@/lib/security/bot-protection";

const schema = passwordResetConfirmSchema.extend({ _bot: botVerificationSchema });

export const POST = apiHandler(
  async (req) => {
    const ip = clientIp(req);
    const rl = enforcePasswordResetConfirmLimit(ip);

    const { token, newPassword, _bot } = await parseBody(req, schema);

    await verifyBotProtection(req, {
      action: "password_reset_confirm",
      bot: _bot,
    });

    const result = await consumePasswordResetToken(token, newPassword, ip);
    if (!result.ok) {
      await handlePasswordResetConfirmFailure(ip);
      throw badRequest("Invalid or expired password reset link");
    }

    handlePasswordResetConfirmSuccess(ip, result.userId);
    return NextResponse.json(
      { ok: true },
      { headers: { ...rateLimitHeaders(rl), "Cache-Control": "no-store" } },
    );
  },
  { rateLimit: false },
);
