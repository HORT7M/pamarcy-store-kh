import { apiHandler } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { addDays, startOfDayPP } from "@/lib/date";

/** GET /api/admin/inventory/expiry – batches grouped by expired / ≤7 / ≤30 / ≤90 days */
export const GET = apiHandler(async () => {
  await requireStaff("inventory.read");
  const today = startOfDayPP();
  const batches = await prisma.medicineBatch.findMany({
    where: { quantity: { gt: 0 }, expiryDate: { not: null, lte: addDays(today, 90) }, medicine: { deletedAt: null } },
    orderBy: { expiryDate: "asc" },
    include: { medicine: { select: { id: true, nameEn: true, nameKm: true, sku: true, price: true } }, supplier: { select: { name: true } } },
  });
  const tomorrow = addDays(today, 1);
  const group = (from: Date | null, to: Date) => batches.filter((b) => (from ? b.expiryDate! >= from : true) && b.expiryDate! < to);
  return {
    expired: group(null, tomorrow),
    within7: group(tomorrow, addDays(today, 8)),
    within30: group(addDays(today, 8), addDays(today, 31)),
    within90: group(addDays(today, 31), addDays(today, 91)),
  };
});
