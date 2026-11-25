import { NextResponse } from "next/server";
import { apiHandler, clientIp, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { loginRequestSchema } from "@/lib/validators";
import { verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { ApiError, forbidden } from "@/lib/errors";
import { normalizeKhPhone } from "@/lib/phone";
import { rateLimitHeaders } from "@/lib/rate-limit";
import {
  enforceLoginIdentifierCooldown,
  enforceLoginIpLimit,
  enforceLoginUserCooldown,
  handleLoginFailure,
  handleLoginSuccess,
  normalizeAuthIdentifier,
} from "@/lib/auth/rate-limits";
import {
  assessBotRequirement,
  botVerificationSchema,
  clearLoginFailureSignal,
  hasAutomatedClientHeaders,
  recordLoginFailureSignal,
  verifyBotProtection,
} from "@/lib/security/bot-protection";
import { audit } from "@/lib/audit";

const schema = loginRequestSchema.extend({ _bot: botVerificationSchema });
const DUMMY_HASH = "$2b$12$NYpoS/dfeCGkgcAlTAkJCuNS19qDA6xUmxK0x76ESpNOZiZK5zXcq"; // constant-time miss

export const POST = apiHandler(
  async (req) => {
    const ip = clientIp(req);
    const rl = enforceLoginIpLimit(ip);

    const { identifier, password, scope, _bot } = await parseBody(req, schema);
    const normalizedId = normalizeAuthIdentifier(identifier);
    const botAction = scope === "admin" ? "admin_login" : "login";
    enforceLoginIdentifierCooldown(ip, normalizedId);

    await verifyBotProtection(req, {
      action: botAction,
      bot: _bot,
      identifier: normalizedId,
    });

    const phone = normalizeKhPhone(identifier);
    const user = await prisma.user.findFirst({
      where: { deletedAt: null, OR: [{ email: identifier.trim().toLowerCase() }, ...(phone ? [{ phone }] : [])] },
      include: { role: true },
    });

    if (user) {
      enforceLoginUserCooldown(user.id);
    }

    const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) {
      recordLoginFailureSignal(ip, normalizedId);
      if (user?.role.isStaff) await audit(user.id, "auth.login_failed", "User", user.id, { ip });
      await handleLoginFailure({ ip, normalizedId, scope, userId: user?.id });
      const nextRequirement = assessBotRequirement({
        action: botAction,
        ip,
        identifier: normalizedId,
        automatedHeaders: hasAutomatedClientHeaders(req),
      });
      throw new ApiError(
        401,
        "UNAUTHORIZED",
        "Invalid email/phone or password",
        nextRequirement === "interactive"
          ? { challengeRequired: true, mode: "interactive", action: botAction }
          : undefined,
      );
    }

    if (user.status !== "ACTIVE") throw forbidden("This account has been suspended. Please contact the pharmacy.");
    if (scope === "admin" && !user.role.isStaff) {
      recordLoginFailureSignal(ip, normalizedId);
      throw forbidden("This account does not have staff access");
    }

    clearLoginFailureSignal(ip, normalizedId);
    handleLoginSuccess(ip, normalizedId, user.id);
    // createSession automatically invalidates any pre-existing session token (session fixation protection)
    await createSession(user.id, user.role.isStaff);
    if (user.role.isStaff) await audit(user.id, "auth.login", "User", user.id, { ip });

    return NextResponse.json(
      { ok: true, user: { id: user.id, name: user.name, role: user.role.key, isStaff: user.role.isStaff } },
      { headers: { ...rateLimitHeaders(rl), "Cache-Control": "no-store" } },
    );
  },
  { rateLimit: false },
);
