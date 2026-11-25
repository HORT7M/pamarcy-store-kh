import { apiHandler, parseQuery } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { adminBatchesQuerySchema } from "@/lib/validators";

export const GET = apiHandler(async (req) => {
  await requireStaff("inventory.read");
  const { medicineId } = parseQuery(req, adminBatchesQuerySchema);
  const batches = await prisma.medicineBatch.findMany({
    where: { medicineId },
    orderBy: [{ expiryDate: "asc" }, { receivedAt: "asc" }],
    include: { supplier: { select: { name: true } } },
  });
  return { batches };
});
