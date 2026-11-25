import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { OrderStatus, PaymentMethodCode, PaymentStatus, PurchaseStatus, StockMovementType } from "@prisma/client";
import { z } from "zod";
import { prisma, escapeLike } from "../../src/lib/db.ts";
import { addDays, isValidIsoDate, parseDateInput, startOfDayPP } from "../../src/lib/date.ts";
import { paginate } from "../../src/lib/api.ts";
import { optionalQuery, optionalQueryDate } from "../../src/lib/validators.ts";
import {
  buildReport,
  dashboardData,
  paymentBreakdown,
  salesSeries,
  salesSummary,
  stockOverview,
  topMedicines,
  type Granularity,
  type ReportType,
} from "../../src/lib/services/reports.ts";
import { searchProducts } from "../../src/lib/catalog.ts";
import { sellableCutoff } from "../../src/lib/services/inventory.ts";

const ROOT = path.resolve(".");
const SQLI_PAYLOADS = [
  "' OR '1'='1",
  "'; DROP TABLE \"Order\"; --",
  "\" OR 1=1 --",
  "' UNION SELECT passwordHash FROM \"User\" --",
  "day', now()); SELECT pg_sleep(5); --",
  "100%_%\\",
  "\\'; DELETE FROM \"Medicine\"; --",
];

