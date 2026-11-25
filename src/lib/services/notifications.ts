import "server-only";
import { prisma, type Tx } from "@/lib/db";
import { ROLES, type Permission, type RoleKey } from "@/lib/auth/permissions";
import { getSettings } from "@/lib/settings";
import { serverEnv } from "@/lib/env";
import { safeExternalUrl, safeInternalPath } from "@/lib/sanitize";
import { sendSafeHtmlEmail } from "./email";

export type NotificationType =
  | "ORDER_NEW" | "ORDER_CANCELLED" | "PAYMENT_PAID" | "PAYMENT_FAILED" | "PAYMENT_PENDING"
  | "STOCK_LOW" | "EXPIRING" | "EXPIRED" | "CUSTOMER_NEW" | "PRESCRIPTION_REVIEW" | "ORDER_STATUS";

const AUDIENCE: Record<NotificationType, Permission> = {
  ORDER_NEW: "orders.read",
  ORDER_CANCELLED: "orders.read",
  ORDER_STATUS: "orders.read",
  PAYMENT_PAID: "payments.read",
  PAYMENT_FAILED: "payments.read",
  PAYMENT_PENDING: "payments.read",
  STOCK_LOW: "inventory.read",
  EXPIRING: "inventory.read",
  EXPIRED: "inventory.read",
  CUSTOMER_NEW: "customers.read",
  PRESCRIPTION_REVIEW: "prescriptions.review",
};

const EMAIL_TYPES: NotificationType[] = ["ORDER_NEW", "PAYMENT_PAID", "PAYMENT_FAILED", "STOCK_LOW", "EXPIRED", "PRESCRIPTION_REVIEW"];

function buildNotificationEmailLink(relativeLink: string | null): string | null {
  if (!relativeLink) return null;
  const base = serverEnv.appUrl?.replace(/\/+$/, "");
  if (!base) return null;
  return safeExternalUrl(`${base}${relativeLink}`, { allowHttp: true });
}

/** Notify every active staff member whose role has the permission tied to this notification type. */
export async function notifyStaff(
  n: { type: NotificationType; title: string; message: string; link?: string; dedupeKey?: string },
  tx: Tx = prisma,
) {
  const safeLink = safeInternalPath(n.link) ?? undefined;
  const perm = AUDIENCE[n.type];
  const roleKeys = (Object.keys(ROLES) as RoleKey[]).filter((k) => (ROLES[k].permissions as readonly string[]).includes(perm));
  const users = await tx.user.findMany({
    where: { status: "ACTIVE", deletedAt: null, role: { key: { in: roleKeys } } },
    select: { id: true },
  });
  if (!users.length) return;
  await tx.notification.createMany({
    data: users.map((u) => ({ userId: u.id, type: n.type, title: n.title, message: n.message, link: safeLink, dedupeKey: n.dedupeKey })),
    skipDuplicates: true,
  });
  if (EMAIL_TYPES.includes(n.type)) {
    // fire-and-forget; never block business transactions on email
    void (async () => {
      const s = await getSettings();
      if (s.emailNotifications && s.notificationEmail) {
        await sendSafeHtmlEmail(s.notificationEmail, `[Pamarcy] ${n.title}`, {
          title: n.title,
          message: n.message,
          linkUrl: buildNotificationEmailLink(safeLink ?? null),
          linkLabel: "Open in Admin Console",
        });
      }
    })().catch(() => {});
  }
}

export async function notifyUser(userId: string, n: { type: NotificationType; title: string; message: string; link?: string; dedupeKey?: string }, tx: Tx = prisma) {
  const safeLink = safeInternalPath(n.link) ?? undefined;
  await tx.notification.createMany({ data: [{ userId, ...n, link: safeLink }], skipDuplicates: true });
}
