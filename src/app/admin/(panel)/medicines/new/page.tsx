import { prisma } from "@/lib/db";
import { can } from "@/lib/auth/session";
import { requireStaffPage } from "@/lib/auth/guards";
import { getT } from "@/lib/i18n/server";
import { localizeCategoryName } from "@/lib/i18n/translate";
import { MedicineForm } from "@/components/admin/medicine-form";
import { PageHeader } from "@/components/admin/common";

export const dynamic = "force-dynamic";

export default async function NewMedicinePage() {
  const user = await requireStaffPage("medicines.write");
  const [{ t, tryT, locale }, cats, brands] = await Promise.all([
    getT(),
    prisma.category.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: "asc" }, select: { id: true, slug: true, nameEn: true, nameKm: true } }),
    prisma.brand.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  return (
    <div>
      <PageHeader title={t("medicinesAdmin.addMedicine")} subtitle={t("medicinesAdmin.newSubtitle")} />
      <MedicineForm
        categories={cats.map((c) => ({ id: c.id, name: localizeCategoryName(c, locale, tryT) }))}
        brands={brands}
        canAddOpeningStock={can(user, "inventory.write")}
      />
    </div>
  );
}
