import { requireStaff, can } from "@/lib/auth/session";
import { ExpiryClient } from "@/components/admin/expiry-client";

export const dynamic = "force-dynamic";

export default async function ExpiryPage() {
  const user = await requireStaff("inventory.read");
  return <ExpiryClient canWrite={can(user, "inventory.write")} />;
}
