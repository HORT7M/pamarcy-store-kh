import { requireStaff } from "@/lib/auth/session";
import { MarketingClient } from "@/components/admin/marketing-client";

export const dynamic = "force-dynamic";

export default async function AdminMarketingPage() {
  await requireStaff("discounts.write");
  return <MarketingClient />;
}
