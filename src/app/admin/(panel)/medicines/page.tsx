import { prisma } from "@/lib/db";
import { can } from "@/lib/auth/session";
import { requireStaffPage } from "@/lib/auth/guards";
import { MedicinesClient } from "@/components/admin/medicines-client";

export const dynamic = "force-dynamic";

export default async function AdminMedicinesPage() {
  const user = await requireStaffPage("medicines.read");
  const categories = await prisma.category.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: "asc" }, select: { id: true, slug: true, nameEn: true, nameKm: true } });
  return <MedicinesClient categories={categories} canWrite={can(user, "medicines.write")} />;
}
