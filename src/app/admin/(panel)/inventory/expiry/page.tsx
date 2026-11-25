import { can } from "@/lib/auth/session";
import { requireStaffPage } from "@/lib/auth/guards";
import { ExpiryClient } from "@/components/admin/expiry-client";

export const dynamic = "force-dynamic";

export default async function ExpiryPage() {
  const user = await requireStaffPage("inventory.read");
  return <ExpiryClient canWrite={can(user, "inventory.write")} />;
}
