import { apiHandler, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireCustomer } from "@/lib/auth/session";
import { addressSchema } from "@/lib/validators";
import { addressSelect } from "@/lib/public-select";
import { badRequest } from "@/lib/errors";

const MAX_ADDRESSES_PER_CUSTOMER = 25;

export const GET = apiHandler(async () => {
  const u = await requireCustomer();
  return { addresses: await prisma.address.findMany({ where: { customerId: u.customerId }, orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }], select: addressSelect }) };
});

export const POST = apiHandler(async (req) => {
  const u = await requireCustomer();
  const body = await parseBody(req, addressSchema);
  return prisma.$transaction(async (tx) => {
    const count = await tx.address.count({ where: { customerId: u.customerId } });
    if (count >= MAX_ADDRESSES_PER_CUSTOMER) {
      throw badRequest(`You can save at most ${MAX_ADDRESSES_PER_CUSTOMER} addresses`);
    }
    const isDefault = body.isDefault || count === 0;
    if (isDefault) await tx.address.updateMany({ where: { customerId: u.customerId }, data: { isDefault: false } });
    return tx.address.create({ data: { ...body, isDefault, customerId: u.customerId }, select: addressSelect });
  });
});
