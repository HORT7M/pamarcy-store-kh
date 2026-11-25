import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { prisma } from "../../src/lib/db.ts";
import { hashSessionToken, SESSION_COOKIE } from "../../src/lib/auth/session.ts";
import { orderAccessToken } from "../../src/lib/order-access.ts";
import { createOrder, cancelOrder } from "../../src/lib/services/orders.ts";
import { storeUpload } from "../../src/lib/upload.ts";
import { hashPassword } from "../../src/lib/auth/password.ts";

if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}

const APP = process.env.APP_URL || "http://localhost:3000";
const cleanupFiles: string[] = [];
const cleanupSessions: string[] = [];

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, out);
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(full);
  }
  return out;
}

function makeValidPdf(): Uint8Array {
  return new TextEncoder().encode(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 100 100]/Parent 2 0 R>>endobj\nxref\n0 4\n0000000000 65535 f \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n180\n%%EOF\n",
  );
}

function makeFile(bytes: Uint8Array, name: string, type: string): File {
  return new File([bytes], name, { type });
}

async function createTestSessionCookie(userId: string, isStaff: boolean): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashSessionToken(token);
  const now = new Date();
  await prisma.session.create({
    data: {
      tokenHash,
      userId,
      scope: isStaff ? "admin" : "customer",
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 3_600_000),
    },
  });
  cleanupSessions.push(tokenHash);
  return `${SESSION_COOKIE}=${token}`;
}

async function findUserByRoleKey(roleKey: string, skip = 0) {
  const u = await prisma.user.findFirst({
    where: { deletedAt: null, status: "ACTIVE", role: { key: roleKey } },
    include: { customer: true, role: true },
    orderBy: { createdAt: "asc" },
    skip,
  });
  assert.ok(u, `Expected active user with role ${roleKey} (skip=${skip})`);
  return u;
}

