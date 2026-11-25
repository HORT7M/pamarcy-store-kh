import { prisma } from "@/lib/db";
import { requireCustomerPage } from "@/lib/auth/guards";
import { ProfileForms } from "@/components/shop/profile-forms";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const u = await requireCustomerPage();
  const user = await prisma.user.findUniqueOrThrow({ where: { id: u.id }, select: { name: true, email: true, phone: true, locale: true } });
  return <ProfileForms user={user} />;
}
