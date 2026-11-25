import { requireStaffPage } from "@/lib/auth/guards";
import { CategoriesClient } from "@/components/admin/categories-client";

export const dynamic = "force-dynamic";

export default async function AdminCategoriesPage() {
  await requireStaffPage("categories.write");
  return <CategoriesClient />;
}
