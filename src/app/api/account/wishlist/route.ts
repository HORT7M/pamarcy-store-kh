import { apiHandler, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireCustomer } from "@/lib/auth/session";
import { toCards, productCardInclude } from "@/lib/catalog";
import { wishlistToggleSchema } from "@/lib/validators";
import { notFound } from "@/lib/errors";

export const GET = apiHandler(async () => {
  const u = await requireCustomer();
  const items = await prisma.wishlistItem.findMany({ where: { customerId: u.customerId }, include: { medicine: { include: productCardInclude } }, orderBy: { createdAt: "desc" } });
  return { items: await toCards(items.map((i) => i.medicine).filter((m) => !m.deletedAt && m.isActive)) };
});

export const POST = apiHandler(async (req) => {
  const u = await requireCustomer();
  const { medicineId } = await parseBody(req, wishlistToggleSchema);
  const existing = await prisma.wishlistItem.findUnique({ where: { customerId_medicineId: { customerId: u.customerId, medicineId } } });
  if (existing) {
    await prisma.wishlistItem.delete({ where: { customerId_medicineId: { customerId: u.customerId, medicineId } } });
    return { wished: false };
  }
  const med = await prisma.medicine.findFirst({ where: { id: medicineId, deletedAt: null, isActive: true }, select: { id: true } });
  if (!med) throw notFound("Product not found");
  await prisma.wishlistItem.create({ data: { customerId: u.customerId, medicineId } });
  return { wished: true };
});
