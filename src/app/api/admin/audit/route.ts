import type { Prisma } from "@prisma/client";
import { apiHandler, parseQuery, paginate } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { adminAuditQuerySchema } from "@/lib/validators";

export const GET = apiHandler(async (req) => {
  await requireStaff("audit.view");
  const p = parseQuery(req, adminAuditQuerySchema);
  const pg = paginate(p.page, p.pageSize ?? 30);
  const where: Prisma.AuditLogWhereInput = {};
  if (p.entity) where.entity = p.entity;

  if (p.q) {
    // Actor User.name is AES-256-GCM encrypted at rest; filter decrypted rows safely
    const needle = p.q.trim().toLowerCase();
    const all = await prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, take: 2000, include: { user: { select: { name: true } } } });
    const matched = all.filter((l) =>
      l.action.toLowerCase().includes(needle) ||
      l.entityId === p.q ||
      (l.user?.name.toLowerCase().includes(needle) ?? false),
    );
    return { total: matched.length, page: pg.page, pageSize: pg.pageSize, items: matched.slice(pg.skip, pg.skip + pg.take) };
  }

  const [total, items] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: pg.skip, take: pg.take, include: { user: { select: { name: true } } } }),
  ]);
  return { total, page: pg.page, pageSize: pg.pageSize, items };
});
