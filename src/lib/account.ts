import "server-only";
import { prisma } from "./db";
import type { OrderRow } from "@/components/shop/order-list";

export async function customerOrders(customerId: string, take = 50): Promise<OrderRow[]> {
  const orders = await prisma.order.findMany({ where: { customerId }, orderBy: { createdAt: "desc" }, take, include: { items: { select: { nameEn: true, nameKm: true } } } });
  return orders.map((o) => ({ id: o.id, number: o.number, createdAt: o.createdAt.toISOString(), total: o.total.toString(), status: o.status, paymentStatus: o.paymentStatus, itemCount: o.items.length, firstItems: o.items.slice(0, 2) }));
}
