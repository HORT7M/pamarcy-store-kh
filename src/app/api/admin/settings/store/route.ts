import { apiHandler, parseBody } from "@/lib/api";
import { requireStaff } from "@/lib/auth/session";
import { storeSettingsSchema } from "@/lib/validators";
import { getSettings, saveSettings } from "@/lib/settings";
import { audit } from "@/lib/audit";

export const GET = apiHandler(async () => {
  await requireStaff("settings.manage");
  return getSettings();
});

export const PUT = apiHandler(async (req) => {
  const user = await requireStaff("settings.manage");
  const before = await getSettings();
  const b = await parseBody(req, storeSettingsSchema);
  const s = await saveSettings(b);
  const changed = Object.keys(b).filter((k) => JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify((b as Record<string, unknown>)[k]));
  await audit(user.id, "settings.update", "SystemSetting", "store", { changed, exchangeRate: before.exchangeRate !== b.exchangeRate ? { from: before.exchangeRate, to: b.exchangeRate } : undefined });
  return s;
});
