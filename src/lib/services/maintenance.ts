import "server-only";
import { prisma } from "@/lib/db";
import { pruneExpiredSessions } from "@/lib/auth/session";
import { pruneOrphanPrescriptions } from "@/lib/upload";
import { pruneExpiredPasswordResetTokens } from "@/lib/auth/password-reset";
import { addDays, dayKey, startOfDayPP } from "@/lib/date";
import { notifyStaff } from "./notifications";
import { expireStaleOrders } from "./orders";
import { sweepPayments } from "./payments";

/** Notify about expired / expiring batches (once per batch per day). */
export async function checkExpiry() {
  const today = startOfDayPP();
  const batches = await prisma.medicineBatch.findMany({
    where: { quantity: { gt: 0 }, expiryDate: { not: null, lte: addDays(today, 30) }, medicine: { deletedAt: null } },
    include: { medicine: { select: { nameEn: true, sku: true } } },
  });
  const day = dayKey(new Date());
  let n = 0;
  for (const b of batches) {
    const expired = b.expiryDate! < addDays(today, 1);
    await notifyStaff({
      type: expired ? "EXPIRED" : "EXPIRING",
      title: `${expired ? "Expired" : "Expiring soon"}: ${b.medicine.nameEn}`,
      message: `Batch ${b.batchNumber} (${b.quantity} units) ${expired ? "expired" : "expires"} on ${dayKey(b.expiryDate!).split("-").reverse().join("/")}.${expired ? " It is blocked from sale – write it off." : ""}`,
      link: `/admin/inventory/expiry`,
      dedupeKey: `${expired ? "exp" : "soon"}:${b.id}:${expired ? day : dayKey(b.expiryDate!)}`,
    });
    n++;
  }
  return n;
}

export async function runMaintenance() {
  const payments = await sweepPayments();
  const orders = await expireStaleOrders();
  const expiry = await checkExpiry();
  const sessionsPruned = await pruneExpiredSessions();
  const resetTokensPruned = await pruneExpiredPasswordResetTokens();
  const rxOrders = await prisma.order.findMany({
    where: { prescriptionUrl: { not: null } },
    select: { prescriptionUrl: true },
  });
  const orphanPrescriptionsPruned = await pruneOrphanPrescriptions(
    new Set(rxOrders.map((o) => o.prescriptionUrl).filter((u): u is string => Boolean(u))),
  );
  return {
    paymentsChecked: payments,
    ordersExpired: orders,
    expiryAlerts: expiry,
    sessionsPruned,
    resetTokensPruned,
    orphanPrescriptionsPruned,
  };
}
