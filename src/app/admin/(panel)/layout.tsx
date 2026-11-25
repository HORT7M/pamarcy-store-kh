import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { AdminShell } from "@/components/admin/admin-shell";

export const metadata = { title: { default: "Admin · Pamarcy Store", template: "%s · Pamarcy Admin" }, robots: { index: false } };

export default async function AdminPanelLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/admin/login");
  if (!user.isStaff) redirect("/");
  return (
    <AdminShell user={{ id: user.id, name: user.name, email: user.email, role: user.role, permissions: user.permissions }}>
      {children}
    </AdminShell>
  );
}
