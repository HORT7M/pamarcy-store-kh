import { requireStaff } from "@/lib/auth/session";
import { CategoriesClient } from "@/components/admin/categories-client";

export const dynamic = "force-dynamic";

export default async function AdminCategoriesPage() {
  await requireStaff("categories.write");
  return <CategoriesClient />;
}
