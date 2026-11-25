import "server-only";
import { prisma } from "@/lib/db";
import { TIMEZONE, addDays, dayKey, startOfDayPP, startOfMonthPP, startOfYearPP, formatDate } from "@/lib/date";
import { badRequest } from "@/lib/errors";
import { sellableCutoff } from "./inventory";

export type Granularity = "day" | "week" | "month" | "year";
const GRANULARITIES: ReadonlySet<string> = new Set<Granularity>(["day", "week", "month", "year"]);

function assertValidDates(from: Date, to: Date) {
  if (!(from instanceof Date) || !(to instanceof Date) || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    throw badRequest("Invalid date range");
  }
}

/** Paid sales = orders with paymentStatus PAID (excludes refunded/cancelled-unpaid). */
export async function salesSummary(from: Date, to: Date) {
  assertValidDates(from, to);
  const [r] = await prisma.$queryRaw<{ revenue: number; orders: number; cost: number; discount: number; delivery: number; items: number }[]>`
    SELECT COALESCE(SUM(o.total),0)::float AS revenue, COUNT(*)::int AS orders, COALESCE(SUM(o."discountAmount"),0)::float AS discount, COALESCE(SUM(o."deliveryFee"),0)::float AS delivery,
      COALESCE((SELECT SUM(oi."unitCost" * oi."fulfilledQuantity") FROM "OrderItem" oi JOIN "Order" o2 ON o2.id = oi."orderId" WHERE o2."paymentStatus" = 'PAID' AND o2."createdAt" >= ${from} AND o2."createdAt" < ${to}),0)::float AS cost,
      COALESCE((SELECT SUM(oi.quantity) FROM "OrderItem" oi JOIN "Order" o2 ON o2.id = oi."orderId" WHERE o2."paymentStatus" = 'PAID' AND o2."createdAt" >= ${from} AND o2."createdAt" < ${to}),0)::int AS items
    FROM "Order" o WHERE o."paymentStatus" = 'PAID' AND o."createdAt" >= ${from} AND o."createdAt" < ${to}`;
  return r;
}

export async function salesSeries(from: Date, to: Date, g: Granularity) {
  assertValidDates(from, to);
  if (!GRANULARITIES.has(g)) throw badRequest("Invalid report granularity");
  const rows = await prisma.$queryRaw<{ bucket: Date; revenue: number; orders: number; cost: number }[]>`
    SELECT date_trunc(${g}, o."createdAt" AT TIME ZONE ${TIMEZONE}) AS bucket, SUM(o.total)::float AS revenue, COUNT(*)::int AS orders,
      COALESCE(SUM((SELECT SUM(oi."unitCost" * oi."fulfilledQuantity") FROM "OrderItem" oi WHERE oi."orderId" = o.id)),0)::float AS cost
    FROM "Order" o WHERE o."paymentStatus" = 'PAID' AND o."createdAt" >= ${from} AND o."createdAt" < ${to}
    GROUP BY 1 ORDER BY 1`;
  const map = new Map(rows.map((r) => [r.bucket.toISOString().slice(0, 10), r]));
  // fill gaps
  const out: { label: string; key: string; revenue: number; orders: number; cost: number; profit: number }[] = [];
  const [fy, fm, fd] = dayKey(from).split("-").map(Number);
  let cur = new Date(Date.UTC(fy, fm - 1, fd));
  if (g === "week") cur = new Date(cur.getTime() - ((cur.getUTCDay() + 6) % 7) * 86400000);
  if (g === "month") cur = new Date(Date.UTC(fy, fm - 1, 1));
  if (g === "year") cur = new Date(Date.UTC(fy, 0, 1));
  const end = new Date(to.getTime() + 7 * 3600000);
  while (cur < end && out.length < 2000) {
    const key = cur.toISOString().slice(0, 10);
    const r = map.get(key);
    const label = g === "year" ? key.slice(0, 4) : g === "month" ? `${key.slice(5, 7)}/${key.slice(0, 4)}` : `${key.slice(8, 10)}/${key.slice(5, 7)}`;
    out.push({ key, label, revenue: r?.revenue ?? 0, orders: r?.orders ?? 0, cost: r?.cost ?? 0, profit: (r?.revenue ?? 0) - (r?.cost ?? 0) });
    if (g === "day") cur = new Date(cur.getTime() + 86400000);
    else if (g === "week") cur = new Date(cur.getTime() + 7 * 86400000);
    else if (g === "month") cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    else cur = new Date(Date.UTC(cur.getUTCFullYear() + 1, 0, 1));
  }
  return out;
}

