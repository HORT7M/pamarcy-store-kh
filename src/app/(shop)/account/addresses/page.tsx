import { prisma } from "@/lib/db";
import { requireCustomer } from "@/lib/auth/session";
import { AddressBook } from "@/components/shop/address-book";

export const dynamic = "force-dynamic";

export default async function AddressesPage() {
  const user = await requireCustomer();
  const addresses = await prisma.address.findMany({ where: { customerId: user.customerId }, orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }] });
  return <AddressBook initial={addresses.map((a) => ({ ...a, createdAt: a.createdAt.toISOString(), updatedAt: a.updatedAt.toISOString() }))} />;
}
