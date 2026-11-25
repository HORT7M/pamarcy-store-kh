import { apiHandler } from "@/lib/api";
import { requireStaff } from "@/lib/auth/session";
import { roleHas } from "@/lib/auth/permissions";
import { availableMethods } from "@/lib/services/payments/config";

export const GET = apiHandler(async () => {
  const user = await requireStaff("pos.use");
  const methods = await availableMethods("pos");
  // Diagnostic reasons name env vars / provider setup; only staff who manage payment settings may see them.
  const detailed = roleHas(user.role, "settings.payments");
  return { methods: methods.map(({ reason, ...m }) => (detailed || m.ready ? { ...m, reason: m.ready ? undefined : reason } : { ...m, reason: "Not available" })) };
});
