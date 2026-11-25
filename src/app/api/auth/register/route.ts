import { NextResponse } from "next/server";
import { apiHandler, clientIp, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { registerSchema } from "@/lib/validators";
import { hashPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import {
  enforceRegisterIpLimit,
  enforceRegisterTargetLimit,
  handleRegisterConflictOrFailure,
} from "@/lib/auth/rate-limits";
import { rateLimitHeaders } from "@/lib/rate-limit";
import {
  botVerificationSchema,
  recordRegistrationFailureSignal,
  recordRegistrationSuccessSignal,
  verifyBotProtection,
} from "@/lib/security/bot-protection";
import { conflict } from "@/lib/errors";
import { notifyStaff } from "@/lib/services/notifications";

const schema = registerSchema.extend({ _bot: botVerificationSchema });

export const POST = apiHandler(
  async (req) => {
    const ip = clientIp(req);
    const rl = enforceRegisterIpLimit(ip);
    const { name, email, phone, password, _bot } = await parseBody(req, schema);
    const body = { name, email, phone, password };

    // Verify human / bot protection BEFORE querying DB or hashing password
    await verifyBotProtection(req, {
      action: "register",
      bot: _bot,
      identifier: body.email,
    });

    enforceRegisterTargetLimit(body.email, body.phone);

    const exists = await prisma.user.findFirst({
      where: { OR: [{ email: body.email }, { phone: body.phone }] },
    });
    if (exists) {
      recordRegistrationFailureSignal(ip);
      await handleRegisterConflictOrFailure(ip);
      throw conflict(exists.email === body.email ? "Email is already registered" : "Phone number is already registered");
    }

    const role = await prisma.role.findUniqueOrThrow({ where: { key: "CUSTOMER" } });
    const user = await prisma.user.create({
      data: {
        name: body.name,
        email: body.email,
        phone: body.phone,
        passwordHash: await hashPassword(body.password),
        roleId: role.id,
        customer: { create: {} },
      },
    });

    recordRegistrationSuccessSignal(ip);
    await createSession(user.id, false);
    await notifyStaff({
      type: "CUSTOMER_NEW",
      title: "New customer registered",
      message: `${user.name} (${user.phone})`,
      link: `/admin/customers`,
    });

    return NextResponse.json(
      { ok: true, user: { id: user.id, name: user.name } },
      { headers: { ...rateLimitHeaders(rl), "Cache-Control": "no-store" } },
    );
  },
  { rateLimit: false },
);
