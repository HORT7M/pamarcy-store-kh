import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { AccountNav } from "@/components/shop/account-nav";

export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/account");
  if (user.isStaff) redirect("/admin");
  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
        <AccountNav name={user.name} />
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
