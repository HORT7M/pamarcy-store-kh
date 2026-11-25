import { can } from "@/lib/auth/session";
import { requireStaffAnyPage } from "@/lib/auth/guards";
import { SettingsClient } from "@/components/admin/settings-client";

export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  const user = await requireStaffAnyPage(["settings.manage", "settings.payments"]);
  const canStore = can(user, "settings.manage");
  const canPayments = can(user, "settings.payments");
  return <SettingsClient canStore={canStore} canPayments={canPayments} />;
}
