import { apiHandler, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/session";
import { notificationsReadSchema } from "@/lib/validators";

/** GET – latest notifications for the current user (customer or staff). Polled by the UI for near-real-time updates. */
export const GET = apiHandler(async () => {
  const u = await requireUser();
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({ where: { userId: u.id }, orderBy: { createdAt: "desc" }, take: 30, select: { id: true, type: true, title: true, message: true, link: true, readAt: true, createdAt: true } }),
    prisma.notification.count({ where: { userId: u.id, readAt: null } }),
  ]);
  return { items, unread };
});

/** POST { ids?: string[] } – mark as read (all when ids omitted) */
export const POST = apiHandler(async (req) => {
  const u = await requireUser();
  const { ids } = await parseBody(req, notificationsReadSchema, { allowEmpty: true });
  await prisma.notification.updateMany({ where: { userId: u.id, readAt: null, ...(ids ? { id: { in: ids } } : {}) }, data: { readAt: new Date() } });
  return { ok: true };
});
