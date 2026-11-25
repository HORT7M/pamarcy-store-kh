import { existsSync } from "node:fs";
import { describe, it, after } from "node:test";

if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}
import assert from "node:assert/strict";
import { BakongKHQR } from "bakong-khqr";
import { prisma } from "../../src/lib/db.ts";
import { normalizeKhPhone } from "../../src/lib/phone.ts";
import { roleHas } from "../../src/lib/auth/permissions.ts";
import { generateKhqr } from "../../src/lib/services/payments/khqr.ts";
import { isValidAddress, isValidTxHash, toUnits, fromUnits } from "../../src/lib/services/payments/usdt.ts";
import { stockIn, reserveForOrderItem, releaseOrderReservations, getAvailability } from "../../src/lib/services/inventory.ts";
import { createOrder, cancelOrder } from "../../src/lib/services/orders.ts";
import { addDays, startOfDayPP } from "../../src/lib/date.ts";

const APP = process.env.APP_URL || "http://localhost:3000";

describe("Cambodia localization helpers", () => {
  it("normalizes valid Cambodian phone numbers and rejects invalid ones", () => {
    assert.equal(normalizeKhPhone("012 345 678"), "+85512345678");
    assert.equal(normalizeKhPhone("+855 96 888 9999"), "+855968889999");
    assert.equal(normalizeKhPhone("85523900888"), "+85523900888");
    assert.equal(normalizeKhPhone("12345"), null);
    assert.equal(normalizeKhPhone("+1 555 123 4567"), null);
  });
});

describe("RBAC permissions matrix", () => {
  it("enforces separation of duties across all 6 roles", () => {
    assert.equal(roleHas("SUPER_ADMIN", "settings.payments"), true);
    assert.equal(roleHas("ADMIN", "settings.payments"), false);
    assert.equal(roleHas("ADMIN", "medicines.write"), true);
    assert.equal(roleHas("PHARMACIST", "prescriptions.review"), true);
    assert.equal(roleHas("CASHIER", "prescriptions.review"), false);
    assert.equal(roleHas("CASHIER", "pos.use"), true);
    assert.equal(roleHas("INVENTORY_STAFF", "purchases.write"), true);
    assert.equal(roleHas("INVENTORY_STAFF", "pos.use"), false);
    assert.equal(roleHas("CUSTOMER", "dashboard.view"), false);
  });
});