describe("Static database record access-control invariants", () => {
  it("enforces explicit RBAC permissions on every /api/admin/** route (no bare requireStaff())", () => {
    const adminRoutes = walkFiles("src/app/api/admin").filter((f) => f.endsWith("route.ts"));
    assert.ok(adminRoutes.length >= 25, `Expected >=25 admin API routes, found ${adminRoutes.length}`);
    for (const file of adminRoutes) {
      const content = readFileSync(file, "utf8");
      const handlers = [...content.matchAll(/export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=/g)];
      assert.ok(handlers.length > 0, `Expected HTTP handlers in ${file}`);
      assert.equal(
        /\brequireStaff\(\s*\)/.test(content),
        false,
        `${file} must not call bare requireStaff() without an explicit permission`,
      );
      const permCalls = [...content.matchAll(/\brequireStaff\(\s*["'][a-z]+\.[a-z]+["']\s*\)/g)];
      assert.ok(
        permCalls.length >= handlers.length,
        `${file} has ${handlers.length} handlers but only ${permCalls.length} explicit requireStaff("<perm>") calls`,
      );
    }
  });

  it("enforces authenticated ownership scoping on every /api/account/** route", () => {
    const accountRoutes = walkFiles("src/app/api/account").filter((f) => f.endsWith("route.ts"));
    assert.ok(accountRoutes.length >= 6);
    for (const file of accountRoutes) {
      const content = readFileSync(file, "utf8");
      const handlers = [...content.matchAll(/export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=/g)];
      const authCalls = [...content.matchAll(/\b(requireCustomer|requireUser)\(\s*\)/g)];
      assert.ok(
        authCalls.length >= handlers.length,
        `${file} has ${handlers.length} handlers but only ${authCalls.length} requireCustomer/requireUser calls`,
      );
    }
  });

  it("enforces Server-Component page guards on every admin and customer account page", () => {
    const adminPages = walkFiles("src/app/admin/(panel)").filter((f) => f.endsWith("page.tsx"));
    assert.ok(adminPages.length >= 15);
    for (const file of adminPages) {
      const content = readFileSync(file, "utf8");
      assert.match(
        content,
        /\b(requireStaffPage|requireStaffAnyPage)\(/,
        `${file} must use requireStaffPage/requireStaffAnyPage instead of raw requireStaff`,
      );
      assert.equal(
        /\brequireStaff\(/.test(content),
        false,
        `${file} should not throw uncaught ApiError via requireStaff()`,
      );
    }

    const accountPages = walkFiles("src/app/(shop)/account").filter((f) => f.endsWith("page.tsx"));
    assert.ok(accountPages.length >= 6);
    for (const file of accountPages) {
      const content = readFileSync(file, "utf8");
      assert.match(content, /\brequireCustomerPage\(/, `${file} must call requireCustomerPage()`);
    }
  });

  it("ensures guest HMAC order tokens are strictly scoped to unowned ONLINE guest orders", () => {
    const oa = readFileSync("src/lib/order-access.ts", "utf8");
    assert.match(oa, /order\.customerId\s*===\s*null\s*&&\s*order\.channel\s*===\s*["']ONLINE["']/);
    const rx = readFileSync("src/app/api/files/prescriptions/[name]/route.ts", "utf8");
    assert.match(rx, /customerId:\s*null,\s*channel:\s*["']ONLINE["']/);
  });
});

describe("Live HTTP horizontal IDOR, cross-channel, cross-cashier & vertical RBAC enforcement", () => {
  it("blocks horizontal IDOR, existence oracles, guest-token misuse, cross-channel mutations, cross-cashier mutations, and RBAC bypasses", async (t) => {
    try {
      const ping = await fetch(`${APP}/api/categories`);
      if (!ping.ok) return t.skip(`Live app server not healthy at ${APP}`);
    } catch {
      return t.skip(`Live app server not reachable at ${APP}`);
    }

    const [custA, custB, cashierA, pharmacist, inventoryStaff, admin, superAdmin] = await Promise.all([
      findUserByRoleKey("CUSTOMER", 0),
      findUserByRoleKey("CUSTOMER", 1),
      findUserByRoleKey("CASHIER", 0),
      findUserByRoleKey("PHARMACIST", 0),
      findUserByRoleKey("INVENTORY_STAFF", 0),
      findUserByRoleKey("ADMIN", 0),
      findUserByRoleKey("SUPER_ADMIN", 0),
    ]);

    assert.ok(custA.customer && custB.customer && custA.id !== custB.id);

    // Create a temporary second cashier (Cashier B) to test cross-cashier POS isolation
    const cashierRole = await prisma.role.findUniqueOrThrow({ where: { key: "CASHIER" } });
    const cashierBEmail = `cashier-idor-${Date.now()}@pamarcy.test`;
    const cashierB = await prisma.user.create({
      data: {
        name: "Temp Cashier B",
        email: cashierBEmail,
        phone: `+85598${String(Date.now()).slice(-6)}`,
        passwordHash: await hashPassword("TempCashier99!"),
        roleId: cashierRole.id,
        status: "ACTIVE",
        employee: { create: { employeeCode: `EMP-TST-${Date.now().toString(36)}` } },
      },
    });

    const [
      custACookie,
      custBCookie,
      cashierACookie,
      cashierBCookie,
      pharmacistCookie,
      inventoryCookie,
      adminCookie,
    ] = await Promise.all([
      createTestSessionCookie(custA.id, false),
      createTestSessionCookie(custB.id, false),
      createTestSessionCookie(cashierA.id, true),
      createTestSessionCookie(cashierB.id, true),
      createTestSessionCookie(pharmacist.id, true),
      createTestSessionCookie(inventoryStaff.id, true),
      createTestSessionCookie(admin.id, true),
    ]);

    const otcMed = await prisma.medicine.findFirstOrThrow({
      where: { deletedAt: null, isActive: true, requiresPrescription: false, batches: { some: { quantity: { gt: 10 } } } },
    });
    const rxMed = await prisma.medicine.findFirstOrThrow({
      where: { deletedAt: null, isActive: true, requiresPrescription: true, batches: { some: { quantity: { gt: 5 } } } },
    });
    const cashMethod = await prisma.paymentMethod.findUniqueOrThrow({ where: { code: "CASH" } });
    const khqrMethod = await prisma.paymentMethod.findUniqueOrThrow({ where: { code: "KHQR" } });
    const usdtMethod = await prisma.paymentMethod.findUniqueOrThrow({ where: { code: "USDT" } });

    const createdOrderIds: string[] = [];
    let custAAddrId: string | null = null;
    let custANotifId: string | null = null;
    let tempSuperAdminCustomerId: string | null = null;

    try {
      // ── 1. Customer Address IDOR (PUT & DELETE) ──
      const addrA = await prisma.address.create({
        data: {
          customerId: custA.customer.id,
          label: "Private A",
          fullName: custA.name,
          phone: "+85512345678",
          province: "Phnom Penh",
          district: "Doun Penh",
          street: "St 100",
          isDefault: false,
        },
      });
      custAAddrId = addrA.id;

      const putForeignAddr = await fetch(`${APP}/api/account/addresses/${addrA.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: APP, Cookie: custBCookie },
        body: JSON.stringify({
          label: "Hijacked",
          fullName: "Attacker",
          phone: "012 345 678",
          province: "Phnom Penh",
          district: "Doun Penh",
          street: "Evil St",
          isDefault: true,
        }),
      });
      assert.equal(putForeignAddr.status, 404, "Customer B must get 404 updating Customer A address");

      const delForeignAddr = await fetch(`${APP}/api/account/addresses/${addrA.id}`, {
        method: "DELETE",
        headers: { Origin: APP, Cookie: custBCookie },
      });
      assert.equal(delForeignAddr.status, 404, "Customer B must get 404 deleting Customer A address");

      const addrStillIntact = await prisma.address.findUnique({ where: { id: addrA.id } });
      assert.ok(addrStillIntact, "Customer A address must still exist");
      assert.equal(addrStillIntact.label, "Private A");

      // ── 2. Customer Notification IDOR ──
      const notifA = await prisma.notification.create({
        data: { userId: custA.id, type: "ORDER_STATUS", title: "Secret A", message: "Only for A" },
      });
      custANotifId = notifA.id;

      const markForeignNotif = await fetch(`${APP}/api/account/notifications`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP, Cookie: custBCookie },
        body: JSON.stringify({ ids: [notifA.id] }),
      });
      assert.equal(markForeignNotif.status, 200);
      const notifAfter = await prisma.notification.findUniqueOrThrow({ where: { id: notifA.id } });
      assert.equal(notifAfter.readAt, null, "Customer B must NOT be able to mark Customer A notification read");

      // ── 3. Customer-Owned Rx Order & Prescription Access Control ──
      const storedCustRx = await storeUpload(makeFile(makeValidPdf(), "cust-a-rx.pdf", "application/pdf"), "prescriptions", {
        actorUserId: custA.id,
      });
      cleanupFiles.push(path.resolve("storage", "prescriptions", storedCustRx.fileName));
      const custRxCanonical = storedCustRx.url.split("?")[0]!;

      // Customer B cannot hijack Customer A's signed prescription upload claim URL
      const hijackRxOrder = await fetch(`${APP}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP, Cookie: custBCookie },
        body: JSON.stringify({
          items: [{ medicineId: rxMed.id, quantity: 1 }],
          fullName: "Customer B",
          phone: "017 888 002",
          province: "Phnom Penh",
          district: "Doun Penh",
          prescriptionUrl: storedCustRx.url,
        }),
      });
      assert.equal(hijackRxOrder.status, 400, "Customer B must be blocked from claiming Customer A's prescription upload");

      // Customer A creates their own Rx order via HTTP; token MUST be null (never exposed for authenticated orders!)
      const custAOrdRes = await fetch(`${APP}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP, Cookie: custACookie },
        body: JSON.stringify({
          items: [{ medicineId: rxMed.id, quantity: 1 }],
          fullName: custA.name,
          phone: "012 888 001",
          province: "Phnom Penh",
          district: "Doun Penh",
          prescriptionUrl: storedCustRx.url,
        }),
      });
      assert.equal(custAOrdRes.status, 200, `Customer A order creation failed: ${custAOrdRes.status}`);
      const custAOrdJson = (await custAOrdRes.json()) as { id: string; token: string | null };
      createdOrderIds.push(custAOrdJson.id);
      assert.equal(custAOrdJson.token, null, "Authenticated customer order must NOT emit a permanent guest HMAC token");

      // Attach a pending KHQR payment to Customer A's order for payment IDOR tests
      const custAPay = await prisma.payment.create({
        data: {
          reference: `PAY-IDOR-A-${Date.now()}`,
          orderId: custAOrdJson.id,
          methodId: khqrMethod.id,
          status: "PENDING",
          amountUsd: 10,
          currency: "USD",
          amount: 10,
        },
      });

      const forgedOrValidTokForCustA = orderAccessToken(custAOrdJson.id);
      const fakeId = "cm00000000000000000000000";

      // 3a. Unauthenticated with no token -> 401 BEFORE DB lookup (zero existence oracle)
      assert.equal((await fetch(`${APP}/api/orders/${custAOrdJson.id}`)).status, 401);
      assert.equal((await fetch(`${APP}/api/orders/${fakeId}`)).status, 401);
      assert.equal((await fetch(`${APP}/api/payments/${custAPay.id}`)).status, 401);
      assert.equal((await fetch(`${APP}/api/payments/${fakeId}`)).status, 401);

      // 3b. Unauthenticated WITH HMAC token against CUSTOMER-OWNED order -> 403 (guest tokens NEVER unlock customer orders!)
      assert.equal((await fetch(`${APP}/api/orders/${custAOrdJson.id}?token=${forgedOrValidTokForCustA}`)).status, 403);
      assert.equal((await fetch(`${APP}/api/payments/${custAPay.id}?token=${forgedOrValidTokForCustA}`)).status, 403);
      assert.equal(
        (await fetch(`${APP}${custRxCanonical}?orderId=${custAOrdJson.id}&token=${forgedOrValidTokForCustA}`)).status,
        403,
        "Guest token must NEVER grant access to a signed-in customer's prescription file",
      );

      // 3c. Customer B horizontal IDOR -> uniform 403 for real vs fake order/payment IDs (no existence oracle!)
      const bReadRealOrd = await fetch(`${APP}/api/orders/${custAOrdJson.id}`, { headers: { Cookie: custBCookie } });
      const bReadFakeOrd = await fetch(`${APP}/api/orders/${fakeId}`, { headers: { Cookie: custBCookie } });
      assert.equal(bReadRealOrd.status, 403);
      assert.equal(bReadFakeOrd.status, 403);

      const bReadRealPay = await fetch(`${APP}/api/payments/${custAPay.id}`, { headers: { Cookie: custBCookie } });
      const bReadFakePay = await fetch(`${APP}/api/payments/${fakeId}`, { headers: { Cookie: custBCookie } });
      assert.equal(bReadRealPay.status, 403);
      assert.equal(bReadFakePay.status, 403);

      // Customer B cannot read Customer A's prescription file (even with token)
      assert.equal((await fetch(`${APP}${custRxCanonical}`, { headers: { Cookie: custBCookie } })).status, 403);
      assert.equal(
        (await fetch(`${APP}${custRxCanonical}?orderId=${custAOrdJson.id}&token=${forgedOrValidTokForCustA}`, { headers: { Cookie: custBCookie } })).status,
        403,
      );

      // Customer B cannot read Customer A's invoice or pay page
      assert.equal((await fetch(`${APP}/invoice/${custAOrdJson.id}`, { headers: { Cookie: custBCookie }, redirect: "manual" })).status, 404);
      assert.equal((await fetch(`${APP}/checkout/pay/${custAOrdJson.id}`, { headers: { Cookie: custBCookie }, redirect: "manual" })).status, 404);

      // Customer B cannot cancel Customer A's order (uniform 404 for both foreign and fake order IDs)
      const bCancelReal = await fetch(`${APP}/api/orders/${custAOrdJson.id}/cancel`, {
        method: "POST",
        headers: { Origin: APP, Cookie: custBCookie },
      });
      const bCancelFake = await fetch(`${APP}/api/orders/${fakeId}/cancel`, {
        method: "POST",
        headers: { Origin: APP, Cookie: custBCookie },
      });
      assert.equal(bCancelReal.status, 404);
      assert.equal(bCancelFake.status, 404);

      // Customer B cannot initiate payment, submit USDT hash, or capture PayPal on Customer A's order/payment
      assert.equal(
        (await fetch(`${APP}/api/orders/${custAOrdJson.id}/pay`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: APP, Cookie: custBCookie },
          body: JSON.stringify({ method: "KHQR", currency: "USD" }),
        })).status,
        403,
      );
      assert.equal(
        (await fetch(`${APP}/api/payments/${custAPay.id}/usdt-hash`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: APP, Cookie: custBCookie },
          body: JSON.stringify({ txHash: "a".repeat(64) }),
        })).status,
        403,
      );
      assert.equal(
        (await fetch(`${APP}/api/payments/${custAPay.id}/paypal-capture`, {
          method: "POST",
          headers: { Origin: APP, Cookie: custBCookie },
        })).status,
        403,
      );

      // Customer A (owner) CAN read their own order, payment, prescription, and invoice
      assert.equal((await fetch(`${APP}/api/orders/${custAOrdJson.id}`, { headers: { Cookie: custACookie } })).status, 200);
      assert.equal((await fetch(`${APP}/api/payments/${custAPay.id}`, { headers: { Cookie: custACookie } })).status, 200);
      assert.equal((await fetch(`${APP}${custRxCanonical}`, { headers: { Cookie: custACookie } })).status, 200);
      assert.equal((await fetch(`${APP}/invoice/${custAOrdJson.id}`, { headers: { Cookie: custACookie } })).status, 200);

      // ── 4. True Guest Online Order & Guest Token Boundary ──
      const storedGuestRx = await storeUpload(makeFile(makeValidPdf(), "guest-rx.pdf", "application/pdf"), "prescriptions", {
        actorUserId: null,
      });
      cleanupFiles.push(path.resolve("storage", "prescriptions", storedGuestRx.fileName));
      const guestRxCanonical = storedGuestRx.url.split("?")[0]!;

      const guestOrd = await createOrder(
        {
          channel: "ONLINE",
          customerId: null,
          items: [{ medicineId: rxMed.id, quantity: 1 }],
          fullName: "Guest Patient",
          phone: "+85512999111",
          province: "Phnom Penh",
          district: "Doun Penh",
          prescriptionUrl: storedGuestRx.url,
        },
        null,
      );
      createdOrderIds.push(guestOrd.id);
      const guestTok = orderAccessToken(guestOrd.id);

      assert.equal((await fetch(`${APP}/api/orders/${guestOrd.id}?token=${guestTok}`)).status, 200);
      assert.equal((await fetch(`${APP}/api/orders/${guestOrd.id}?token=wrongtoken1234567890123456789012`)).status, 403);
      assert.equal((await fetch(`${APP}${guestRxCanonical}?orderId=${guestOrd.id}&token=${guestTok}`)).status, 200);
      assert.equal((await fetch(`${APP}${guestRxCanonical}?orderId=${guestOrd.id}&token=wrongtoken1234567890123456789012`)).status, 403);
      assert.equal((await fetch(`${APP}/invoice/${guestOrd.id}?token=${guestTok}`)).status, 200);

      // ── 5. Cross-Channel & Cross-Cashier POS Isolation ──
      const posOrder = await createOrder(
        {
          channel: "POS",
          items: [{ medicineId: otcMed.id, quantity: 1 }],
          cashierId: cashierA.id,
          customerId: custA.customer.id,
          fullName: custA.name,
          phone: "+85512888001",
          staffCanDispenseRx: false,
        },
        cashierA.id,
      );
      createdOrderIds.push(posOrder.id);

      const posCashPay = await prisma.payment.create({
        data: {
          reference: `PAY-POS-CASH-${Date.now()}`,
          orderId: posOrder.id,
          methodId: cashMethod.id,
          status: "PENDING",
          amountUsd: posOrder.total,
          currency: "USD",
          amount: posOrder.total,
        },
      });
      const posUsdtPay = await prisma.payment.create({
        data: {
          reference: `PAY-POS-USDT-${Date.now()}`,
          orderId: posOrder.id,
          methodId: usdtMethod.id,
          network: "TRC20",
          status: "PENDING",
          amountUsd: posOrder.total,
          currency: "USDT",
          amount: posOrder.total,
        },
      });

      // Guest token must NEVER unlock a POS order
      assert.equal((await fetch(`${APP}/api/orders/${posOrder.id}?token=${orderAccessToken(posOrder.id)}`)).status, 403);

      // Customer A can READ their own POS order, but CANNOT cancel, initiate online pay, or submit USDT hash on it!
      assert.equal((await fetch(`${APP}/api/orders/${posOrder.id}`, { headers: { Cookie: custACookie } })).status, 200);
      assert.equal(
        (await fetch(`${APP}/api/orders/${posOrder.id}/cancel`, { method: "POST", headers: { Origin: APP, Cookie: custACookie } })).status,
        403,
        "Customer must not cancel an in-store POS order via online cancel endpoint",
      );
      assert.equal(
        (await fetch(`${APP}/api/orders/${posOrder.id}/pay`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: APP, Cookie: custACookie },
          body: JSON.stringify({ method: "KHQR", currency: "USD" }),
        })).status,
        403,
        "Customer must not initiate online payment on a POS order",
      );
      assert.equal(
        (await fetch(`${APP}/api/payments/${posUsdtPay.id}/usdt-hash`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: APP, Cookie: custACookie },
          body: JSON.stringify({ txHash: "b".repeat(64) }),
        })).status,
        403,
        "Customer must not submit USDT hash against a POS order",
      );

      // Cashier B CANNOT confirm cash, cancel, or submit USDT hash on Cashier A's POS sale!
      assert.equal(
        (await fetch(`${APP}/api/admin/payments/${posCashPay.id}/cash`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: APP, Cookie: cashierBCookie },
          body: JSON.stringify({ tendered: 100 }),
        })).status,
        403,
        "Cashier B must not settle Cashier A's POS cash sale",
      );
      assert.equal(
        (await fetch(`${APP}/api/admin/pos/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: APP, Cookie: cashierBCookie },
          body: JSON.stringify({ orderId: posOrder.id }),
        })).status,
        403,
        "Cashier B must not cancel Cashier A's POS sale",
      );
      assert.equal(
        (await fetch(`${APP}/api/payments/${posUsdtPay.id}/usdt-hash`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: APP, Cookie: cashierBCookie },
          body: JSON.stringify({ txHash: "c".repeat(64) }),
        })).status,
        403,
        "Cashier B must not mutate Cashier A's POS USDT payment",
      );

      // Cashier A CANNOT cancel an ONLINE order via /api/admin/pos/cancel
      assert.equal(
        (await fetch(`${APP}/api/admin/pos/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: APP, Cookie: cashierACookie },
          body: JSON.stringify({ orderId: custAOrdJson.id }),
        })).status,
        404,
      );

      // Cashier A CAN cancel their own pending POS sale
      assert.equal(
        (await fetch(`${APP}/api/admin/pos/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: APP, Cookie: cashierACookie },
          body: JSON.stringify({ orderId: posOrder.id }),
        })).status,
        200,
      );

      // Settling cash on the now-cancelled POS sale MUST be rejected (409)
      assert.equal(
        (await fetch(`${APP}/api/admin/payments/${posCashPay.id}/cash`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: APP, Cookie: cashierACookie },
          body: JSON.stringify({ tendered: 100 }),
        })).status,
        409,
        "Cancelled POS sale cash payment must not be settleable",
      );

      // ── 6. Vertical RBAC & Cross-Permission Field Redaction ──
      // 6a. INVENTORY_STAFF blocked from /api/admin/payments/:id/check (was bare requireStaff()!)
      assert.equal(
        (await fetch(`${APP}/api/admin/payments/${custAPay.id}/check`, {
          method: "POST",
          headers: { Origin: APP, Cookie: inventoryCookie },
        })).status,
        403,
        "INVENTORY_STAFF must be blocked from checking payments",
      );
      assert.equal((await fetch(`${APP}/api/orders/${custAOrdJson.id}`, { headers: { Cookie: inventoryCookie } })).status, 403);
      assert.equal((await fetch(`${APP}/api/payments/${custAPay.id}`, { headers: { Cookie: inventoryCookie } })).status, 403);

      // 6b. INVENTORY_STAFF dashboard must NOT expose recent customer orders or payment breakdown
      const invDashRes = await fetch(`${APP}/api/admin/dashboard`, { headers: { Cookie: inventoryCookie } });
      assert.equal(invDashRes.status, 200);
      const invDash = (await invDashRes.json()) as { recent: unknown[]; payments: unknown[] };
      assert.deepEqual(invDash.recent, [], "INVENTORY_STAFF dashboard must not leak recent customer orders");
      assert.deepEqual(invDash.payments, [], "INVENTORY_STAFF dashboard must not leak payment breakdown");

      // 6c. CASHIER prescription PHI & inventory redaction across ALL endpoints
      // /api/orders/:id must redact prescriptionUrl for CASHIER (matching /api/admin/orders/:id)
      const cashierOrderPublicRes = await fetch(`${APP}/api/orders/${custAOrdJson.id}`, { headers: { Cookie: cashierACookie } });
      assert.equal(cashierOrderPublicRes.status, 200);
      const cashierOrderPublic = (await cashierOrderPublicRes.json()) as { prescriptionUrl: string | null };
      assert.equal(cashierOrderPublic.prescriptionUrl, null, "CASHIER must not see prescriptionUrl via /api/orders/:id");

      // /api/admin/customers/:id must NOT leak prescriptionUrl, prescriptionNote, or unitCost to CASHIER
      const cashierCustRes = await fetch(`${APP}/api/admin/customers/${custA.customer.id}`, { headers: { Cookie: cashierACookie } });
      assert.equal(cashierCustRes.status, 200);
      const cashierCust = (await cashierCustRes.json()) as { orders: Array<Record<string, unknown>> };
      for (const o of cashierCust.orders) {
        assert.equal("prescriptionUrl" in o, false, "Customer detail must not leak order.prescriptionUrl");
        assert.equal("prescriptionNote" in o, false, "Customer detail must not leak order.prescriptionNote");
        const items = (o.items as Array<Record<string, unknown>> | undefined) ?? [];
        for (const it of items) {
          assert.equal("unitCost" in it, false, "Customer detail must not leak orderItem.unitCost");
        }
      }

      // /api/admin/medicines/:id must NOT leak batches or stock movements to CASHIER (lacks inventory.read)
      const cashierMedRes = await fetch(`${APP}/api/admin/medicines/${otcMed.id}`, { headers: { Cookie: cashierACookie } });
      assert.equal(cashierMedRes.status, 200);
      const cashierMed = (await cashierMedRes.json()) as { batches: unknown[]; movements: unknown[] };
      assert.deepEqual(cashierMed.batches, [], "CASHIER must not receive batch/supplier records without inventory.read");
      assert.deepEqual(cashierMed.movements, [], "CASHIER must not receive stock movements without inventory.read");

      // CASHIER cannot mutate customer ONLINE orders via /api/orders/:id/pay or /api/payments/:id/usdt-hash
      assert.equal(
        (await fetch(`${APP}/api/orders/${custAOrdJson.id}/pay`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: APP, Cookie: cashierACookie },
          body: JSON.stringify({ method: "KHQR", currency: "USD" }),
        })).status,
        403,
      );
      assert.equal(
        (await fetch(`${APP}/api/payments/${custAPay.id}/usdt-hash`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: APP, Cookie: cashierACookie },
          body: JSON.stringify({ txHash: "d".repeat(64) }),
        })).status,
        403,
      );

      // Pharmacist (has prescriptions.review) CAN view prescription file and see prescriptionUrl
      assert.equal((await fetch(`${APP}${custRxCanonical}`, { headers: { Cookie: pharmacistCookie } })).status, 200);

      // 6d. ADMIN (has customers.write, lacks users.manage) cannot hijack/suspend a staff account via /api/admin/customers/:id
      const existingSaCust = await prisma.customer.findUnique({ where: { userId: superAdmin.id } });
      if (!existingSaCust) {
        const tmpCust = await prisma.customer.create({ data: { userId: superAdmin.id } });
        tempSuperAdminCustomerId = tmpCust.id;
      }
      const targetSaCustId = existingSaCust?.id ?? tempSuperAdminCustomerId!;

      assert.equal(
        (await fetch(`${APP}/api/admin/customers/${targetSaCustId}`, { headers: { Cookie: adminCookie } })).status,
        404,
        "Staff account must not be exposed via /api/admin/customers/:id",
      );
      assert.equal(
        (await fetch(`${APP}/api/admin/customers/${targetSaCustId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Origin: APP, Cookie: adminCookie },
          body: JSON.stringify({ status: "SUSPENDED" }),
        })).status,
        404,
        "ADMIN must not be able to suspend SUPER_ADMIN via /api/admin/customers/:id",
      );

      // 6e. Server-Component page guards cleanly redirect (307) instead of crashing (500) or rendering (200)
      const cashierStaffPage = await fetch(`${APP}/admin/staff`, { headers: { Cookie: cashierACookie }, redirect: "manual" });
      assert.equal(cashierStaffPage.status, 307, "Unauthorized staff page access must cleanly redirect (307), not 200 or 500");

      const custAdminPage = await fetch(`${APP}/admin`, { headers: { Cookie: custACookie }, redirect: "manual" });
      assert.equal(custAdminPage.status, 307, "Customer accessing /admin must cleanly redirect (307)");
    } finally {
      for (const oid of createdOrderIds) {
        await cancelOrder(oid, null, "IDOR test cleanup", { system: true }).catch(() => {});
        await prisma.order.delete({ where: { id: oid } }).catch(() => {});
      }
      if (custAAddrId) await prisma.address.delete({ where: { id: custAAddrId } }).catch(() => {});
      if (custANotifId) await prisma.notification.delete({ where: { id: custANotifId } }).catch(() => {});
      if (tempSuperAdminCustomerId) await prisma.customer.delete({ where: { id: tempSuperAdminCustomerId } }).catch(() => {});
      await prisma.user.delete({ where: { id: cashierB.id } }).catch(() => {});
    }
  });
});

after(async () => {
  if (cleanupSessions.length) {
    await prisma.session.deleteMany({ where: { tokenHash: { in: cleanupSessions } } }).catch(() => {});
  }
  for (const f of cleanupFiles) {
    await unlink(f).catch(() => {});
  }
  await prisma.$disconnect();
});
