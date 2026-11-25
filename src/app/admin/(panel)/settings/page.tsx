import { redirect } from "next/navigation";
import { requireStaff, can } from "@/lib/auth/session";
import { SettingsClient } from "@/components/admin/settings-client";

export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  const user = await requireStaff();
  const canStore = can(user, "settings.manage");
  const canPayments = can(user, "settings.payments");
  if (!canStore && !canPayments) redirect("/admin");
  return <SettingsClient canStore={canStore} canPayments={canPayments} />;
}
