"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Printer, CheckCircle2, XCircle, RefreshCw, RotateCcw, PackageCheck, FileText, Loader2, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { StatusBadge } from "@/components/common/status-badge";
import { useI18n } from "@/components/providers/i18n-provider";
import { formatDate, formatDateTime } from "@/lib/date";
import { formatKhPhone } from "@/lib/phone";
import { formatKHR, usdToKhr } from "@/lib/money";
import { api } from "@/lib/fetcher";
import { safePrescriptionHref } from "@/lib/sanitize";

type Detail = {
  id: string; number: string; channel: string; status: string; paymentStatus: string; fulfillmentStatus: string;
  prescriptionStatus: string; prescriptionUrl: string | null; prescriptionNote: string | null;
  fullName: string; phone: string; email: string | null; province: string | null; district: string | null; commune: string | null; village: string | null; street: string | null; instructions: string | null;
  subtotal: string; discountAmount: string; discountCode: string | null; deliveryFee: string; total: string; exchangeRate: number; notes: string | null; cancelReason: string | null; createdAt: string;
  items: { id: string; nameEn: string; nameKm: string; sku: string; quantity: number; fulfilledQuantity: number; unitPrice: string; lineTotal: string; allocations: { quantity: number; fulfilled: number; batch: { batchNumber: string; expiryDate: string | null } }[] }[];
  statusHistory: { id: string; status: string; note: string | null; userId: string | null; createdAt: string }[];
  payments: { id: string; reference: string; method: string; status: string; currency: string; amount: string; amountUsd: string; providerTxnId: string | null; failureReason: string | null; paidAt: string | null; createdAt: string; transactions: { id: string; type: string; status: string; message: string | null; externalId: string | null; createdAt: string }[] }[];
  users: Record<string, string>;
};

const NEXT: Record<string, { status: string; label: string } | undefined> = {
  PENDING: { status: "CONFIRMED", label: "Confirm Order" },
  CONFIRMED: { status: "PROCESSING", label: "Start Processing" },
  PROCESSING: { status: "READY_FOR_DELIVERY", label: "Mark Ready for Delivery" },
  READY_FOR_DELIVERY: { status: "SHIPPING", label: "Mark Out for Delivery" },
  SHIPPING: { status: "DELIVERED", label: "Mark Delivered" },
};

