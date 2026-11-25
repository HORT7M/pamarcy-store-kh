// Portable database backup (used when pg_dump is not installed on the host)
import { PrismaClient } from "@prisma/client";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";

if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}

const prisma = new PrismaClient();
const outDir = path.resolve(process.env.BACKUP_DIR || "backups");
mkdirSync(outDir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = path.join(outDir, `pamarcy-backup-${stamp}.json.gz`);

const snapshot = {
  createdAt: new Date().toISOString(),
  roles: await prisma.role.findMany({ include: { permissions: true } }),
  permissions: await prisma.permission.findMany(),
  users: await prisma.user.findMany({ include: { customer: true, employee: true } }),
  addresses: await prisma.address.findMany(),
  categories: await prisma.category.findMany(),
  brands: await prisma.brand.findMany(),
  suppliers: await prisma.supplier.findMany(),
  medicines: await prisma.medicine.findMany({ include: { inventory: true, batches: true } }),
  purchases: await prisma.purchase.findMany({ include: { items: true } }),
  orders: await prisma.order.findMany({ include: { items: { include: { allocations: true } }, payments: { include: { transactions: true } }, statusHistory: true } }),
  paymentMethods: await prisma.paymentMethod.findMany(),
  discounts: await prisma.discount.findMany(),
  banners: await prisma.banner.findMany(),
  systemSettings: await prisma.systemSetting.findMany(),
  auditLogs: await prisma.auditLog.findMany(),
};

writeFileSync(file, gzipSync(Buffer.from(JSON.stringify(snapshot, null, 2))), { mode: 0o600 });
await prisma.$disconnect();
console.log(`✔ Database backup written to ${file}`);
