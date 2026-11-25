import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { getAuthSecret, serverEnv } from "@/lib/env";
import { normalizeKhPhone } from "@/lib/phone";
import { hashPassword } from "@/lib/auth/password";
import { sendSafeHtmlEmail } from "@/lib/services/email";
import { audit } from "@/lib/audit";

export const PASSWORD_RESET_TTL_MINUTES = 30;
const RESET_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

export function hashPasswordResetToken(token: string): string {
  return createHmac("sha256", getAuthSecret()).update(`pwreset:${token}`).digest("hex");
}

export function isValidResetTokenFormat(token: string): boolean {
  return RESET_TOKEN_RE.test(token);
}

/**
 * Generates a single-use password reset token and emails the reset link if a matching active account exists.
 * Never reveals to callers whether the account exists (prevents email/phone enumeration).
 */
export async function issuePasswordResetToken(identifier: string, ip: string): Promise<{ issued: boolean }> {
  const trimmed = identifier.trim();
  const phone = normalizeKhPhone(trimmed);
  const email = trimmed.toLowerCase();

  const user = await prisma.user.findFirst({
    where: {
      deletedAt: null,
      status: "ACTIVE",
      OR: [{ email }, ...(phone ? [{ phone }] : [])],
    },
    select: { id: true, email: true, name: true },
  });

  if (!user) {
    return { issued: false };
  }

  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = hashPasswordResetToken(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TTL_MINUTES * 60_000);

  await prisma.$transaction(async (tx) => {
    // Invalidate previous unused tokens for this user so only the newest link is active
    await tx.passwordResetToken.deleteMany({
      where: { userId: user.id, usedAt: null },
    });
    await tx.passwordResetToken.create({
      data: { tokenHash, userId: user.id, ip, expiresAt },
    });
  });

  const baseUrl = serverEnv.appUrl.replace(/\/+$/, "");
  const resetUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(rawToken)}`;

  await sendSafeHtmlEmail(user.email, "Reset your Pamarcy Store password", {
    title: "Reset your Pamarcy Store password",
    message: [
      `Hello ${user.name},`,
      "",
      `We received a request to reset your Pamarcy Store password. Use the button or link below within ${PASSWORD_RESET_TTL_MINUTES} minutes:`,
      "",
      "If you did not request a password reset, you can safely ignore this message.",
    ].join("\n"),
    linkUrl: resetUrl,
    linkLabel: "Reset Password",
  });

  await audit(user.id, "auth.password_reset_requested", "User", user.id, { ip });
  return { issued: true };
}

/**
 * Verifies a password reset token, updates the password hash, marks the token consumed atomically,
 * and revokes all active sessions for the user.
 */
export async function consumePasswordResetToken(
  token: string,
  newPassword: string,
  ip: string,
): Promise<{ ok: true; userId: string } | { ok: false }> {
  if (!isValidResetTokenFormat(token)) return { ok: false };

  const tokenHash = hashPasswordResetToken(token);
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    include: { user: { select: { id: true, status: true, deletedAt: true } } },
  });

  const now = new Date();
  if (
    !record ||
    record.usedAt !== null ||
    record.expiresAt <= now ||
    !record.user ||
    record.user.deletedAt !== null ||
    record.user.status !== "ACTIVE"
  ) {
    return { ok: false };
  }

  const newHash = await hashPassword(newPassword);

  const consumed = await prisma.$transaction(async (tx) => {
    const claim = await tx.passwordResetToken.updateMany({
      where: { id: record.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claim.count !== 1) return false;

    await tx.user.update({
      where: { id: record.userId },
      data: { passwordHash: newHash },
    });
    await tx.passwordResetToken.deleteMany({
      where: { userId: record.userId, id: { not: record.id } },
    });
    await tx.session.deleteMany({
      where: { userId: record.userId },
    });
    return true;
  });

  if (!consumed) return { ok: false };

  await audit(record.userId, "auth.password_reset_completed", "User", record.userId, { ip });
  return { ok: true, userId: record.userId };
}

export async function pruneExpiredPasswordResetTokens(now = new Date()): Promise<number> {
  const cutoffUsed = new Date(now.getTime() - 24 * 60 * 60_000);
  const res = await prisma.passwordResetToken.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: now } }, { usedAt: { lt: cutoffUsed } }],
    },
  });
  return res.count;
}
