import { apiHandler, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { paymentSettingsSchema } from "@/lib/validators";
import { audit } from "@/lib/audit";
import { badRequest } from "@/lib/errors";
import { availableMethods, khqrCredentialsPresent, paypalCredentialsPresent, USDT_NETWORK_META } from "@/lib/services/payments/config";
import { isValidAddress } from "@/lib/services/payments/usdt";
import { serverEnv } from "@/lib/env";
import type { Prisma } from "@prisma/client";

/** GET – payment configuration (non-secret) + credential presence flags (never the secrets) */
export const GET = apiHandler(async () => {
  await requireStaff("settings.payments");
  const methods = await prisma.paymentMethod.findMany({ orderBy: { sortOrder: "asc" } });
  const usdtRpc = Object.fromEntries(
    Object.entries(USDT_NETWORK_META).map(([k, m]) => [k, m.envRpc ? Boolean(serverEnv.evmRpcUrl(m.envRpc)) : true]),
  );
  return {
    methods,
    status: { online: await availableMethods("online"), pos: await availableMethods("pos") },
    credentials: {
      bakongToken: khqrCredentialsPresent(),
      bakongAccountEnv: serverEnv.bakong.accountId || null,
      paypal: paypalCredentialsPresent(),
      paypalEnv: serverEnv.paypal.env,
      paypalWebhook: Boolean(serverEnv.paypal.webhookId),
      tronGridKey: Boolean(serverEnv.trongrid.apiKey),
      usdtRpc,
    },
    networks: USDT_NETWORK_META,
  };
});

export const PUT = apiHandler(async (req) => {
  const user = await requireStaff("settings.payments");
  const b = await parseBody(req, paymentSettingsSchema);
  for (const n of b.USDT.config.networks) {
    if (!n.enabled) continue;
    if (!n.walletAddress || !isValidAddress(n.code, n.walletAddress)) throw badRequest(`${USDT_NETWORK_META[n.code].label}: invalid receiving wallet address`);
    if (!n.contractAddress || !isValidAddress(n.code, n.contractAddress)) throw badRequest(`${USDT_NETWORK_META[n.code].label}: invalid USDT contract address`);
    if (n.contractAddress.toLowerCase() !== USDT_NETWORK_META[n.code].defaultContract.toLowerCase() && !req.headers.get("x-confirm-custom-contract")) {
      throw badRequest(`${USDT_NETWORK_META[n.code].label}: contract differs from official Tether USDT (${USDT_NETWORK_META[n.code].defaultContract}). Re-submit with confirmation to proceed.`, { code: "CUSTOM_CONTRACT" });
    }
  }
  for (const code of ["KHQR", "USDT", "PAYPAL", "CASH"] as const) {
    const m = b[code];
    await prisma.paymentMethod.update({ where: { code }, data: { enabled: m.enabled, online: m.online, pos: m.pos, config: m.config as Prisma.InputJsonValue } });
  }
  await audit(user.id, "settings.payments_update", "PaymentMethod", null, {
    KHQR: { enabled: b.KHQR.enabled, accountId: b.KHQR.config.accountId ?? null },
    USDT: { enabled: b.USDT.enabled, networks: b.USDT.config.networks.filter((n) => n.enabled).map((n) => ({ code: n.code, wallet: n.walletAddress })) },
    PAYPAL: { enabled: b.PAYPAL.enabled },
  });
  return { ok: true };
});
