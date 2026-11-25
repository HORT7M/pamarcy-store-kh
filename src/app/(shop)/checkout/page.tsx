import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth/session";
import { CheckoutForm } from "@/components/shop/checkout-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Checkout" };

export default async function CheckoutPage() {
  const user = await getCurrentUser();
  const addresses = user?.customerId ? await prisma.address.findMany({ where: { customerId: user.customerId }, orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }] }) : [];
  return <CheckoutForm user={user && !user.isStaff ? { name: user.name, email: user.email, phone: user.phone } : null} addresses={addresses.map((a) => ({ ...a, createdAt: a.createdAt.toISOString(), updatedAt: a.updatedAt.toISOString() }))} />;
}
