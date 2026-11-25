import "server-only";
import { randomBytes } from "node:crypto";
import { Prisma, type Payment, type PaymentMethodCode } from "@prisma/client";
import QRCode from "qrcode";
import { prisma, type Tx } from "@/lib/db";
import { ApiError, badRequest, conflict, forbidden, notFound } from "@/lib/errors";
import { orderAccessToken } from "@/lib/order-access";
import { round2, toNum, usdToKhr } from "@/lib/money";
import { getSettings } from "@/lib/settings";
import { audit } from "@/lib/audit";
import { serverEnv } from "@/lib/env";
import { confirmOrderTx, checkLowStockForOrder } from "../orders";
import { notifyStaff, notifyUser } from "../notifications";
import { khqrConfig, usdtConfig, usdtNetworkReady, USDT_NETWORK_META, availableMethods, type UsdtNetworkCode } from "./config";
import { generateKhqr, checkBakongTransaction } from "./khqr";
import { findUsdtTransfer, isValidTxHash, normalizeTxHash, usdtPaymentUri, verifyUsdtTransfer, toUnits, fromUnits } from "./usdt";
import { approvalUrl, capturePaypalOrder, createPaypalOrder, getPaypalOrder, refundPaypalCapture } from "./paypal";
import { safePaypalApproveUrl } from "@/lib/sanitize";

const TX_OPTS = { timeout: 20000, maxWait: 10000 } as const;
const CHECK_THROTTLE_MS = 4000;

