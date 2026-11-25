import Link from "next/link";
import { CreditCard } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireCustomer } from "@/lib/auth/session";
import { getT } from "@/lib/i18n/server";
import { formatDateTime } from "@/lib/date";
import { EmptyState } from "@/components/common/empty-state";
import { StatusBadge } from "@/components/common/status-badge";

export const dynamic = "force-dynamic";

export default async function PaymentsPage() {
  const user = await requireCustomer();
  const { t } = await getT();
  const payments = await prisma.payment.findMany({ where: { order: { customerId: user.customerId } }, orderBy: { createdAt: "desc" }, include: { method: true, order: { select: { id: true, number: true } } }, take: 100 });
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t("account.payments")}</h1>
      {payments.length === 0 ? <EmptyState icon={CreditCard} title={t("common.noResults")} /> : (
        <div className="overflow-x-auto rounded-2xl border bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground"><tr><th className="p-3">{t("common.date")}</th><th className="p-3">{t("pay.order")}</th><th className="p-3">{t("checkout.payment")}</th><th className="p-3 text-right">{t("common.total")}</th><th className="p-3">{t("common.status")}</th><th className="p-3">{t("pay.reference")}</th></tr></thead>
            <tbody className="divide-y">
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className="whitespace-nowrap p-3">{formatDateTime(p.createdAt)}</td>
                  <td className="p-3"><Link href={`/account/orders/${p.order.id}`} className="font-mono text-primary hover:underline">{p.order.number}</Link></td>
                  <td className="p-3">{p.method.nameEn}{p.network ? ` (${p.network})` : ""}</td>
                  <td className="whitespace-nowrap p-3 text-right">{p.currency} {p.currency === "USDT" ? p.amount.toFixed(4) : p.currency === "KHR" ? p.amount.toFixed(0) : p.amount.toFixed(2)}</td>
                  <td className="p-3"><StatusBadge status={p.status} /></td>
                  <td className="p-3 font-mono text-[11px]">{p.reference}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
