import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { MedicineForm } from "@/components/admin/medicine-form";
import { PageHeader } from "@/components/admin/common";

export const dynamic = "force-dynamic";

export default async function NewMedicinePage() {
  await requireStaff("medicines.write");
  const [cats, brands] = await Promise.all([
    prisma.category.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: "asc" }, select: { id: true, nameEn: true } }),
    prisma.brand.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  return (
    <div>
      <PageHeader title="Add Medicine" subtitle="Create a new medicine in the catalogue" />
      <MedicineForm categories={cats.map((c) => ({ id: c.id, name: c.nameEn }))} brands={brands} />
    </div>
  );
}
