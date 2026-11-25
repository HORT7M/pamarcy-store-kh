import "server-only";
import { PrismaClient } from "@prisma/client";
import { assertDatabaseClientRoleSecurity, assertDatabaseTransportSecurity, assertNoPublicSecrets } from "./env";
import { withFieldEncryption } from "./db-encryption";

if (typeof window !== "undefined") {
  throw new Error("Database client must never be executed in browser code.");
}

if (process.env.NEXT_PUBLIC_DATABASE_URL || process.env.NEXT_PUBLIC_DIRECT_URL || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Privileged database credentials or service-role keys must never use the NEXT_PUBLIC_ prefix.");
}

assertNoPublicSecrets();
assertDatabaseTransportSecurity(process.env.DATABASE_URL);
assertDatabaseClientRoleSecurity(process.env.DATABASE_URL, process.env.DIRECT_URL);

function createBasePrisma() {
  return new PrismaClient({ log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"] });
}

function createEncryptedPrisma(base: PrismaClient) {
  return withFieldEncryption(base);
}

export type EncryptedPrismaClient = ReturnType<typeof createEncryptedPrisma>;

const globalForPrisma = globalThis as unknown as {
  rawPrisma?: PrismaClient;
  prisma?: EncryptedPrismaClient;
};

/** Low-level unencrypted PrismaClient strictly for key-rotation/migration scripts & raw ciphertext verification. */
export const rawPrisma: PrismaClient = globalForPrisma.rawPrisma ?? createBasePrisma();

/** Primary application PrismaClient with transparent AES-256-GCM field encryption & blind-index lookups. */
export const prisma: EncryptedPrismaClient = globalForPrisma.prisma ?? createEncryptedPrisma(rawPrisma);

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.rawPrisma = rawPrisma;
  globalForPrisma.prisma = prisma;
}

export type Tx = Omit<
  EncryptedPrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
>;

/** Escape PostgreSQL LIKE / ILIKE wildcard and escape metacharacters (\, %, _). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
