import { NextResponse } from "next/server";
import { apiHandler, clientIp, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { createSession, destroyAllSessions, requireUser } from "@/lib/auth/session";
import {
  enforcePasswordChangeLimit,
  handlePasswordChangeFailure,
  handlePasswordChangeSuccess,
} from "@/lib/auth/rate-limits";
import { rateLimitHeaders } from "@/lib/rate-limit";
import { changePasswordSchema } from "@/lib/validators";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { badRequest } from "@/lib/errors";
import { audit } from "@/lib/audit";

export const POST = apiHandler(
  async (req) => {
    const u = await requireUser();
    const ip = clientIp(req);
    const rl = enforcePasswordChangeLimit(ip, u.id);
    const { currentPassword, newPassword } = await parseBody(req, changePasswordSchema);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      await handlePasswordChangeFailure(ip, u.id);
      throw badRequest("Current password is incorrect");
    }
    handlePasswordChangeSuccess(ip, u.id);
    await prisma.user.update({ where: { id: u.id }, data: { passwordHash: await hashPassword(newPassword) } });
    // revoke all other sessions
    await destroyAllSessions(u.id);
    await createSession(u.id, u.isStaff);
    await audit(u.id, "auth.password_change", "User", u.id);
    return NextResponse.json({ ok: true }, { headers: rateLimitHeaders(rl) });
  },
  { rateLimit: false },
);