function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".next", ".git", ".pgdata", "backups"].includes(entry)) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) collectFiles(full, acc);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe("Static SQL injection & unsafe query audit", () => {
  const sourceFiles = [
    ...collectFiles(path.join(ROOT, "src")),
    ...collectFiles(path.join(ROOT, "prisma")),
    ...collectFiles(path.join(ROOT, "scripts")).filter((f) => !f.endsWith("sql-injection.test.mts")),
  ];

  it("forbids $queryRawUnsafe, $executeRawUnsafe, Prisma.raw, and dynamic Prisma.sql/join fragments", () => {
    const forbidden = /\$(?:queryRawUnsafe|executeRawUnsafe)\b|Prisma\.(?:raw|sql|join|empty)\b/;
    const hits: string[] = [];
    for (const file of sourceFiles) {
      const content = readFileSync(file, "utf8");
      if (forbidden.test(content)) hits.push(path.relative(ROOT, file));
    }
    assert.deepEqual(hits, [], `Unsafe SQL helpers found in: ${hits.join(", ")}`);
  });

  it("ensures every $queryRaw and $executeRaw call uses tagged template literal parameterization", () => {
    const callForm = /\$(?:queryRaw|executeRaw)(?:<[^>]*>)?\s*\(/;
    const hits: string[] = [];
    for (const file of sourceFiles) {
      const content = readFileSync(file, "utf8");
      if (callForm.test(content)) hits.push(path.relative(ROOT, file));
    }
    assert.deepEqual(hits, [], `Non-tagged raw SQL call found in: ${hits.join(", ")}`);
  });

  it("ensures no unvalidated enum query casts remain in API routes", () => {
    const badCast = /as Prisma\.(?:OrderWhereInput|PaymentWhereInput|PurchaseWhereInput|StockMovementWhereInput|EnumPaymentMethodCodeFilter)\[/;
    const apiFiles = collectFiles(path.join(ROOT, "src/app/api"));
    const hits: string[] = [];
    for (const file of apiFiles) {
      const content = readFileSync(file, "utf8");
      if (badCast.test(content)) hits.push(path.relative(ROOT, file));
    }
    assert.deepEqual(hits, [], `Unsafe Prisma enum casts found in: ${hits.join(", ")}`);
  });
});

describe("Input validation, escaping & pagination hardening", () => {
  it("escapes PostgreSQL LIKE/ILIKE metacharacters cleanly", () => {
    assert.equal(escapeLike("100%_test\\path"), "100\\%\\_test\\\\path");
    assert.equal(escapeLike("paracetamol"), "paracetamol");
  });

  it("rejects malformed and SQLi date strings in isValidIsoDate / parseDateInput / optionalQueryDate", () => {
    assert.equal(isValidIsoDate("2026-11-24"), true);
    assert.equal(isValidIsoDate("2026-02-30"), false);
    assert.equal(isValidIsoDate("2026-11-24' OR '1'='1"), false);
    for (const payload of SQLI_PAYLOADS) {
      assert.throws(() => parseDateInput(payload), /Invalid date/i);
      assert.equal(optionalQueryDate.safeParse(payload).success, false);
    }
    assert.equal(optionalQueryDate.parse(""), undefined);
    assert.equal(optionalQueryDate.parse("2026-11-24"), "2026-11-24");
  });

  it("rejects SQLi values on enum query validators while allowing empty string", () => {
    const schemas = [
      optionalQuery(z.enum(OrderStatus)),
      optionalQuery(z.enum(PaymentStatus)),
      optionalQuery(z.enum(PaymentMethodCode)),
      optionalQuery(z.enum(PurchaseStatus)),
      optionalQuery(z.enum(StockMovementType)),
    ];
    for (const s of schemas) {
      assert.equal(s.parse(""), undefined);
      for (const payload of SQLI_PAYLOADS) {
        assert.equal(s.safeParse(payload).success, false);
      }
    }
  });

  it("bounds pagination parameters to safe finite integers", () => {
    assert.deepEqual(paginate(Number.NaN, Number.POSITIVE_INFINITY), { skip: 0, take: 20, page: 1, pageSize: 20 });
    assert.deepEqual(paginate(-5, 9999), { skip: 0, take: 100, page: 1, pageSize: 100 });
    assert.deepEqual(paginate(1e12, 25), { skip: 9999 * 25, take: 25, page: 10_000, pageSize: 25 });
    assert.deepEqual(paginate(2.9, 10.7), { skip: 10, take: 10, page: 2, pageSize: 10 });
  });

  it("blocks runtime SQL injection in salesSeries granularity and buildReport type", async () => {
    const from = new Date("2026-01-01T00:00:00Z");
    const to = new Date("2026-01-31T00:00:00Z");
    for (const payload of SQLI_PAYLOADS) {
      await assert.rejects(() => salesSeries(from, to, payload as unknown as Granularity), /Invalid report granularity/i);
      await assert.rejects(() => buildReport(payload as unknown as ReportType, from, to), /Invalid report type/i);
    }
    await assert.rejects(() => salesSummary(new Date("invalid"), to), /Invalid date range/i);
  });
});

describe("Live PostgreSQL parameterized query verification", () => {
  it("executes all reporting raw SQL queries cleanly with bound parameters", async () => {
    const today = startOfDayPP();
    const from = addDays(today, -30);
    const to = addDays(today, 1);

    const summary = await salesSummary(from, to);
    assert.equal(typeof summary.revenue, "number");
    assert.equal(typeof summary.orders, "number");

    for (const g of ["day", "week", "month", "year"] as const) {
      const series = await salesSeries(from, to, g);
      assert.ok(Array.isArray(series));
    }

    const top = await topMedicines(from, to, 5);
    assert.ok(Array.isArray(top));
    const clampedTop = await topMedicines(from, to, -999);
    assert.ok(clampedTop.length <= 1);

    const pb = await paymentBreakdown(from, to);
    assert.ok(Array.isArray(pb));

    const stock = await stockOverview();
    assert.equal(typeof stock.total, "number");

    const dash = await dashboardData();
    assert.equal(typeof dash.totals.medicines, "number");

    const reportTypes: ReportType[] = [
      "sales",
      "medicine-sales",
      "purchases",
      "inventory",
      "expiry",
      "customers",
      "profit-loss",
      "payments",
    ];
    for (const type of reportTypes) {
      const rep = await buildReport(type, from, to, "day");
      assert.ok(rep.title.length > 0);
      assert.ok(Array.isArray(rep.rows));
    }
  });

  it("handles SQLi payloads and LIKE wildcards safely in inventory & catalogue queries", async () => {
    const cutoff = sellableCutoff();
    const totalMeds = await prisma.medicine.count({ where: { deletedAt: null } });
    assert.ok(totalMeds > 0, "Seeded database expected to contain medicines");

    // Wildcard "%" alone must NOT match all rows now that LIKE metacharacters are escaped
    const wildcardPattern = `%${escapeLike("%")}%`;
    const wildcardRows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT m.id
      FROM "Medicine" m
      LEFT JOIN "Inventory" i ON i."medicineId" = m.id
      LEFT JOIN "MedicineBatch" b ON b."medicineId" = m.id
      WHERE m."deletedAt" IS NULL
        AND (${wildcardPattern}::text IS NULL OR m."nameEn" ILIKE ${wildcardPattern} ESCAPE '\\' OR m.sku ILIKE ${wildcardPattern} ESCAPE '\\' OR m."nameKm" ILIKE ${wildcardPattern} ESCAPE '\\' OR m.barcode = ${"%"})
      GROUP BY m.id, i."minStock", i.location
      ORDER BY m."nameEn"`;
    assert.ok(wildcardRows.length < totalMeds, "Escaped % search must not return full table");

    for (const payload of SQLI_PAYLOADS) {
      const pattern = `%${escapeLike(payload)}%`;
      const rows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT m.id
        FROM "Medicine" m
        LEFT JOIN "Inventory" i ON i."medicineId" = m.id
        LEFT JOIN "MedicineBatch" b ON b."medicineId" = m.id
        WHERE m."deletedAt" IS NULL
          AND (${pattern}::text IS NULL OR m."nameEn" ILIKE ${pattern} ESCAPE '\\' OR m.sku ILIKE ${pattern} ESCAPE '\\' OR m."nameKm" ILIKE ${pattern} ESCAPE '\\' OR m.barcode = ${payload})
        GROUP BY m.id, i."minStock", i.location
        ORDER BY m."nameEn"`;
      assert.equal(rows.length, 0, `Payload "${payload}" must not match unintended rows`);

      const catalog = await searchProducts({ q: payload });
      assert.equal(catalog.total, 0);
    }

    // Legitimate inventory search still works
    const paraPattern = `%${escapeLike("para")}%`;
    const paraRows = await prisma.$queryRaw<{ id: string; expired: number }[]>`
      SELECT m.id, COALESCE(SUM(CASE WHEN b."expiryDate" < ${cutoff} THEN b.quantity ELSE 0 END), 0)::int AS expired
      FROM "Medicine" m
      LEFT JOIN "Inventory" i ON i."medicineId" = m.id
      LEFT JOIN "MedicineBatch" b ON b."medicineId" = m.id
      WHERE m."deletedAt" IS NULL
        AND (${paraPattern}::text IS NULL OR m."nameEn" ILIKE ${paraPattern} ESCAPE '\\' OR m.sku ILIKE ${paraPattern} ESCAPE '\\' OR m."nameKm" ILIKE ${paraPattern} ESCAPE '\\' OR m.barcode = ${"para"})
      GROUP BY m.id, i."minStock", i.location`;
    assert.ok(paraRows.length >= 1, "Legitimate inventory query should match Paracetamol");

    // Verify low/out inventory raw queries execute cleanly
    const outRows = await prisma.$queryRaw<{ medicineId: string }[]>`SELECT "medicineId" FROM "Inventory" WHERE "quantity" - "reserved" <= 0`;
    const lowRows = await prisma.$queryRaw<{ medicineId: string }[]>`SELECT "medicineId" FROM "Inventory" WHERE "quantity" - "reserved" <= "minStock"`;
    assert.ok(Array.isArray(outRows) && Array.isArray(lowRows));

    // Confirm database integrity was never affected
    assert.equal(await prisma.medicine.count({ where: { deletedAt: null } }), totalMeds);
  });
});

after(async () => {
  await prisma.$disconnect();
});
