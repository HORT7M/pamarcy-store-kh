import "server-only";
import { PrismaClient } from "@prisma/client";

if (typeof window !== "undefined") {
  throw new Error("Database client must never be executed in browser code.");
}

if (process.env.NEXT_PUBLIC_DATABASE_URL || process.env.NEXT_PUBLIC_DIRECT_URL || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Privileged database credentials or service-role keys must never use the NEXT_PUBLIC_ prefix.");
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"] });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;

/** Escape PostgreSQL LIKE / ILIKE wildcard and escape metacharacters (\, %, _). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
