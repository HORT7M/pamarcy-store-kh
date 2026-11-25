import { apiHandler, parseBody, parseParams } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { adjustSchema, idParamSchema } from "@/lib/validators";
import { BATCH_ADJUST_FIELDS, pickAllowed } from "@/lib/allowlist";
import { adjustBatch } from "@/lib/services/inventory";
import { audit } from "@/lib/audit";
import { checkLowStock } from "@/lib/services/orders";
import { notFound } from "@/lib/errors";

/** POST /api/admin/inventory/batches/:id – stock out or adjustment (cycle count) for one batch */
export const POST = apiHandler<{ id: string }>(async (req, { params }) => {
  const user = await requireStaff("inventory.write");
  const { id } = await parseParams(params, idParamSchema);
  const b = await parseBody(req, adjustSchema);
  const fields = pickAllowed(b, BATCH_ADJUST_FIELDS);
  const existing = await prisma.medicineBatch.findUnique({
    where: { id },
    select: { id: true, medicineId: true, medicine: { select: { deletedAt: true } } },
  });
  if (!existing || existing.medicine.deletedAt) throw notFound("Batch not found");
  const r = await prisma.$transaction((tx) => adjustBatch(tx, { batchId: id, ...fields, userId: user.id }));
  await audit(user.id, `inventory.${fields.mode === "out" ? "stock_out" : "adjust"}`, "MedicineBatch", id, { ...fields, delta: r.delta });
  await checkLowStock([existing.medicineId]);
  return r;
});
