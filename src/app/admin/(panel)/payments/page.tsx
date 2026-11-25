import { requireStaffPage } from "@/lib/auth/guards";
import { PaymentsLedgerClient } from "@/components/admin/payments-ledger";

export const dynamic = "force-dynamic";

export default async function AdminPaymentsPage() {
  await requireStaffPage("payments.read");
  return <PaymentsLedgerClient />;
}