export async function topMedicines(from: Date, to: Date, limit = 10) {
  assertValidDates(from, to);
  const safeLimit = Math.min(10_000, Math.max(1, Math.trunc(Number(limit) || 10)));
  return prisma.$queryRaw<{ medicineId: string; nameEn: string; nameKm: string; sku: string; qty: number; revenue: number; cost: number }[]>`
    SELECT oi."medicineId", MAX(oi."nameEn") AS "nameEn", MAX(oi."nameKm") AS "nameKm", MAX(oi.sku) AS sku, SUM(oi.quantity)::int AS qty, SUM(oi."lineTotal")::float AS revenue,
      SUM(oi."unitCost" * oi."fulfilledQuantity")::float AS cost
    FROM "OrderItem" oi JOIN "Order" o ON o.id = oi."orderId"
    WHERE o."paymentStatus" = 'PAID' AND o."createdAt" >= ${from} AND o."createdAt" < ${to}
    GROUP BY oi."medicineId" ORDER BY qty DESC LIMIT ${safeLimit}`;
}

export async function paymentBreakdown(from: Date, to: Date) {
  assertValidDates(from, to);
  return prisma.$queryRaw<{ method: string; status: string; count: number; amount: number }[]>`
    SELECT pm.code AS method, p.status::text AS status, COUNT(*)::int AS count, SUM(p."amountUsd")::float AS amount
    FROM "Payment" p JOIN "PaymentMethod" pm ON pm.id = p."methodId"
    WHERE p."createdAt" >= ${from} AND p."createdAt" < ${to}
    GROUP BY 1, 2 ORDER BY 1, 2`;
}

export async function stockOverview() {
  const cutoff = sellableCutoff();
  const [r] = await prisma.$queryRaw<{ total: number; low: number; out: number; healthy: number; expiredBatches: number; expiringSoon: number; costValue: number; retailValue: number }[]>`
    WITH s AS (
      SELECT m.id, m.price, COALESCE(i."minStock",0) AS min,
        COALESCE(SUM(CASE WHEN b."expiryDate" IS NULL OR b."expiryDate" >= ${cutoff} THEN b.quantity - b.reserved ELSE 0 END),0) AS sellable,
        COALESCE(SUM(b.quantity * b."costPrice"),0) AS cost, COALESCE(SUM(b.quantity),0) AS units
      FROM "Medicine" m LEFT JOIN "Inventory" i ON i."medicineId"=m.id LEFT JOIN "MedicineBatch" b ON b."medicineId"=m.id
      WHERE m."deletedAt" IS NULL GROUP BY m.id, i."minStock")
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE sellable > 0 AND sellable <= min)::int AS low,
      COUNT(*) FILTER (WHERE sellable <= 0)::int AS out,
      COUNT(*) FILTER (WHERE sellable > min)::int AS healthy,
      (SELECT COUNT(*) FROM "MedicineBatch" WHERE quantity > 0 AND "expiryDate" < ${cutoff})::int AS "expiredBatches",
      (SELECT COUNT(*) FROM "MedicineBatch" WHERE quantity > 0 AND "expiryDate" >= ${cutoff} AND "expiryDate" < ${addDays(cutoff, 30)})::int AS "expiringSoon",
      COALESCE(SUM(cost),0)::float AS "costValue", COALESCE(SUM(units * price),0)::float AS "retailValue"
    FROM s`;
  return r;
}

