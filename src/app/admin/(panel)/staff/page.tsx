import { requireStaffPage } from "@/lib/auth/guards";
import { StaffClient } from "@/components/admin/staff-client";

export const dynamic = "force-dynamic";

export default async function AdminStaffPage() {
  const user = await requireStaffPage("users.manage");
  return <StaffClient currentUserId={user.id} />;
}