export function newPaymentReference(code: PaymentMethodCode) {
  return `PAY-${code}-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

async function logTx(tx: Tx, paymentId: string, d: { type: Prisma.PaymentTransactionCreateInput["type"]; status: string; message?: string; externalId?: string; amount?: number | string; raw?: unknown }) {
  await tx.paymentTransaction.create({
    data: {
      paymentId,
      type: d.type,
      status: d.status,
      message: d.message?.slice(0, 1000),
      externalId: d.externalId,
      amount: d.amount !== undefined ? new Prisma.Decimal(d.amount) : undefined,
      raw: d.raw === undefined ? undefined : (JSON.parse(JSON.stringify(d.raw)) as Prisma.InputJsonValue),
    },
  });
}

// ───────────────────────────── initiate ─────────────────────────────

export type InitiateOptions = { method: PaymentMethodCode; currency?: "USD" | "KHR"; network?: UsdtNetworkCode; channel: "online" | "pos" };

export async function initiatePayment(orderId: string, opts: InitiateOptions, actorUserId: string | null) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { payments: true } });
  if (!order) throw notFound("Order not found");
  if ((opts.channel === "pos" && order.channel !== "POS") || (opts.channel === "online" && order.channel !== "ONLINE")) {
    throw conflict("Order channel does not match payment channel");
  }
  if (order.status === "CANCELLED") throw conflict("Order has been cancelled");
  if (order.paymentStatus === "PAID") throw conflict("Order is already paid");
  if (order.prescriptionStatus === "PENDING_REVIEW") throw conflict("Waiting for pharmacist to review your prescription before payment");
  if (order.prescriptionStatus === "REJECTED") throw conflict("Prescription was rejected");

  const available = await availableMethods(opts.channel);
  const avail = available.find((m) => m.code === opts.method);
  if (!avail) throw badRequest("Payment method not available");
  if (!avail.ready) throw new ApiError(503, "METHOD_NOT_READY", avail.reason ?? "Payment method is not configured");
  const method = (await prisma.paymentMethod.findUnique({ where: { code: opts.method } }))!;

  // Re-use an open payment of the same method/currency/network if still valid
  const open = order.payments.find(
    (p) => p.methodId === method.id && (p.status === "PENDING" || p.status === "PROCESSING") && (!p.expiresAt || p.expiresAt > new Date()) &&
      (opts.method !== "KHQR" || p.currency === (opts.currency ?? "USD")) && (opts.method !== "USDT" || p.network === opts.network),
  );
  if (open) return open;

  // Expire other open payments for this order (only one active payment at a time)
  for (const p of order.payments.filter((p) => p.status === "PENDING" || p.status === "PROCESSING")) {
    if (p.status === "PROCESSING") throw conflict("A payment is currently being verified for this order. Please wait.");
    await prisma.payment.update({ where: { id: p.id }, data: { status: "EXPIRED", failureReason: "Superseded by a new payment attempt" } });
  }

  if (order.paymentStatus !== "PENDING") await prisma.order.update({ where: { id: orderId }, data: { paymentStatus: "PENDING" } });
  const total = toNum(order.total);
  const reference = newPaymentReference(opts.method);
  const settings = await getSettings();

  if (opts.method === "KHQR") {
    const cfg = khqrConfig(method);
    const currency = opts.currency ?? "USD";
    if (!cfg.currencies.includes(currency)) throw badRequest(`KHQR in ${currency} is not enabled`);
    const amount = currency === "USD" ? round2(total) : usdToKhr(total, order.exchangeRate);
    const expiresAt = new Date(Date.now() + cfg.expiryMinutes * 60_000);
    const g = generateKhqr(cfg, { amount, currency, billNumber: order.number, expiresAt });
    const p = await prisma.payment.create({
      data: { reference, orderId, methodId: method.id, amountUsd: total, currency, amount, payToAddress: g.accountId, qrString: g.qr, providerRef: g.md5, expiresAt },
    });
    await logTx(prisma, p.id, { type: "CREATE", status: "ok", message: `KHQR generated (${currency} ${amount})`, externalId: g.md5 });
    return p;
  }

  if (opts.method === "USDT") {
    const cfg = usdtConfig(method);
    const net = cfg.networks.find((n) => n.code === opts.network);
    if (!net || !usdtNetworkReady(net)) throw badRequest("Selected USDT network is not available");
    // 1 USDT ≈ 1 USD. A unique sub-cent suffix (0.0001–0.0999) identifies this payment on-chain.
    const base = toUnits(total.toFixed(2), 4);
    const pending = await prisma.payment.findMany({
      where: { method: { code: "USDT" }, network: net.code, status: { in: ["PENDING", "PROCESSING"] } },
      select: { amount: true },
    });
    const taken = new Set(pending.map((p) => p.amount.toFixed(4)));
    let amountStr = "";
    for (let i = 0; i < 200; i++) {
      const suffix = BigInt(1 + Math.floor(Math.random() * 999));
      const candidate = fromUnits(base + suffix, 4);
      const fixed = Number(candidate).toFixed(4);
      if (!taken.has(fixed)) { amountStr = fixed; break; }
    }
    if (!amountStr) throw new ApiError(503, "USDT_BUSY", "Too many pending USDT payments, try again shortly");
    const expiresAt = new Date(Date.now() + cfg.expiryMinutes * 60_000);
    const p = await prisma.payment.create({
      data: { reference, orderId, methodId: method.id, amountUsd: total, currency: "USDT", amount: amountStr, network: net.code, payToAddress: net.walletAddress, qrString: usdtPaymentUri(net, amountStr), expiresAt },
    });
    await logTx(prisma, p.id, { type: "CREATE", status: "ok", message: `USDT ${amountStr} on ${net.code} to ${net.walletAddress}` });
    return p;
  }

  if (opts.method === "PAYPAL") {
    const appUrl = serverEnv.appUrl;
    const back = opts.channel === "pos" ? `${appUrl}/admin/pos` : `${appUrl}/checkout/pay/${order.id}`;
    const guestQs = opts.channel === "online" && !order.customerId ? `&token=${encodeURIComponent(orderAccessToken(order.id))}` : "";
    const p = await prisma.payment.create({
      data: { reference, orderId, methodId: method.id, amountUsd: total, currency: "USD", amount: total, expiresAt: new Date(Date.now() + 3 * 3600_000) },
    });
    try {
      const pp = await createPaypalOrder({ reference, orderNumber: order.number, amountUsd: total.toFixed(2), brandName: settings.storeNameEn, returnUrl: `${back}?paypal=return${guestQs}`, cancelUrl: `${back}?paypal=cancel${guestQs}` });
      const approve = approvalUrl(pp);
      const updated = await prisma.payment.update({ where: { id: p.id }, data: { providerRef: pp.id, qrString: approve } });
      await logTx(prisma, p.id, { type: "CREATE", status: "ok", externalId: pp.id, message: `PayPal order ${pp.id} created`, raw: pp });
      return updated;
    } catch (e) {
      await prisma.payment.update({ where: { id: p.id }, data: { status: "FAILED", failureReason: (e as Error).message } });
      await logTx(prisma, p.id, { type: "CREATE", status: "error", message: (e as Error).message });
      throw e;
    }
  }

  if (opts.method === "CASH") {
    if (opts.channel !== "pos") throw badRequest("Cash is only accepted at the counter");
    const p = await prisma.payment.create({ data: { reference, orderId, methodId: method.id, amountUsd: total, currency: "USD", amount: total } });
    return p;
  }
  throw badRequest("Unsupported payment method");
}

// ───────────────────────────── settle ─────────────────────────────

/**
 * The ONLY place a payment becomes PAID. Must be called with provider-verified data.
 * Locks the payment row, is idempotent, and confirms the order (stock deduction) atomically.
 */
async function settlePaid(paymentId: string, d: { providerTxnId: string; payerInfo?: string; message: string; raw?: unknown; usedHash?: { network: string; txHash: string }; requirePending?: boolean }, actorUserId: string | null) {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${paymentId} FOR UPDATE`;
    const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { order: true } });
    if (p.status === "PAID") return { payment: p, changed: false, orderCancelled: false };
    if (p.status === "REFUNDED") throw conflict("Payment has already been refunded");
    if (d.requirePending && (p.status !== "PENDING" || p.order.status !== "PENDING")) {
      throw conflict("Payment is no longer open for settlement");
    }
    if (d.usedHash) {
      try {
        await tx.usedTransactionHash.create({ data: { network: d.usedHash.network, txHash: d.usedHash.txHash, paymentId } });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw conflict("This transaction hash has already been used for another payment");
        throw e;
      }
    }
    const paid = await tx.payment.update({
      where: { id: paymentId },
      data: { status: "PAID", paidAt: new Date(), providerTxnId: d.providerTxnId, payerInfo: d.payerInfo, failureReason: null },
      include: { order: true },
    });
    await logTx(tx, paymentId, { type: "VERIFY", status: "ok", message: d.message, externalId: d.providerTxnId, raw: d.raw });
    const orderCancelled = p.order.status === "CANCELLED";
    await tx.order.update({ where: { id: p.orderId }, data: { paymentStatus: "PAID" } });
    if (!orderCancelled) await confirmOrderTx(tx, p.orderId, actorUserId, `Payment ${p.reference} verified`);
    return { payment: paid, changed: true, orderCancelled };
  }, TX_OPTS);

  if (result.changed) {
    const p = result.payment;
    await notifyStaff({
      type: "PAYMENT_PAID",
      title: `Payment received – ${p.order.number}`,
      message: `${p.currency} ${toNum(p.amount)} via ${p.reference.split("-")[1]}${result.orderCancelled ? " · ORDER WAS CANCELLED – refund required" : ""}`,
      link: `/admin/orders/${p.orderId}`,
    });
    if (p.order.customerId) {
      const c = await prisma.customer.findUnique({ where: { id: p.order.customerId }, select: { userId: true } });
      if (c) await notifyUser(c.userId, { type: "PAYMENT_PAID", title: `Payment received – ${p.order.number}`, message: "Thank you! Your order is confirmed.", link: `/account/orders/${p.orderId}` });
    }
    await checkLowStockForOrder(p.orderId);
  }
  return result.payment;
}

