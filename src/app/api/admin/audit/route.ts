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
  if (p.q) where.OR = [{ action: { contains: p.q, mode: "insensitive" } }, { entityId: p.q }, { user: { name: { contains: p.q, mode: "insensitive" } } }];
  const [total, items] = await Promise.all([prisma.auditLog.count({ where }), prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: pg.skip, take: pg.take, include: { user: { select: { name: true } } } })]);
  return { total, page: pg.page, pageSize: pg.pageSize, items };
});
