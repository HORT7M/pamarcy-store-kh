import { apiHandler, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { stockInSchema } from "@/lib/validators";
import { pickAllowed, STOCK_IN_FIELDS } from "@/lib/allowlist";
import { sellableCutoff, stockIn } from "@/lib/services/inventory";
import { parseDateInput } from "@/lib/date";
import { audit } from "@/lib/audit";
import { badRequest } from "@/lib/errors";

export const POST = apiHandler(async (req) => {
  const user = await requireStaff("inventory.write");
  const b = await parseBody(req, stockInSchema);
  const fields = pickAllowed(b, STOCK_IN_FIELDS);
  const med = await prisma.medicine.findFirst({ where: { id: fields.medicineId, deletedAt: null } });
  if (!med) throw badRequest("Medicine not found");
  if (fields.supplierId) {
    const sup = await prisma.supplier.findFirst({ where: { id: fields.supplierId, deletedAt: null }, select: { id: true } });
    if (!sup) throw badRequest("Supplier not found");
  }
  if (med.tracksExpiry && !b.expiryDate) throw badRequest("Expiry date is required for this medicine");
  if (b.expiryDate && parseDateInput(b.expiryDate) < sellableCutoff()) throw badRequest("Cannot receive stock that is already expired");
  const batchId = await prisma.$transaction((tx) =>
    stockIn(tx, {
      ...fields,
      expiryDate: b.expiryDate ? parseDateInput(b.expiryDate) : null,
      manufactureDate: b.manufactureDate ? parseDateInput(b.manufactureDate) : null,
      reason: b.reason ?? "Manual stock in",
      userId: user.id,
      type: "STOCK_IN",
    }),
  );
  await audit(user.id, "inventory.stock_in", "MedicineBatch", batchId, { medicineId: fields.medicineId, qty: fields.quantity, batch: fields.batchNumber });
  return { ok: true, batchId };
});