export async function dashboardData() {
  const now = new Date();
  const today = startOfDayPP(now);
  const tomorrow = addDays(today, 1);
  const month = startOfMonthPP(now);
  const year = startOfYearPP(now);
  const epoch = new Date(0);
  const [all, todayS, monthS, orderCounts, customers, medicines, stock, daily, monthly, yearly, top, payments, recent] = await Promise.all([
    salesSummary(epoch, tomorrow),
    salesSummary(today, tomorrow),
    salesSummary(month, tomorrow),
    prisma.order.groupBy({ by: ["status"], _count: true }),
    prisma.customer.count({ where: { user: { deletedAt: null } } }),
    prisma.medicine.count({ where: { deletedAt: null } }),
    stockOverview(),
    salesSeries(addDays(today, -29), tomorrow, "day"),
    salesSeries(new Date(Date.UTC(Number(dayKey(now).slice(0, 4)) - 1, Number(dayKey(now).slice(5, 7)), 1, -7)), tomorrow, "month"),
    salesSeries(new Date(Date.UTC(Number(dayKey(now).slice(0, 4)) - 4, 0, 1, -7)), tomorrow, "year"),
    topMedicines(addDays(today, -89), tomorrow, 8),
    paymentBreakdown(addDays(today, -89), tomorrow),
    prisma.order.findMany({ orderBy: { createdAt: "desc" }, take: 8, select: { id: true, number: true, fullName: true, total: true, status: true, paymentStatus: true, channel: true, createdAt: true } }),
  ]);
  const counts = Object.fromEntries(orderCounts.map((c) => [c.status, c._count])) as Record<string, number>;
  const totalOrders = Object.values(counts).reduce((a, b) => a + b, 0);
  void year;
  return {
    totals: {
      totalSales: all.revenue, todaySales: todayS.revenue, todayOrders: todayS.orders, monthRevenue: monthS.revenue, monthProfit: monthS.revenue - monthS.cost,
      totalOrders, pendingOrders: counts.PENDING ?? 0, completedOrders: counts.DELIVERED ?? 0, customers, medicines,
      lowStock: stock.low, outOfStock: stock.out, expiredBatches: stock.expiredBatches, expiringSoon: stock.expiringSoon,
    },
    stock, daily, monthly, yearly, top, recent,
    payments: Object.values(payments.reduce<Record<string, { method: string; paid: number; count: number; failed: number; pending: number }>>((acc, r) => {
      acc[r.method] ??= { method: r.method, paid: 0, count: 0, failed: 0, pending: 0 };
      if (r.status === "PAID") { acc[r.method].paid += r.amount; acc[r.method].count += r.count; }
      if (r.status === "FAILED" || r.status === "EXPIRED") acc[r.method].failed += r.count;
      if (r.status === "PENDING" || r.status === "PROCESSING") acc[r.method].pending += r.count;
      return acc;
    }, {})),
  };
}

// ─────────────── Report builder (for CSV / PDF export) ───────────────

export type ReportType = "sales" | "medicine-sales" | "purchases" | "inventory" | "expiry" | "customers" | "profit-loss" | "payments";
export type Report = { title: string; columns: string[]; rows: (string | number)[][]; summary?: [string, string | number][] };

const money = (n: number) => Number(n.toFixed(2));

const REPORT_TYPES: ReadonlySet<string> = new Set<ReportType>(["sales", "medicine-sales", "purchases", "inventory", "expiry", "customers", "profit-loss", "payments"]);