async function markFailed(p: Payment, reason: string, status: "FAILED" | "EXPIRED" = "FAILED", raw?: unknown) {
  const updated = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${p.id} FOR UPDATE`;
    const cur = await tx.payment.findUniqueOrThrow({ where: { id: p.id } });
    if (cur.status === "PAID" || cur.status === "REFUNDED") return cur;
    const u = await tx.payment.update({ where: { id: p.id }, data: { status, failureReason: reason } });
    await logTx(tx, p.id, { type: status === "EXPIRED" ? "EXPIRE" : "VERIFY", status: "error", message: reason, raw });
    const order = await tx.order.findUniqueOrThrow({ where: { id: p.orderId } });
    if (order.paymentStatus !== "PAID") await tx.order.update({ where: { id: p.orderId }, data: { paymentStatus: status } });
    return u;
  });
  if (status === "FAILED") {
    const o = await prisma.order.findUnique({ where: { id: p.orderId }, select: { number: true, id: true } });
    await notifyStaff({ type: "PAYMENT_FAILED", title: `Payment failed – ${o?.number}`, message: reason, link: `/admin/orders/${o?.id}`, dedupeKey: `payfail:${p.id}` });
  }
  return updated;
}

// ───────────────────────────── check / verify ─────────────────────────────

/** Poll the provider for the payment's current state. Safe to call repeatedly (throttled). */
export async function checkPayment(paymentId: string, opts: { force?: boolean } = {}) {
  let p = await prisma.payment.findUnique({ where: { id: paymentId }, include: { method: true } });
  if (!p) throw notFound("Payment not found");
  if (p.status !== "PENDING" && p.status !== "PROCESSING") return p;
  if (!opts.force && p.lastCheckedAt && Date.now() - p.lastCheckedAt.getTime() < CHECK_THROTTLE_MS) return p;
  await prisma.payment.update({ where: { id: p.id }, data: { lastCheckedAt: new Date() } });
  const expired = p.expiresAt && p.expiresAt < new Date();

  try {
    if (p.method.code === "KHQR" && p.providerRef) {
      const r = await checkBakongTransaction(p.providerRef);
      if (r.state === "paid") {
        const expectedAcct = p.payToAddress;
        if (expectedAcct && r.toAccountId && r.toAccountId !== expectedAcct) {
          return markFailed(p, `Paid to unexpected account ${r.toAccountId}`, "FAILED", r.raw);
        }
        if (r.currency !== p.currency || Math.abs(r.amount - toNum(p.amount)) > 0.001) {
          return markFailed(p, `Amount mismatch: got ${r.currency} ${r.amount}, expected ${p.currency} ${toNum(p.amount)}`, "FAILED", r.raw);
        }
        return settlePaid(p.id, { providerTxnId: `KHQR:${r.hash}`, payerInfo: r.fromAccountId, message: "Bakong transaction confirmed", raw: r.raw }, null);
      }
      if (r.state === "failed") return markFailed(p, r.message, "FAILED", r.raw);
    }

    if (p.method.code === "USDT" && p.network) {
      const net = usdtConfig(p.method).networks.find((n) => n.code === p!.network);
      if (net) {
        let hash = p.providerRef; // customer-submitted hash
        if (!hash) {
          const found = await findUsdtTransfer(net, p.amount.toFixed(4), p.createdAt);
          if (found) {
            hash = normalizeTxHash(net.code, found);
            const used = await prisma.usedTransactionHash.findUnique({ where: { network_txHash: { network: net.code, txHash: hash } } });
            if (used) hash = null;
            else await prisma.payment.update({ where: { id: p.id }, data: { providerRef: hash } });
          }
        }
        if (hash) {
          const r = await verifyUsdtTransfer(net, hash, p.amount.toFixed(4), p.createdAt);
          if (r.ok) {
            return settlePaid(p.id, {
              providerTxnId: `${net.code}:${hash}`,
              payerInfo: r.from,
              message: `On-chain transfer verified (${r.confirmations} confirmations)`,
              raw: r.raw,
              usedHash: { network: net.code, txHash: hash },
            }, null);
          }
          if (r.pending) {
            if (p.status !== "PROCESSING") p = await prisma.payment.update({ where: { id: p.id }, data: { status: "PROCESSING", failureReason: r.reason }, include: { method: true } });
            return p; // never expire while a submitted tx is confirming
          }
          // definitive rejection of submitted hash → allow resubmission
          await prisma.payment.update({ where: { id: p.id }, data: { providerRef: null, status: "PENDING", failureReason: r.reason } });
          await logTx(prisma, p.id, { type: "VERIFY", status: "error", message: r.reason, externalId: hash });
          throw badRequest(r.reason);
        }
      }
    }

    if (p.method.code === "PAYPAL" && p.providerRef) {
      const o = await getPaypalOrder(p.providerRef);
      if (o.status === "APPROVED") return capturePaypal(p.id, null);
      if (o.status === "COMPLETED") return capturePaypal(p.id, null);
      if (o.status === "VOIDED") return markFailed(p, "PayPal order voided", "FAILED", o);
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 400) throw e;
    console.error("[checkPayment]", p.reference, e);
    await logTx(prisma, p.id, { type: "VERIFY", status: "error", message: (e as Error).message });
    if (!expired) return prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
  }

  if (expired && p.status === "PENDING") return markFailed(p, "Payment window expired", "EXPIRED");
  return prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
}

export async function submitUsdtHash(paymentId: string, rawHash: string) {
  const p = await prisma.payment.findUnique({ where: { id: paymentId }, include: { method: true } });
  if (!p || p.method.code !== "USDT" || !p.network) throw notFound("Payment not found");
  if (p.status === "PAID") return p;
  if (p.status !== "PENDING" && p.status !== "PROCESSING") throw conflict(`Payment is ${p.status.toLowerCase()}`);
  const net = p.network as UsdtNetworkCode;
  if (!isValidTxHash(net, rawHash.trim())) throw badRequest(`Invalid ${USDT_NETWORK_META[net].label} transaction hash format`);
  const hash = normalizeTxHash(net, rawHash);
  const used = await prisma.usedTransactionHash.findUnique({ where: { network_txHash: { network: net, txHash: hash } } });
  if (used) throw conflict("This transaction hash has already been used for another payment");
  const other = await prisma.payment.findFirst({ where: { providerRef: hash, id: { not: p.id }, status: { in: ["PENDING", "PROCESSING"] } } });
  if (other) throw conflict("This transaction hash was submitted for another payment");
  await prisma.payment.update({ where: { id: p.id }, data: { providerRef: hash, status: "PROCESSING", failureReason: null } });
  await logTx(prisma, p.id, { type: "VERIFY", status: "pending", message: "Customer submitted transaction hash", externalId: hash });
  return checkPayment(p.id, { force: true });
}

export async function capturePaypal(paymentId: string, actorUserId: string | null) {
  const p = await prisma.payment.findUnique({ where: { id: paymentId }, include: { method: true } });
  if (!p || p.method.code !== "PAYPAL" || !p.providerRef) throw notFound("Payment not found");
  if (p.status === "PAID") return p;
  if (p.status !== "PENDING" && p.status !== "PROCESSING") throw conflict(`Payment is ${p.status.toLowerCase()}`);
  await prisma.payment.update({ where: { id: p.id }, data: { status: "PROCESSING" } });
  let order;
  try {
    order = await capturePaypalOrder(p.providerRef, p.reference);
  } catch (e) {
    const msg = (e as Error).message;
    if (e instanceof ApiError && e.code === "INSTRUMENT_DECLINED") {
      await prisma.payment.update({ where: { id: p.id }, data: { status: "PENDING", failureReason: msg } });
      throw e; // buyer can retry with another funding source
    }
    await markFailed(p, msg);
    throw e;
  }
  const unit = order.purchase_units?.[0];
  const cap = unit?.payments?.captures?.[0];
  if (order.status !== "COMPLETED" || !cap) {
    await prisma.payment.update({ where: { id: p.id }, data: { status: "PENDING" } });
    return prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
  }
  if (cap.status === "DECLINED" || cap.status === "FAILED") return markFailed(p, `PayPal capture ${cap.status.toLowerCase()}`, "FAILED", order);
  if (cap.amount.currency_code !== "USD" || cap.amount.value !== toNum(p.amount).toFixed(2) || (unit?.custom_id && unit.custom_id !== p.reference)) {
    return markFailed(p, `PayPal amount/reference mismatch (${cap.amount.currency_code} ${cap.amount.value})`, "FAILED", order);
  }
  if (cap.status === "PENDING") {
    await prisma.payment.update({ where: { id: p.id }, data: { status: "PROCESSING", providerTxnId: `PAYPAL:${cap.id}`, failureReason: "PayPal capture pending review" } });
    await logTx(prisma, p.id, { type: "CAPTURE", status: "pending", externalId: cap.id, raw: order });
    return prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
  }
  await logTx(prisma, p.id, { type: "CAPTURE", status: "ok", externalId: cap.id, amount: cap.amount.value });
  return settlePaid(p.id, { providerTxnId: `PAYPAL:${cap.id}`, payerInfo: order.payer?.email_address, message: "PayPal capture completed", raw: order }, actorUserId);
}

/** PayPal webhook events (signature already verified by caller). */
export async function handlePaypalWebhook(event: { event_type: string; resource: Record<string, unknown> }) {
  const r = event.resource as { id?: string; custom_id?: string; status?: string; supplementary_data?: { related_ids?: { order_id?: string } } };
  const orderId = r.supplementary_data?.related_ids?.order_id ?? (event.event_type.startsWith("CHECKOUT.ORDER") ? r.id : undefined);
  const clauses = [
    r.custom_id ? { reference: r.custom_id } : undefined,
    orderId ? { providerRef: orderId } : undefined,
    r.id ? { providerTxnId: `PAYPAL:${r.id}` } : undefined,
  ].filter(Boolean) as Prisma.PaymentWhereInput[];
  if (!clauses.length) return { handled: false };
  const p = await prisma.payment.findFirst({
    where: { method: { code: "PAYPAL" }, OR: clauses },
  });
  if (!p) return { handled: false };
  await logTx(prisma, p.id, { type: "WEBHOOK", status: "ok", message: event.event_type, externalId: r.id, raw: event });
  switch (event.event_type) {
    case "CHECKOUT.ORDER.APPROVED":
      if (p.status === "PENDING") await capturePaypal(p.id, null).catch(() => {});
      break;
    case "PAYMENT.CAPTURE.COMPLETED":
      // Re-fetch from PayPal instead of trusting the webhook body
      if (p.status !== "PAID" && p.status !== "REFUNDED" && p.providerRef) {
        const o = await getPaypalOrder(p.providerRef);
        const cap = o.purchase_units?.[0]?.payments?.captures?.find((c) => c.id === r.id);
        if (o.status === "COMPLETED" && cap?.status === "COMPLETED" && cap.amount.value === toNum(p.amount).toFixed(2)) {
          await settlePaid(p.id, { providerTxnId: `PAYPAL:${cap.id}`, payerInfo: o.payer?.email_address, message: "PayPal capture completed (webhook, re-verified)" }, null);
        }
      }
      break;
    case "PAYMENT.CAPTURE.DENIED":
    case "PAYMENT.CAPTURE.DECLINED":
      if (p.status !== "PAID") await markFailed(p, `PayPal ${event.event_type}`);
      break;
    case "PAYMENT.CAPTURE.REFUNDED":
      if (p.status === "PAID") {
        await prisma.payment.update({ where: { id: p.id }, data: { status: "REFUNDED", refundedAt: new Date(), refundAmount: p.amountUsd } });
        await prisma.order.update({ where: { id: p.orderId }, data: { paymentStatus: "REFUNDED" } });
      }
      break;
  }
  return { handled: true };
}

// ───────────────────────────── cash & refunds ─────────────────────────────

/** POS cash: a staff member physically receiving cash is the verification. */
export async function recordCashPayment(
  paymentId: string,
  tendered: number,
  actorUserId: string,
  opts: { allowAnyCashier?: boolean } = {},
) {
  const p = await prisma.payment.findUnique({ where: { id: paymentId }, include: { method: true, order: true } });
  if (!p || p.method.code !== "CASH" || p.order.channel !== "POS") throw notFound("Payment not found");
  if (!opts.allowAnyCashier && p.order.cashierId && p.order.cashierId !== actorUserId) {
    throw forbidden("You can only complete cash payment for your own POS sale");
  }
  if (p.order.status !== "PENDING") throw conflict("Order is no longer open for cash payment");
  if (p.status !== "PENDING") throw conflict(`Payment is already ${p.status.toLowerCase()}`);
  if (tendered + 0.001 < toNum(p.amount)) throw badRequest("Cash tendered is less than the amount due");
  const paid = await settlePaid(p.id, { providerTxnId: `CASH:${p.reference}`, message: `Cash received ${tendered.toFixed(2)}, change ${round2(tendered - toNum(p.amount)).toFixed(2)}`, requirePending: true }, actorUserId);
  await audit(actorUserId, "payment.cash", "Payment", p.id, { tendered });
  return paid;
}

export async function refundPayment(paymentId: string, actorUserId: string, reason: string, opts: { manualReference?: string } = {}) {
  const p = await prisma.payment.findUnique({ where: { id: paymentId }, include: { method: true, order: true } });
  if (!p) throw notFound("Payment not found");
  if (p.status !== "PAID") throw conflict("Only paid payments can be refunded");
  let externalId: string | undefined;
  if (p.method.code === "PAYPAL") {
    const captureId = p.providerTxnId?.replace(/^PAYPAL:/, "");
    if (!captureId) throw conflict("Missing PayPal capture id");
    const r = await refundPaypalCapture(captureId, toNum(p.amount).toFixed(2), p.reference);
    externalId = r.id;
  } else {
    // KHQR / USDT / CASH have no programmatic refund API – staff must send funds back and record the reference.
    if (p.method.code !== "CASH" && !opts.manualReference) throw badRequest("Enter the refund transaction reference (bank / blockchain) after sending the funds back");
    externalId = opts.manualReference;
  }
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${p.id} FOR UPDATE`;
    const locked = await tx.payment.findUniqueOrThrow({ where: { id: p.id } });
    if (locked.status !== "PAID") throw conflict("Payment has already been refunded or is no longer paid");
    await tx.payment.update({ where: { id: p.id }, data: { status: "REFUNDED", refundedAt: new Date(), refundAmount: locked.amountUsd } });
    await tx.order.update({ where: { id: locked.orderId }, data: { paymentStatus: "REFUNDED" } });
    await logTx(tx, p.id, { type: "REFUND", status: "ok", message: reason, externalId, amount: toNum(locked.amount) });
  });
  await audit(actorUserId, "payment.refund", "Payment", p.id, { reason, externalId: externalId ?? null });
  return prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
}

