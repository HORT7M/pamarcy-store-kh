import { apiHandler, parseBody, parseParams } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { adjustSchema, idParamSchema } from "@/lib/validators";
import { adjustBatch } from "@/lib/services/inventory";
import { audit } from "@/lib/audit";
import { checkLowStock } from "@/lib/services/orders";

/** POST /api/admin/inventory/batches/:id – stock out or adjustment (cycle count) for one batch */
export const POST = apiHandler<{ id: string }>(async (req, { params }) => {
  const user = await requireStaff("inventory.write");
  const { id } = await parseParams(params, idParamSchema);
  const b = await parseBody(req, adjustSchema);
  const r = await prisma.$transaction((tx) => adjustBatch(tx, { batchId: id, ...b, userId: user.id }));
  await audit(user.id, `inventory.${b.mode === "out" ? "stock_out" : "adjust"}`, "MedicineBatch", id, { ...b, delta: r.delta });
  const batch = await prisma.medicineBatch.findUniqueOrThrow({ where: { id } });
  await checkLowStock([batch.medicineId]);
  return r;
});