export async function buildReport(type: ReportType, from: Date, to: Date, g: Granularity = "day"): Promise<Report> {
  assertValidDates(from, to);
  if (!REPORT_TYPES.has(type)) throw badRequest("Invalid report type");
  const period = `${formatDate(from)} – ${formatDate(addDays(to, -1))}`;
  switch (type) {
    case "sales": {
      const s = await salesSeries(from, to, g);
      const sum = await salesSummary(from, to);
      return {
        title: `Sales report (${g}) · ${period}`, columns: ["Period", "Orders", "Revenue (USD)", "Cost (USD)", "Gross profit (USD)"],
        rows: s.map((r) => [r.label, r.orders, money(r.revenue), money(r.cost), money(r.profit)]),
        summary: [["Orders", sum.orders], ["Revenue", money(sum.revenue)], ["Discounts", money(sum.discount)], ["Delivery fees", money(sum.delivery)], ["Gross profit", money(sum.revenue - sum.cost)]],
      };
    }
    case "medicine-sales": {
      const t = await topMedicines(from, to, 1000);
      return { title: `Medicine sales · ${period}`, columns: ["SKU", "Medicine", "Qty sold", "Revenue (USD)", "Cost (USD)", "Profit (USD)"], rows: t.map((r) => [r.sku, r.nameEn, r.qty, money(r.revenue), money(r.cost), money(r.revenue - r.cost)]) };
    }
    case "purchases": {
      const p = await prisma.purchase.findMany({ where: { orderedAt: { gte: from, lt: to } }, orderBy: { orderedAt: "asc" }, include: { supplier: true, _count: { select: { items: true } } } });
      const total = p.filter((x) => x.status !== "CANCELLED").reduce((a, x) => a + Number(x.total), 0);
      return { title: `Purchase report · ${period}`, columns: ["PO number", "Date", "Supplier", "Items", "Status", "Total (USD)"], rows: p.map((x) => [x.number, formatDate(x.orderedAt), x.supplier.name, x._count.items, x.status, money(Number(x.total))]), summary: [["Purchase orders", p.length], ["Total purchasing cost", money(total)]] };
    }
    case "inventory": {
      const cutoff = sellableCutoff();
      const rows = await prisma.$queryRaw<{ sku: string; name: string; onHand: number; reserved: number; expired: number; min: number; cost: number; retail: number }[]>`
        SELECT m.sku, m."nameEn" AS name, COALESCE(SUM(b.quantity),0)::int AS "onHand", COALESCE(SUM(b.reserved),0)::int AS reserved,
          COALESCE(SUM(CASE WHEN b."expiryDate" < ${cutoff} THEN b.quantity ELSE 0 END),0)::int AS expired, COALESCE(i."minStock",0)::int AS min,
          COALESCE(SUM(b.quantity*b."costPrice"),0)::float AS cost, (COALESCE(SUM(b.quantity),0)*m.price)::float AS retail
        FROM "Medicine" m LEFT JOIN "Inventory" i ON i."medicineId"=m.id LEFT JOIN "MedicineBatch" b ON b."medicineId"=m.id
        WHERE m."deletedAt" IS NULL GROUP BY m.id, i."minStock" ORDER BY m."nameEn"`;
      return {
        title: `Inventory valuation · ${formatDate(new Date())}`, columns: ["SKU", "Medicine", "On hand", "Reserved", "Expired", "Min stock", "Cost value (USD)", "Retail value (USD)"],
        rows: rows.map((r) => [r.sku, r.name, r.onHand, r.reserved, r.expired, r.min, money(r.cost), money(r.retail)]),
        summary: [["Units on hand", rows.reduce((a, r) => a + r.onHand, 0)], ["Cost value", money(rows.reduce((a, r) => a + r.cost, 0))], ["Retail value", money(rows.reduce((a, r) => a + r.retail, 0))]],
      };
    }
    case "expiry": {
      const b = await prisma.medicineBatch.findMany({ where: { quantity: { gt: 0 }, expiryDate: { not: null, lt: addDays(startOfDayPP(), 91) } }, orderBy: { expiryDate: "asc" }, include: { medicine: true } });
      const today = startOfDayPP();
      return {
        title: `Expiration report · ${formatDate(new Date())}`, columns: ["SKU", "Medicine", "Batch", "Expiry", "Days left", "Qty", "Cost value (USD)"],
        rows: b.map((x) => [x.medicine.sku, x.medicine.nameEn, x.batchNumber, formatDate(x.expiryDate), Math.floor((x.expiryDate!.getTime() - today.getTime()) / 86400000), x.quantity, money(x.quantity * Number(x.costPrice))]),
      };
    }
    case "customers": {
      const rows = await prisma.$queryRaw<{ name: string; email: string; phone: string | null; orders: number; spent: number; last: Date | null; joined: Date }[]>`
        SELECT u.name, u.email, u.phone, COUNT(o.id) FILTER (WHERE o."paymentStatus"='PAID')::int AS orders, COALESCE(SUM(o.total) FILTER (WHERE o."paymentStatus"='PAID'),0)::float AS spent,
          MAX(o."createdAt") AS last, u."createdAt" AS joined
        FROM "Customer" c JOIN "User" u ON u.id=c."userId" LEFT JOIN "Order" o ON o."customerId"=c.id AND o."createdAt" >= ${from} AND o."createdAt" < ${to}
        WHERE u."deletedAt" IS NULL GROUP BY u.id ORDER BY spent DESC`;
      return { title: `Customer report · ${period}`, columns: ["Name", "Email", "Phone", "Paid orders", "Spent (USD)", "Last order", "Joined"], rows: rows.map((r) => [r.name, r.email, r.phone ?? "", r.orders, money(r.spent), formatDate(r.last), formatDate(r.joined)]) };
    }
    case "profit-loss": {
      const s = await salesSummary(from, to);
      const purchases = await prisma.purchase.aggregate({ where: { orderedAt: { gte: from, lt: to }, status: { not: "CANCELLED" } }, _sum: { total: true } });
      const writeOffs = await prisma.$queryRaw<{ v: number }[]>`SELECT COALESCE(SUM(-quantity * "unitCost"),0)::float AS v FROM "StockMovement" WHERE type IN ('STOCK_OUT','EXPIRED_WRITE_OFF') AND "createdAt" >= ${from} AND "createdAt" < ${to}`;
      const adjustments = await prisma.$queryRaw<{ v: number }[]>`SELECT COALESCE(SUM(-quantity * "unitCost"),0)::float AS v FROM "StockMovement" WHERE type = 'ADJUSTMENT' AND "createdAt" >= ${from} AND "createdAt" < ${to}`;
      const refunds = await prisma.payment.aggregate({ where: { refundedAt: { gte: from, lt: to } }, _sum: { refundAmount: true } });
      const netSales = s.revenue - s.delivery;
      const gross = netSales - s.cost;
      const net = gross - writeOffs[0].v - adjustments[0].v;
      return {
        title: `Profit & loss · ${period}`, columns: ["Line", "Amount (USD)"],
        rows: [
          ["Gross sales (incl. delivery)", money(s.revenue)], ["Delivery fees collected", money(s.delivery)], ["Discounts given", money(-s.discount)], ["Net product sales", money(netSales)],
          ["Cost of goods sold (FEFO batch cost)", money(-s.cost)], ["Gross profit", money(gross)], ["Stock write-offs (damaged / expired)", money(-writeOffs[0].v)],
          ["Inventory adjustments", money(-adjustments[0].v)], ["Net operating profit", money(net)], ["Refunds issued (info)", money(Number(refunds._sum.refundAmount ?? 0))], ["Purchases ordered (info)", money(Number(purchases._sum.total ?? 0))],
        ],
        summary: [["Gross margin", netSales > 0 ? `${((gross / netSales) * 100).toFixed(1)}%` : "—"]],
      };
    }
    case "payments": {
      const p = await prisma.payment.findMany({ where: { createdAt: { gte: from, lt: to } }, orderBy: { createdAt: "asc" }, include: { method: true, order: { select: { number: true } } } });
      const paid = p.filter((x) => x.status === "PAID");
      return {
        title: `Payment report · ${period}`, columns: ["Reference", "Order", "Date", "Method", "Status", "Currency", "Amount", "USD", "Provider transaction"],
        rows: p.map((x) => [x.reference, x.order.number, formatDate(x.createdAt), x.method.code, x.status, x.currency, x.amount.toString(), money(Number(x.amountUsd)), x.providerTxnId ?? ""]),
        summary: [["Payments", p.length], ["Paid", paid.length], ["Collected (USD)", money(paid.reduce((a, x) => a + Number(x.amountUsd), 0))]],
      };
    }
  }
}
