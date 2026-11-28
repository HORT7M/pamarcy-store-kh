import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { ENTITY_ID_RE } from "@/lib/validators";
import { requireCustomerPage } from "@/lib/auth/guards";
import { getT } from "@/lib/i18n/server";
import { OrderDetailClient } from "@/components/shop/order-detail-client";

export const dynamic = "force-dynamic";

export default async function OrderDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!ENTITY_ID_RE.test(id)) notFound();
  const user = await requireCustomerPage();
  const { t } = await getT();
  const o = await prisma.order.findFirst({ where: { id, customerId: user.customerId }, include: { items: { include: { medicine: { select: { slug: true, imageUrl: true, requiresPrescription: true } } } }, statusHistory: { orderBy: { createdAt: "asc" } }, payments: { orderBy: { createdAt: "desc" }, include: { method: true } } } });
  if (!o) notFound();
  return (
    <div className="space-y-4">
      <Link href="/account/orders" className="text-sm text-primary hover:underline">← {t("account.orders")}</Link>
      <OrderDetailClient
        order={{
          id: o.id, number: o.number, channel: o.channel, status: o.status, paymentStatus: o.paymentStatus, fulfillmentStatus: o.fulfillmentStatus, prescriptionStatus: o.prescriptionStatus, prescriptionNote: o.prescriptionNote,
          createdAt: o.createdAt.toISOString(), subtotal: o.subtotal.toString(), discountAmount: o.discountAmount.toString(), deliveryFee: o.deliveryFee.toString(), total: o.total.toString(),
          fullName: o.fullName, phone: o.phone, address: [o.street, o.village, o.commune, o.district, o.province].filter(Boolean).join(", "), instructions: o.instructions, cancelReason: o.cancelReason,
          items: o.items.map((i) => ({ id: i.id, nameEn: i.nameEn, nameKm: i.nameKm, sku: i.sku, quantity: i.quantity, fulfilledQuantity: i.fulfilledQuantity, unitPrice: i.unitPrice.toString(), lineTotal: i.lineTotal.toString(), medicineId: i.medicineId, slug: i.medicine?.slug ?? "", imageUrl: i.medicine?.imageUrl ?? null, requiresPrescription: i.medicine?.requiresPrescription ?? false })),
          history: o.statusHistory.map((h) => ({ id: h.id, status: h.status, note: h.note, createdAt: h.createdAt.toISOString() })),
          payments: o.payments.map((p) => ({ id: p.id, reference: p.reference, method: p.method.code, status: p.status, currency: p.currency, amount: p.amount.toString(), createdAt: p.createdAt.toISOString(), paidAt: p.paidAt?.toISOString() ?? null, providerTxnId: p.providerTxnId })),
        }}
      />
    </div>
  );
}
