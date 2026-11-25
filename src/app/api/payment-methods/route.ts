import { apiHandler } from "@/lib/api";
import { availableMethods } from "@/lib/services/payments/config";

/** GET /api/payment-methods – methods enabled for online checkout (never exposes internal env var diagnostics) */
export const GET = apiHandler(async () => ({
  methods: (await availableMethods("online")).map(({ code, nameEn, nameKm, ready, networks, currencies }) => ({
    code,
    nameEn,
    nameKm,
    ready,
    ...(networks ? { networks } : {}),
    ...(currencies ? { currencies } : {}),
  })),
}));
