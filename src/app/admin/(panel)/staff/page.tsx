import { requireStaff } from "@/lib/auth/session";
import { StaffClient } from "@/components/admin/staff-client";

export const dynamic = "force-dynamic";

export default async function AdminStaffPage() {
  const user = await requireStaff("users.manage");
  return <StaffClient currentUserId={user.id} />;
}
