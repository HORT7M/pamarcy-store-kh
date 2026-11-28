import { apiHandler, parseBody, parseQuery } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { adminSuppliersQuerySchema, supplierSchema } from "@/lib/validators";
import { pickAllowed, SUPPLIER_WRITE_FIELDS } from "@/lib/allowlist";
import { audit } from "@/lib/audit";

export const GET = apiHandler(async (req) => {
  await requireStaff("suppliers.read");
  const { q } = parseQuery(req, adminSuppliersQuerySchema);
  const all = await prisma.supplier.findMany({
    where: { deletedAt: null },
    orderBy: { name: "asc" },
    include: { _count: { select: { purchases: true } }, purchases: { select: { total: true, status: true } } },
  });
  // Supplier contactName, phone, email, taxId are AES-256-GCM encrypted at rest
  const needle = q?.trim().toLowerCase();
  const phoneNeedle = q ? q.replace(/[\s\-()]/g, "").replace(/^0/, "").toLowerCase() : "";
  const items = needle
    ? all.filter((s) =>
        s.name.toLowerCase().includes(needle) ||
        (s.contactName?.toLowerCase().includes(needle) ?? false) ||
        (phoneNeedle ? (s.phone?.toLowerCase().includes(phoneNeedle) ?? false) : false) ||
        (s.email?.toLowerCase().includes(needle) ?? false) ||
        (s.taxId?.toLowerCase().includes(needle) ?? false),
      )
    : all;
  return {
    items: items.map(({ purchases, ...s }) => ({ ...s, totalPurchased: purchases.filter((p) => p.status !== "CANCELLED").reduce((a, p) => a + Number(p.total), 0) })),
  };
});

export const POST = apiHandler(async (req) => {
  const user = await requireStaff("suppliers.write");
  const body = await parseBody(req, supplierSchema);
  const s = await prisma.supplier.create({ data: pickAllowed(body, SUPPLIER_WRITE_FIELDS) });
  await audit(user.id, "supplier.create", "Supplier", s.id, { name: s.name });
  return s;
});
