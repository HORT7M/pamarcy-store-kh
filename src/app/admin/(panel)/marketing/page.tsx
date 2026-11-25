import { requireStaffPage } from "@/lib/auth/guards";
import { MarketingClient } from "@/components/admin/marketing-client";

export const dynamic = "force-dynamic";

export default async function AdminMarketingPage() {
  await requireStaffPage("discounts.write");
  return <MarketingClient />;
}