describe("Payment cryptography & EMVCo KHQR", () => {
  it("generates valid EMVCo KHQR payloads in USD and KHR", () => {
    const usd = generateKhqr(
      { merchantName: "Pamarcy Store", merchantCity: "Phnom Penh", accountId: "pamarcy@aclb", merchantType: "individual", currencies: ["USD", "KHR"], expiryMinutes: 15 },
      { amount: 18.5, currency: "USD", billNumber: "PM-TEST-001", expiresAt: new Date(Date.now() + 900_000) },
    );
    assert.equal(BakongKHQR.verify(usd.qr).isValid, true);
    assert.equal(usd.md5.length, 32);

    const khr = generateKhqr(
      { merchantName: "Pamarcy Store", merchantCity: "Phnom Penh", accountId: "pamarcy@aclb", merchantType: "individual", currencies: ["USD", "KHR"], expiryMinutes: 15 },
      { amount: 75900, currency: "KHR", billNumber: "PM-TEST-002", expiresAt: new Date(Date.now() + 900_000) },
    );
    assert.equal(BakongKHQR.verify(khr.qr).isValid, true);
  });

  it("validates USDT TRC20 & EVM addresses, tx hashes and exact token units", () => {
    assert.equal(isValidAddress("TRC20", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"), true);
    assert.equal(isValidAddress("TRC20", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6X"), false); // bad checksum
    assert.equal(isValidAddress("ERC20", "0xdAC17F958D2ee523a2206206994597C13D831ec7"), true);
    assert.equal(isValidTxHash("TRC20", "cef89faeeb694e6a372e4bc77289003e4b9eb378caf6ff07e641a0360cef82d8"), true);
    assert.equal(isValidTxHash("ERC20", "0xcef89faeeb694e6a372e4bc77289003e4b9eb378caf6ff07e641a0360cef82d8"), true);
    assert.equal(toUnits("12.5034", 6), 12503400n);
    assert.equal(fromUnits(12503400n, 6), "12.5034");
  });
});

describe("FEFO inventory, expiry blocking & order lifecycle", () => {
  it("never sells expired batches and picks earliest valid expiry first (FEFO)", async () => {
    const cat = await prisma.category.findFirstOrThrow({ where: { deletedAt: null } });
    const sku = `TEST-FEFO-${Date.now()}`;
    const med = await prisma.medicine.create({
      data: { slug: sku.toLowerCase(), sku, nameEn: "FEFO Test Med", nameKm: "ថ្នាំតេស្ត", categoryId: cat.id, price: 5, costPrice: 2, tracksExpiry: true, inventory: { create: { minStock: 5 } } },
    });
    const today = startOfDayPP();
    // Create 1 expired batch directly + 2 valid batches with different expiries
    const expiredBatch = await prisma.medicineBatch.create({
      data: { medicineId: med.id, batchNumber: "EXP-1", expiryDate: addDays(today, -5), quantity: 50, costPrice: 2 },
    });
    await prisma.$transaction(async (tx) => {
      await stockIn(tx, { medicineId: med.id, batchNumber: "LATE-1", expiryDate: addDays(today, 180), quantity: 20, costPrice: 2 });
      await stockIn(tx, { medicineId: med.id, batchNumber: "SOON-1", expiryDate: addDays(today, 25), quantity: 10, costPrice: 2 });
    });

    // Sellable must be 30 (10 + 20), NOT 80 (expired 50 excluded!)
    const avail = await getAvailability(prisma, [med.id]);
    assert.equal(avail.get(med.id), 30);

    // Ordering 15 units must allocate all 10 from SOON-1 and 5 from LATE-1, and 0 from EXP-1
    const order = await createOrder({
      channel: "ONLINE", items: [{ medicineId: med.id, quantity: 15 }], fullName: "Test Buyer", phone: "+85512999888", province: "Phnom Penh", district: "Doun Penh",
    }, null);
    const allocs = await prisma.orderItemAllocation.findMany({ where: { orderItem: { orderId: order.id } }, include: { batch: true } });
    const byBatch = Object.fromEntries(allocs.map((a) => [a.batch.batchNumber, a.quantity]));
    assert.equal(byBatch["EXP-1"], undefined);
    assert.equal(byBatch["SOON-1"], 10);
    assert.equal(byBatch["LATE-1"], 5);

    // Cancelling releases all reservations
    await cancelOrder(order.id, null, "Test cleanup", { system: true });
    const availAfter = await getAvailability(prisma, [med.id]);
    assert.equal(availAfter.get(med.id), 30);

    // Cleanup test records
    await prisma.order.delete({ where: { id: order.id } });
    await prisma.stockMovement.deleteMany({ where: { medicineId: med.id } });
    await prisma.medicineBatch.deleteMany({ where: { id: { in: [expiredBatch.id] } } });
    await prisma.medicine.delete({ where: { id: med.id } });
  });

  it("blocks prescription-only online orders when no prescription is uploaded", async () => {
    const rxMed = await prisma.medicine.findFirstOrThrow({ where: { requiresPrescription: true, deletedAt: null } });
    await assert.rejects(
      () => createOrder({ channel: "ONLINE", items: [{ medicineId: rxMed.id, quantity: 1 }], fullName: "Rx Test", phone: "+85512999888", province: "Phnom Penh", district: "Doun Penh" }, null),
      /prescription/i,
    );
  });
});

describe("HTTP API security & RBAC enforcement", () => {
  it("blocks unauthenticated and unauthorized access to admin endpoints", async () => {
    const unauth = await fetch(`${APP}/api/admin/dashboard`);
    assert.equal(unauth.status, 401);

    // Sign in as CASHIER and verify backend blocks restricted admin endpoints
    const login = await fetch(`${APP}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: APP },
      body: JSON.stringify({ identifier: "cashier@pamarcy.com.kh", password: process.env.SEED_STAFF_PASSWORD ?? "", scope: "admin" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    assert.ok(cookie.startsWith("pamarcy_session="));

    // Cashier CAN read POS methods
    const posRes = await fetch(`${APP}/api/admin/pos/methods`, { headers: { Cookie: cookie } });
    assert.equal(posRes.status, 200);

    // Cashier CANNOT access payment settings or staff management (403)
    const paySet = await fetch(`${APP}/api/admin/settings/payments`, { headers: { Cookie: cookie } });
    assert.equal(paySet.status, 403);
    const staffRes = await fetch(`${APP}/api/admin/staff`, { headers: { Cookie: cookie } });
    assert.equal(staffRes.status, 403);

    // Cross-origin POST is blocked by CSRF guard (403)
    const csrfRes = await fetch(`${APP}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: "https://evil.example.com" },
    });
    assert.equal(csrfRes.status, 403);

    // Valid same-origin logout succeeds
    const outRes = await fetch(`${APP}/api/auth/logout`, { method: "POST", headers: { Cookie: cookie, Origin: APP } });
    assert.equal(outRes.status, 200);
  });
});

after(async () => {
  await prisma.$disconnect();
});