// ───────────────────────────── presentation ─────────────────────────────

/**
 * Customer-safe failure text. Raw `failureReason` can contain provider error bodies, upstream HTTP
 * codes, account ids or RPC messages, so only a small allow-list of user-actionable messages is passed through.
 */
const SAFE_REASON_PREFIXES = [
  "Waiting for confirmations", "Transaction not found on", "Amount mismatch", "Payment window expired", "Order cancelled",
  "Transaction was made before this payment was created", "PayPal capture pending review",
];
export function publicFailureReason(status: string, reason: string | null): string | null {
  if (!reason) return null;
  if (SAFE_REASON_PREFIXES.some((x) => reason.startsWith(x))) return reason;
  if (status === "FAILED") return "We could not verify this payment. Please try again or contact the pharmacy.";
  if (status === "EXPIRED") return "This payment request has expired.";
  return "We could not complete this step. Please try again.";
}

/** `audience: "admin"` keeps the raw reason for staff; the default (customer/guest) is sanitised. */
export async function paymentView(p: Payment & { method?: { code: PaymentMethodCode } }, opts: { audience?: "admin" | "public" } = {}) {
  const method = p.method ?? (await prisma.paymentMethod.findUniqueOrThrow({ where: { id: p.methodId }, select: { code: true } }));
  let qrDataUrl: string | null = null;
  if (p.qrString && (p.status === "PENDING" || p.status === "PROCESSING")) {
    qrDataUrl = await QRCode.toDataURL(p.qrString, { margin: 1, width: 320, errorCorrectionLevel: "M" });
  }
  let merchant: Record<string, string> | null = null;
  let networkInfo: Record<string, string | number> | null = null;
  if (method.code === "KHQR") {
    const m = await prisma.paymentMethod.findUnique({ where: { code: "KHQR" } });
    const c = m ? khqrConfig(m) : null;
    merchant = c ? { name: c.merchantName, city: c.merchantCity, account: p.payToAddress ?? "" } : null;
  }
  if (method.code === "USDT" && p.network) {
    const m = await prisma.paymentMethod.findUnique({ where: { code: "USDT" } });
    const net = m ? usdtConfig(m).networks.find((n) => n.code === p.network) : undefined;
    const meta = USDT_NETWORK_META[p.network as UsdtNetworkCode];
    networkInfo = { code: p.network, label: meta.label, contract: net?.contractAddress ?? "", confirmations: net?.confirmations ?? 0, explorer: meta.explorerTx };
  }
  return {
    id: p.id,
    reference: p.reference,
    method: method.code,
    status: p.status,
    currency: p.currency,
    amount: method.code === "USDT" ? p.amount.toFixed(4) : method.code === "KHQR" && p.currency === "KHR" ? p.amount.toFixed(0) : p.amount.toFixed(2),
    amountUsd: p.amountUsd.toFixed(2),
    network: networkInfo,
    payTo: p.payToAddress,
    qrDataUrl,
    paypalOrderId: method.code === "PAYPAL" ? p.providerRef : null,
    paypalApproveUrl: method.code === "PAYPAL" && (p.status === "PENDING" || p.status === "PROCESSING") ? safePaypalApproveUrl(p.qrString) : null,
    txHash: method.code === "USDT" ? p.providerRef : null,
    providerTxnId: p.status === "PAID" || p.status === "REFUNDED" ? p.providerTxnId : null,
    failureReason: opts.audience === "admin" ? p.failureReason : publicFailureReason(p.status, p.failureReason),
    merchant,
    expiresAt: p.expiresAt,
    paidAt: p.paidAt,
    createdAt: p.createdAt,
  };
}

/** Background maintenance: re-check open payments, expire overdue ones. */
export async function sweepPayments() {
  const open = await prisma.payment.findMany({
    where: { status: { in: ["PENDING", "PROCESSING"] }, method: { code: { not: "CASH" } } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  let checked = 0;
  for (const p of open) {
    try {
      await checkPayment(p.id);
      checked++;
    } catch {
      /* logged in checkPayment */
    }
  }
  // stale cash payments from abandoned POS sales
  await prisma.payment.updateMany({ where: { status: "PENDING", method: { code: "CASH" }, createdAt: { lt: new Date(Date.now() - 6 * 3600_000) } }, data: { status: "EXPIRED", failureReason: "Abandoned" } });
  return checked;
}