export function AdminOrderDetail({ orderId, perms }: { orderId: string; perms: { write: boolean; cancel: boolean; refund: boolean; rx: boolean } }) {
  const { money } = useI18n();
  const [o, setO] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [rxNote, setRxNote] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundForm, setRefundForm] = useState({ reason: "", manualReference: "" });
  const [fulfilQtys, setFulfilQtys] = useState<Record<string, number>>({});

  const load = useCallback(() => {
    api<Detail>(`/api/admin/orders/${orderId}`).then((d) => {
      setO(d);
      setFulfilQtys(Object.fromEntries(d.items.map((i) => [i.id, Math.max(0, i.quantity - i.fulfilledQuantity)])));
    });
  }, [orderId]);
  useEffect(load, [load]);

  if (!o) return <div className="flex items-center justify-center py-20 text-muted-foreground"><Loader2 className="animate-spin" /></div>;

  const next = NEXT[o.status];
  const paidPayment = o.payments.find((p) => p.status === "PAID");
  const canFulfilMore = perms.write && o.status !== "PENDING" && o.status !== "CANCELLED" && o.fulfillmentStatus !== "FULFILLED";
  const safeRxUrl = safePrescriptionHref(o.prescriptionUrl);

  async function advance(status: string, note?: string) {
    setBusy(true);
    try {
      await api(`/api/admin/orders/${orderId}/status`, { method: "POST", body: { status, note } });
      toast.success(`Order ${status.replace(/_/g, " ").toLowerCase()}`);
      setCancelOpen(false);
      load();
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  }

  async function reviewRx(approve: boolean) {
    setBusy(true);
    try {
      await api(`/api/admin/orders/${orderId}/prescription`, { method: "POST", body: { approve, note: rxNote || null } });
      toast.success(approve ? "Prescription approved" : "Prescription rejected");
      load();
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  }

  async function fulfil() {
    setBusy(true);
    try {
      await api(`/api/admin/orders/${orderId}/fulfil`, { method: "POST", body: { quantities: fulfilQtys } });
      toast.success("Stock fulfilled (FEFO)");
      load();
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  }

  async function checkPay(pid: string) {
    setBusy(true);
    try {
      await api(`/api/admin/payments/${pid}/check`, { method: "POST" });
      toast.success("Checked with provider");
      load();
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  }

  async function refund() {
    setBusy(true);
    try {
      await api(`/api/admin/orders/${orderId}/refund`, { method: "POST", body: refundForm });
      toast.success("Refund recorded");
      setRefundOpen(false);
      load();
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-5">
      <Link href="/admin/orders" className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"><ArrowLeft className="size-4" /> Back to orders</Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-mono text-2xl font-bold">{o.number}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{o.channel}</span> · <span>{formatDateTime(o.createdAt)}</span>
            <StatusBadge status={o.status} /><StatusBadge status={o.paymentStatus} /><StatusBadge status={o.fulfillmentStatus} />
            {o.prescriptionStatus !== "NOT_REQUIRED" && <StatusBadge status={o.prescriptionStatus} />}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm"><a href={`/invoice/${encodeURIComponent(o.id)}`} target="_blank" rel="noopener noreferrer"><Printer /> Invoice</a></Button>
          <Button asChild variant="outline" size="sm"><a href={`/invoice/${encodeURIComponent(o.id)}?format=receipt`} target="_blank" rel="noopener noreferrer"><Printer /> Receipt</a></Button>
          {perms.write && next && (
            <Button size="sm" onClick={() => advance(next.status)} disabled={busy || (next.status === "CONFIRMED" && o.paymentStatus !== "PAID")}>
              <CheckCircle2 /> {next.label}
            </Button>
          )}
          {perms.refund && paidPayment && <Button size="sm" variant="outline" onClick={() => setRefundOpen(true)}><RotateCcw /> Refund</Button>}
          {perms.cancel && o.status !== "CANCELLED" && o.status !== "DELIVERED" && (
            <Button size="sm" variant="destructive" onClick={() => setCancelOpen(true)} disabled={busy}><XCircle /> Cancel</Button>
          )}
        </div>
      </div>

      {o.cancelReason && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"><b>Cancelled:</b> {o.cancelReason}</div>}

      {/* Prescription Review */}
      {o.prescriptionStatus !== "NOT_REQUIRED" && (
        <section className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 font-semibold text-amber-900"><FileText className="size-5" /> Prescription Review</h2>
            <StatusBadge status={o.prescriptionStatus} />
          </div>
          {perms.rx && safeRxUrl && (
            <a href={safeRxUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-blue underline">
              View uploaded prescription <ExternalLink className="size-3.5" />
            </a>
          )}
          {o.prescriptionNote && <p className="whitespace-pre-line break-words text-sm"><b>Note:</b> {o.prescriptionNote}</p>}
          {perms.rx && o.prescriptionStatus === "PENDING_REVIEW" && (
            <div className="flex flex-wrap items-end gap-3 pt-2">
              <div className="min-w-64 flex-1"><Label className="text-xs">Pharmacist note (optional)</Label><Input value={rxNote} onChange={(e) => setRxNote(e.target.value)} className="bg-white" placeholder="Verified Dr. signature / dosage…" /></div>
              <Button onClick={() => reviewRx(true)} disabled={busy}><CheckCircle2 /> Approve Rx</Button>
              <Button variant="destructive" onClick={() => reviewRx(false)} disabled={busy}><XCircle /> Reject Rx</Button>
            </div>
          )}
        </section>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {/* Items & Fulfilment */}
          <section className="rounded-2xl border bg-white p-5 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold">Items & FEFO Batch Allocations</h2>
              {canFulfilMore && <Button size="sm" onClick={fulfil} disabled={busy}><PackageCheck /> Fulfil Selected</Button>}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs text-muted-foreground">
                  <tr><th className="py-2">Medicine</th><th className="py-2 text-right">Qty</th><th className="py-2 text-right">Fulfilled</th>{canFulfilMore && <th className="py-2 text-right">Pick now</th>}<th className="py-2 text-right">Total</th></tr>
                </thead>
                <tbody className="divide-y">
                  {o.items.map((i) => (
                    <tr key={i.id}>
                      <td className="py-2.5 pr-2">
                        <div className="font-medium">{i.nameEn}</div>
                        <div className="text-xs text-muted-foreground">{i.nameKm} · <span className="font-mono">{i.sku}</span></div>
                        {i.allocations.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {i.allocations.map((a, idx) => (
                              <span key={idx} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                                {a.batch.batchNumber} (exp {formatDate(a.batch.expiryDate)}): {a.fulfilled} picked{a.quantity > 0 ? `, ${a.quantity} res` : ""}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 text-right">{i.quantity}</td>
                      <td className="py-2.5 text-right font-medium">{i.fulfilledQuantity} / {i.quantity}</td>
                      {canFulfilMore && (
                        <td className="py-2.5 text-right">
                          <Input type="number" min={0} max={i.quantity - i.fulfilledQuantity} value={fulfilQtys[i.id] ?? 0} onChange={(e) => setFulfilQtys({ ...fulfilQtys, [i.id]: Number(e.target.value) || 0 })} className="ml-auto h-8 w-20 text-right" />
                        </td>
                      )}
                      <td className="py-2.5 text-right font-semibold">{money(i.lineTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <dl className="ml-auto mt-4 max-w-xs space-y-1 border-t pt-3 text-sm">
              <div className="flex justify-between"><dt className="text-muted-foreground">Subtotal</dt><dd>{money(o.subtotal)}</dd></div>
              {Number(o.discountAmount) > 0 && <div className="flex justify-between text-primary"><dt>Discount {o.discountCode && `(${o.discountCode})`}</dt><dd>−{money(o.discountAmount)}</dd></div>}
              {o.channel === "ONLINE" && <div className="flex justify-between"><dt className="text-muted-foreground">Delivery</dt><dd>{money(o.deliveryFee)}</dd></div>}
              <div className="flex justify-between border-t pt-1 text-base font-bold"><dt>Total</dt><dd>${Number(o.total).toFixed(2)} <span className="text-xs font-normal text-muted-foreground">({formatKHR(usdToKhr(o.total, o.exchangeRate))})</span></dd></div>
            </dl>
          </section>

          {/* Payments */}
          <section className="space-y-3 rounded-2xl border bg-white p-5 shadow-sm">
            <h2 className="font-semibold">Payments & Provider Transactions</h2>
            {o.payments.length === 0 ? <p className="text-sm text-muted-foreground">No payment attempts yet.</p> : o.payments.map((p) => (
              <div key={p.id} className="space-y-2 rounded-xl border p-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-bold">{p.method}</span><StatusBadge status={p.status} />
                    <span className="font-mono text-xs text-muted-foreground">{p.reference}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{p.currency} {p.amount}</span>
                    {(p.status === "PENDING" || p.status === "PROCESSING") && p.method !== "CASH" && (
                      <Button size="sm" variant="outline" onClick={() => checkPay(p.id)} disabled={busy}><RefreshCw className="size-3.5" /> Check Provider</Button>
                    )}
                  </div>
                </div>
                {p.providerTxnId && <div className="break-all font-mono text-xs text-emerald-700">Txn: {p.providerTxnId}</div>}
                {p.failureReason && <div className="text-xs text-red-600">{p.failureReason}</div>}
                {p.transactions.length > 0 && (
                  <div className="mt-2 space-y-1 border-t pt-2 text-xs text-muted-foreground">
                    {p.transactions.map((tx) => (
                      <div key={tx.id} className="flex justify-between gap-2">
                        <span><b>{tx.type}</b> ({tx.status}): {tx.message ?? tx.externalId ?? "—"}</span>
                        <span className="shrink-0">{formatDateTime(tx.createdAt)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </section>
        </div>

        <div className="space-y-5">
          <section className="space-y-1.5 rounded-2xl border bg-white p-5 text-sm shadow-sm">
            <h2 className="mb-2 font-semibold">Customer & Delivery</h2>
            <div className="font-medium">{o.fullName}</div>
            <div>{formatKhPhone(o.phone)}</div>
            {o.email && <div className="text-muted-foreground">{o.email}</div>}
            <div className="pt-1 text-muted-foreground">{[o.street, o.village, o.commune, o.district, o.province].filter(Boolean).join(", ") || "Counter / walk-in"}</div>
            {o.instructions && <div className="mt-2 whitespace-pre-line break-words rounded-lg bg-muted p-2 text-xs"><b>Instructions:</b> {o.instructions}</div>}
            {o.notes && <div className="mt-2 whitespace-pre-line break-words rounded-lg bg-muted p-2 text-xs"><b>Notes:</b> {o.notes}</div>}
          </section>

          <section className="rounded-2xl border bg-white p-5 shadow-sm">
            <h2 className="mb-3 font-semibold">Status Timeline</h2>
            <ol className="space-y-3 border-l-2 border-secondary pl-4 text-xs">
              {o.statusHistory.map((h) => (
                <li key={h.id}>
                  <div className="font-semibold">{h.status.replace(/_/g, " ")}</div>
                  {h.note && <div className="text-muted-foreground">{h.note}</div>}
                  <div className="text-[11px] text-muted-foreground">{formatDateTime(h.createdAt)}{h.userId ? ` · ${o.users[h.userId] ?? "Staff"}` : ""}</div>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>

      {/* Cancel Dialog */}
      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Cancel Order {o.number}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">Reserved stock will be released and fulfilled stock will be returned to batches.</p>
          <div className="space-y-1.5"><Label>Reason *</Label><Textarea value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="Customer requested cancellation / out of stock…" /></div>
          <DialogFooter><Button variant="outline" onClick={() => setCancelOpen(false)}>Back</Button><Button variant="destructive" onClick={() => advance("CANCELLED", cancelReason || "Cancelled by staff")} disabled={busy}>Confirm Cancel</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Refund Dialog */}
      <Dialog open={refundOpen} onOpenChange={setRefundOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Issue Refund ({paidPayment?.method})</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            {paidPayment?.method === "PAYPAL"
              ? "This will call PayPal's official Refund API to refund the captured payment automatically."
              : paidPayment?.method === "CASH"
                ? "Record cash returned to the customer at the counter."
                : `Send ${paidPayment?.currency} ${paidPayment?.amount} back via ${paidPayment?.method}, then enter the bank/blockchain refund transaction reference below.`}
          </p>
          <div className="space-y-3">
            <div className="space-y-1"><Label>Refund reason *</Label><Input value={refundForm.reason} onChange={(e) => setRefundForm({ ...refundForm, reason: e.target.value })} placeholder="Order cancelled / returned item" /></div>
            {paidPayment && !["PAYPAL", "CASH"].includes(paidPayment.method) && (
              <div className="space-y-1"><Label>Refund transaction reference *</Label><Input value={refundForm.manualReference} onChange={(e) => setRefundForm({ ...refundForm, manualReference: e.target.value })} className="font-mono text-xs" /></div>
            )}
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setRefundOpen(false)}>Cancel</Button><Button onClick={refund} disabled={busy || refundForm.reason.trim().length < 3}>{busy && <Loader2 className="animate-spin" />} Issue Refund</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
