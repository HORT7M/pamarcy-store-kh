import { requireStaff } from "@/lib/auth/session";
import { PaymentsLedgerClient } from "@/components/admin/payments-ledger";

export const dynamic = "force-dynamic";

export default async function AdminPaymentsPage() {
  await requireStaff("payments.read");
  return <PaymentsLedgerClient />;
}
