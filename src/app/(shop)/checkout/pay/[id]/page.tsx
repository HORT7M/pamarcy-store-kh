import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { getT } from "@/lib/i18n/server";
import { assertOnlineOrderPayAccess } from "@/lib/order-access";
import { paymentView } from "@/lib/services/payments";
import { availableMethods } from "@/lib/services/payments/config";
import { PayClient } from "@/components/payment/pay-client";
import { ApiError } from "@/lib/errors";
import { ENTITY_ID_RE, ORDER_ACCESS_TOKEN_RE } from "@/lib/validators";

export const dynamic = "force-dynamic";
export async function generateMetadata() {
  const { t } = await getT();
  return { title: t("meta.payment") };
}

export default async function PayPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ token?: string; paypal?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  if (!ENTITY_ID_RE.test(id)) notFound();
  const token = typeof sp.token === "string" && ORDER_ACCESS_TOKEN_RE.test(sp.token) ? sp.token : undefined;
  let accessVia: "staff" | "customer" | "token" = "customer";
  try {
    const access = await assertOnlineOrderPayAccess(id, token);
    accessVia = access.via;
  } catch (e) {
    if (e instanceof ApiError) notFound();
    throw e;
  }
  const order = await prisma.order.findUniqueOrThrow({
    where: { id },
    include: { items: true, payments: { orderBy: { createdAt: "desc" }, include: { method: { select: { code: true } } } } },
  });
  const methods = (await availableMethods("online")).map(({ reason: _reason, ...m }) => { void _reason; return m; });
  const active = order.payments.find((p) => ["PENDING", "PROCESSING", "PAID"].includes(p.status));
  const view = active ? await paymentView(active) : null;
  return (
    <PayClient
      order={{
        id: order.id, number: order.number, status: order.status, paymentStatus: order.paymentStatus, prescriptionStatus: order.prescriptionStatus, prescriptionNote: order.prescriptionNote,
        total: order.total.toString(), subtotal: order.subtotal.toString(), discountAmount: order.discountAmount.toString(), deliveryFee: order.deliveryFee.toString(), exchangeRate: order.exchangeRate,
        reservationExpiresAt: order.reservationExpiresAt?.toISOString() ?? null, customerId: order.customerId,
        items: order.items.map((i) => ({ id: i.id, nameEn: i.nameEn, nameKm: i.nameKm, quantity: i.quantity, lineTotal: i.lineTotal.toString() })),
      }}
      token={accessVia === "token" && token ? token : ""}
      methods={methods}
      initialPayment={view ? JSON.parse(JSON.stringify(view)) : null}
      paypalReturn={sp.paypal === "return" ? "return" : sp.paypal === "cancel" ? "cancel" : null}
    />
  );
}
