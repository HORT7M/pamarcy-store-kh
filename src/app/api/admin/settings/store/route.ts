import { apiHandler, parseBody } from "@/lib/api";
import { requireStaff } from "@/lib/auth/session";
import { storeSettingsSchema } from "@/lib/validators";
import { pickAllowed, STORE_SETTINGS_FIELDS } from "@/lib/allowlist";
import { getSettings, saveSettings } from "@/lib/settings";
import { audit } from "@/lib/audit";

export const GET = apiHandler(async () => {
  await requireStaff("settings.manage");
  return getSettings();
});

export const PUT = apiHandler(async (req) => {
  const user = await requireStaff("settings.manage");
  const before = await getSettings();
  const parsed = await parseBody(req, storeSettingsSchema);
  const allowed = pickAllowed(parsed, STORE_SETTINGS_FIELDS);
  const s = await saveSettings(allowed);
  const changed = STORE_SETTINGS_FIELDS.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(allowed[k]));
  await audit(user.id, "settings.update", "SystemSetting", "store", { changed, exchangeRate: before.exchangeRate !== allowed.exchangeRate ? { from: before.exchangeRate, to: allowed.exchangeRate } : undefined });
  return s;
});
