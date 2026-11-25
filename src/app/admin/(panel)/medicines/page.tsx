import { prisma } from "@/lib/db";
import { requireStaff, can } from "@/lib/auth/session";
import { MedicinesClient } from "@/components/admin/medicines-client";

export const dynamic = "force-dynamic";

export default async function AdminMedicinesPage() {
  const user = await requireStaff("medicines.read");
  const categories = await prisma.category.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: "asc" }, select: { id: true, nameEn: true } });
  return <MedicinesClient categories={categories} canWrite={can(user, "medicines.write")} />;
}
