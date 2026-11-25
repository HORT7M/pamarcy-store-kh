import "server-only";
import { headers } from "next/headers";
import { prisma, type Tx } from "./db";
import type { Prisma } from "@prisma/client";

export async function audit(
  userId: string | null,
  action: string,
  entity: string,
  entityId?: string | null,
  meta?: Prisma.InputJsonValue,
  tx: Tx = prisma,
) {
  let ip: string | null = null;
  try {
    const h = await headers();
    ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  } catch {
    /* outside request scope */
  }
  await tx.auditLog.create({ data: { userId, action, entity, entityId: entityId ?? null, meta, ip } });
}
