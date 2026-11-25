import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { assertOrderAccess } from "@/lib/order-access";
import { getSettings } from "@/lib/settings";
import { getT } from "@/lib/i18n/server";
import { localizePaymentMethod } from "@/lib/i18n/translate";
import { formatDateTime } from "@/lib/date";
import { formatKHR, usdToKhr } from "@/lib/money";
import { formatKhPhone } from "@/lib/phone";
import { provinceLabel } from "@/lib/cambodia";
import { PrintButton } from "@/components/common/print-button";
import { ApiError } from "@/lib/errors";
import { ENTITY_ID_RE, ORDER_ACCESS_TOKEN_RE } from "@/lib/validators";

export const dynamic = "force-dynamic";
export const metadata = { title: "Invoice", robots: { index: false } };

/** Printable invoice (A4) / receipt (?format=receipt, 80mm thermal). Access: owner, staff, or signed guest token. */
export default async function InvoicePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ token?: string; format?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  if (!ENTITY_ID_RE.test(id)) notFound();
  const token = typeof sp.token === "string" && ORDER_ACCESS_TOKEN_RE.test(sp.token) ? sp.token : undefined;
  try {
    await assertOrderAccess(id, token);
  } catch (e) {
    if (e instanceof ApiError) notFound();
    throw e;
  }
  const [order, s, { t, tryT, locale }] = await Promise.all([
    prisma.order.findUniqueOrThrow({ where: { id }, include: { items: true, payments: { where: { status: { in: ["PAID", "REFUNDED"] } }, include: { method: true } } } }),
    getSettings(),
    getT(),
  ]);
  const km = locale === "km";
  const receipt = sp.format === "receipt";
  const paid = order.payments[0];
  const usd = (v: unknown) => `$${Number(v).toFixed(2)}`;
  const addr = [order.street, order.village, order.commune, order.district, provinceLabel(order.province, locale)].filter(Boolean).join(", ");
  const paidMethodLabel = paid ? localizePaymentMethod(paid.method, locale, tryT) : "";
  const paidStatusLabel = paid ? tryT(`status.${paid.status}`, paid.status) : tryT(`status.${order.paymentStatus}`, order.paymentStatus);

  return (
    <div className={receipt ? "mx-auto w-[80mm] bg-white p-3 font-mono text-[11px]" : "mx-auto max-w-3xl bg-white p-8 text-sm print:p-0"}>
      <div className="no-print mb-4 flex justify-end gap-2"><PrintButton /></div>
      <header className={receipt ? "text-center" : "flex items-start justify-between border-b pb-6"}>
        <div>
          <div className={receipt ? "text-base font-bold" : "text-2xl font-bold text-[#0f9d58]"}>{s.storeNameEn}</div>
          <div className="font-semibold">{s.storeNameKm}</div>
          <div className="mt-1 text-xs text-gray-600">{km ? s.addressKm : s.addressEn}</div>
          <div className="text-xs text-gray-600">{formatKhPhone(s.phone)} · {s.email}</div>
          <div className="text-xs text-gray-600">{t("common.licence")}: {s.licenseNo}</div>
        </div>
        {!receipt && (
          <div className="text-right">
            <div className="text-xl font-bold">{paid ? t("invoice.taxInvoiceReceipt") : t("invoice.invoiceTitle")}</div>
            <div className="mt-1 font-mono">{order.number}</div>
            <div className="text-xs text-gray-600">{formatDateTime(order.createdAt)}</div>
          </div>
        )}
      </header>
      {receipt && <div className="my-2 border-y border-dashed py-1 text-center">{order.number}<br />{formatDateTime(order.createdAt)}</div>}

      {!receipt && (
        <section className="grid grid-cols-2 gap-6 py-6">
          <div>
            <div className="text-xs font-semibold uppercase text-gray-500">{t("invoice.billTo")}</div>
            <div className="font-medium">{order.fullName}</div>
            <div>{formatKhPhone(order.phone)}</div>
            {order.email && <div>{order.email}</div>}
            {addr && <div className="text-gray-600">{addr}</div>}
          </div>
          <div className="text-right">
            <div className="text-xs font-semibold uppercase text-gray-500">{t("invoice.payment")}</div>
            <div className="font-medium">{paid ? `${paidMethodLabel} · ${paidStatusLabel}` : paidStatusLabel}</div>
            {paid && <div className="font-mono text-xs">{paid.reference}</div>}
            {paid?.providerTxnId && <div className="break-all font-mono text-[10px] text-gray-500">{paid.providerTxnId}</div>}
            {paid?.paidAt && <div className="text-xs text-gray-600">{formatDateTime(paid.paidAt)}</div>}
          </div>
        </section>
      )}

      <table className="w-full">
        <thead className={receipt ? "" : "border-b bg-gray-50 text-xs uppercase text-gray-600"}>
          <tr>
            <th className="py-2 text-left">{t("invoice.item")}</th>
            <th className="py-2 text-right">{t("invoice.qty")}</th>
            {!receipt && <th className="py-2 text-right">{t("invoice.unitPrice")}</th>}
            <th className="py-2 text-right">{t("invoice.total")}</th>
          </tr>
        </thead>
        <tbody>
          {order.items.map((i) => (
            <tr key={i.id} className={receipt ? "" : "border-b"}>
              <td className="py-1.5 pr-2">{km ? i.nameKm : i.nameEn}{!receipt && <div className="text-xs text-gray-500">{i.sku}</div>}</td>
              <td className="py-1.5 text-right">{i.quantity}</td>
              {!receipt && <td className="py-1.5 text-right">{usd(i.unitPrice)}</td>}
              <td className="py-1.5 text-right">{usd(i.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className={receipt ? "mt-2 border-t border-dashed pt-2" : "ml-auto mt-4 w-64 space-y-1"}>
        {[
          [t("invoice.subtotal"), usd(order.subtotal)],
          ...(Number(order.discountAmount) > 0 ? [[`${t("invoice.discount")}${order.discountCode ? ` (${order.discountCode})` : ""}`, `-${usd(order.discountAmount)}`]] : []),
          ...(order.channel === "ONLINE" ? [[t("invoice.delivery"), usd(order.deliveryFee)]] : []),
        ].map(([k, v]) => (
          <div key={k} className="flex justify-between"><span>{k}</span><span>{v}</span></div>
        ))}
        <div className="flex justify-between border-t pt-1 text-base font-bold"><span>{t("invoice.total")}</span><span>{usd(order.total)}</span></div>
        <div className="flex justify-between text-xs text-gray-600"><span>KHR @ {order.exchangeRate}</span><span>{formatKHR(usdToKhr(order.total, order.exchangeRate))}</span></div>
        {paid?.currency === "USDT" && <div className="flex justify-between text-xs text-gray-600"><span>{t("invoice.paid")}</span><span>{paid.amount.toFixed(4)} USDT ({paid.network})</span></div>}
        {paid?.currency === "KHR" && <div className="flex justify-between text-xs text-gray-600"><span>{t("invoice.paid")}</span><span>{formatKHR(Number(paid.amount))}</span></div>}
      </div>
      {receipt && paid && <div className="mt-2 text-center">{paidMethodLabel} · {paid.reference}</div>}
      <footer className={receipt ? "mt-3 border-t border-dashed pt-2 text-center" : "mt-10 border-t pt-4 text-center text-xs text-gray-500"}>
        {t("invoice.thankYouKeepOutOfReach")}
        <br />{t("invoice.noReturnPolicy")}
      </footer>
    </div>
  );
}
