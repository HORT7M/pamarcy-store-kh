import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { prisma } from "../../src/lib/db.ts";
import { hashPassword } from "../../src/lib/auth/password.ts";
import { SESSION_COOKIE } from "../../src/lib/auth/session.ts";
import { createPrescriptionClaimUrl } from "../../src/lib/upload.ts";
import { orderAccessToken } from "../../src/lib/order-access.ts";
import { hashPasswordResetToken } from "../../src/lib/auth/password-reset.ts";
import { createOrder, cancelOrder } from "../../src/lib/services/orders.ts";
import { mkdir, unlink, writeFile } from "node:fs/promises";

if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}

const APP = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
const RUN_ID = Date.now().toString(36);
let ipOctet = 10;
const nextIp = () => `10.220.${Math.floor(ipOctet / 200) + 1}.${(ipOctet++ % 200) + 1}`;
const VALID_PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);
const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36";

const cleanupUserIds: string[] = [];
const cleanupOrderIds: string[] = [];
const cleanupFiles: string[] = [];

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

async function serverReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${APP}/api/categories`, { signal: AbortSignal.timeout(2000) });
    return r.status > 0;
  } catch {
    return false;
  }
}

async function createTempUser(opts: {
  roleKey: "SUPER_ADMIN" | "ADMIN" | "PHARMACIST" | "CASHIER" | "INVENTORY_STAFF" | "CUSTOMER";
  tag: string;
  password?: string;
}) {
  const rawPassword = opts.password ?? "AuthAudit#2026!";
  const role = await prisma.role.findUniqueOrThrow({ where: { key: opts.roleKey } });
  const email = `authaudit-${opts.tag}-${RUN_ID}@example.com`;
  const phoneNum = String(Math.floor(10_000_000 + Math.random() * 89_000_000)).slice(0, 8);
  const phone = `+85512${phoneNum.slice(0, 6)}`;
  const isStaff = role.isStaff;

  const user = await prisma.user.create({
    data: {
      name: `Audit ${opts.tag}`,
      email,
      phone,
      passwordHash: await hashPassword(rawPassword),
      roleId: role.id,
      ...(isStaff
        ? { employee: { create: { employeeCode: `AUD-${opts.tag.toUpperCase()}-${RUN_ID.slice(-4)}` } } }
        : { customer: { create: {} } }),
    },
    include: { customer: true, role: true },
  });
  cleanupUserIds.push(user.id);
  return { user, email, phone, rawPassword, customerId: user.customer?.id ?? null };
}

async function loginAs(email: string, password: string, scope: "customer" | "admin"): Promise<string> {
  const ip = nextIp();
  const res = await fetch(`${APP}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: APP,
      "X-Forwarded-For": ip,
      "User-Agent": BROWSER_UA,
    },
    body: JSON.stringify({ identifier: email, password, scope }),
  });
  assert.equal(res.status, 200, `Login failed for ${email} (scope=${scope}): status ${res.status}`);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(setCookie);
  assert.ok(match?.[1], `Expected ${SESSION_COOKIE} cookie for ${email}`);
  return `${SESSION_COOKIE}=${match[1]}`;
}

async function apiReq(
  pathname: string,
  opts: { method?: string; cookie?: string; body?: unknown; origin?: string | null; extraHeaders?: Record<string, string> } = {},
) {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = {
    "X-Forwarded-For": nextIp(),
    "User-Agent": BROWSER_UA,
    ...(opts.cookie ? { Cookie: opts.cookie } : {}),
    ...(opts.extraHeaders ?? {}),
  };
  if (opts.origin !== null && !["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers.Origin = opts.origin ?? APP;
  }
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  return fetch(`${APP}${pathname}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: "manual",
  });
}

// ───────────────────── 1. Static Code-Level Audit Invariants ─────────────────────

describe("Static server-side authentication & authorization audit invariants", () => {
  it("enforces explicit staff permissions on EVERY /api/admin/* route handler (no bare requireStaff())", () => {
    const routes = walkFiles(path.resolve("src/app/api/admin")).filter((f) => f.endsWith("route.ts"));
    assert.ok(routes.length >= 40, `Expected >= 40 admin API route files, found ${routes.length}`);

    for (const file of routes) {
      const content = readFileSync(file, "utf8");
      const rel = path.relative(process.cwd(), file);
      const exports = [...content.matchAll(/export const (GET|POST|PUT|PATCH|DELETE)\s*=/g)].map((m) => m[1]);
      assert.ok(exports.length > 0, `${rel} should export at least one HTTP method`);

      // Must never call bare requireStaff() with zero arguments in an admin API route
      assert.equal(
        /\brequireStaff\(\s*\)/.test(content),
        false,
        `${rel} calls bare requireStaff() without an explicit permission`,
      );

      // Every exported handler block must invoke requireStaff("...") or requireStaffAny([...])
      const explicitCalls = content.match(/\brequireStaff\(\s*"[^"]+"\s*\)|\brequireStaffAny\(\s*\[[^\]]+\]\s*\)/g) ?? [];
      assert.ok(
        explicitCalls.length >= exports.length,
        `${rel} exports ${exports.length} handler(s) (${exports.join(", ")}) but only has ${explicitCalls.length} explicit staff permission check(s)`,
      );
    }
  });

  it("enforces server-side authentication on EVERY /api/account/* route handler", () => {
    const routes = walkFiles(path.resolve("src/app/api/account")).filter((f) => f.endsWith("route.ts"));
    assert.ok(routes.length >= 6);
    for (const file of routes) {
      const content = readFileSync(file, "utf8");
      const rel = path.relative(process.cwd(), file);
      const exports = [...content.matchAll(/export const (GET|POST|PUT|PATCH|DELETE)\s*=/g)].map((m) => m[1]);
      const authCalls = content.match(/\brequire(?:User|Customer)\(\s*\)/g) ?? [];
      assert.ok(
        authCalls.length >= exports.length,
        `${rel} exports ${exports.length} handler(s) but only has ${authCalls.length} requireUser/requireCustomer check(s)`,
      );
    }
  });

  it("enforces server-side page guards on EVERY /admin/(panel) and /(shop)/account page (never trusts middleware/layout alone)", () => {
    const adminPages = walkFiles(path.resolve("src/app/admin/(panel)")).filter((f) => f.endsWith("page.tsx"));
    assert.ok(adminPages.length >= 20);
    for (const file of adminPages) {
      const content = readFileSync(file, "utf8");
      const rel = path.relative(process.cwd(), file);
      assert.ok(
        /\brequireStaff(?:Any)?Page\(/.test(content),
        `${rel} must enforce server-side requireStaffPage / requireStaffAnyPage`,
      );
      assert.equal(
        /\brequireStaff\(/.test(content),
        false,
        `${rel} should use requireStaffPage instead of throwing raw API requireStaff() in a Server Component`,
      );
    }

    const accountPages = walkFiles(path.resolve("src/app/(shop)/account")).filter((f) => f.endsWith("page.tsx"));
    assert.ok(accountPages.length >= 7);
    for (const file of accountPages) {
      const content = readFileSync(file, "utf8");
      const rel = path.relative(process.cwd(), file);
      assert.ok(
        /\brequireCustomerPage\(\s*\)/.test(content),
        `${rel} must enforce server-side requireCustomerPage()`,
      );
    }
  });

  it("has zero unprotected Next.js Server Actions ('use server')", () => {
    const srcFiles = walkFiles(path.resolve("src")).filter((f) => /\.(ts|tsx)$/.test(f));
    for (const file of srcFiles) {
      const content = readFileSync(file, "utf8");
      assert.equal(
        /["']use server["']/.test(content),
        false,
        `Unexpected Server Action directive found in ${path.relative(process.cwd(), file)} — audit its server-side auth!`,
      );
    }
  });
});

// ───────────────────── 2. Live HTTP Unauthorized Access Matrix ─────────────────────

describe("Live HTTP authentication, RBAC, IDOR, CSRF & privilege-escalation tests", () => {
  it("blocks unauthenticated requests across all protected APIs & pages without leaking object existence", async (t) => {
    if (!(await serverReachable())) {
      t.skip("App server not reachable");
      return;
    }

    const fakeId = "cm00000000000000000000000";
    const unauth401Endpoints: [string, string, unknown?][] = [
      ["GET", "/api/admin/dashboard"],
      ["GET", "/api/admin/medicines"],
      ["POST", "/api/admin/medicines", {}],
      ["GET", `/api/admin/medicines/${fakeId}`],
      ["PUT", `/api/admin/medicines/${fakeId}`, {}],
      ["DELETE", `/api/admin/medicines/${fakeId}`],
      ["GET", "/api/admin/categories"],
      ["POST", "/api/admin/categories", {}],
      ["GET", "/api/admin/brands"],
      ["POST", "/api/admin/brands", {}],
      ["GET", "/api/admin/inventory"],
      ["GET", "/api/admin/inventory/expiry"],
      ["GET", "/api/admin/inventory/movements"],
      ["POST", "/api/admin/inventory/stock-in", {}],
      ["GET", "/api/admin/suppliers"],
      ["GET", "/api/admin/purchases"],
      ["GET", "/api/admin/orders"],
      ["GET", `/api/admin/orders/${fakeId}`],
      ["POST", `/api/admin/orders/${fakeId}/status`, { status: "CONFIRMED" }],
      ["POST", `/api/admin/orders/${fakeId}/prescription`, { approve: true }],
      ["POST", `/api/admin/orders/${fakeId}/refund`, { reason: "test" }],
      ["GET", "/api/admin/payments"],
      ["POST", `/api/admin/payments/${fakeId}/check`],
      ["POST", `/api/admin/payments/${fakeId}/cash`, { tendered: 10 }],
      ["GET", "/api/admin/pos/methods"],
      ["GET", "/api/admin/pos/lookup?q=para"],
      ["POST", "/api/admin/pos/sale", {}],
      ["POST", "/api/admin/pos/cancel", { orderId: fakeId }],
      ["GET", "/api/admin/customers"],
      ["GET", "/api/admin/discounts"],
      ["GET", "/api/admin/banners"],
      ["GET", "/api/admin/reports/sales"],
      ["GET", "/api/admin/settings/store"],
      ["PUT", "/api/admin/settings/store", {}],
      ["GET", "/api/admin/settings/payments"],
      ["PUT", "/api/admin/settings/payments", {}],
      ["GET", "/api/admin/staff"],
      ["POST", "/api/admin/staff", {}],
      ["GET", "/api/admin/audit"],
      ["GET", "/api/account/profile"],
      ["PATCH", "/api/account/profile", { name: "X", phone: "012345678" }],
      ["POST", "/api/account/password", { currentPassword: "x", newPassword: "Password1" }],
      ["GET", "/api/account/addresses"],
      ["GET", "/api/account/wishlist"],
      ["GET", "/api/account/notifications"],
      ["GET", "/api/orders"],
      ["POST", `/api/orders/${fakeId}/cancel`],
      // Order & payment endpoints must return 401 (never 404 existence oracle!) when unauthenticated
      ["GET", `/api/orders/${fakeId}`],
      ["POST", `/api/orders/${fakeId}/pay`, { method: "KHQR" }],
      ["GET", `/api/payments/${fakeId}`],
      ["POST", `/api/payments/${fakeId}/check`],
      ["POST", `/api/payments/${fakeId}/usdt-hash`, { txHash: "0x" + "a".repeat(64) }],
      ["POST", `/api/payments/${fakeId}/paypal-capture`],
      // Cron & webhooks
      ["GET", "/api/cron/maintenance"],
      ["POST", "/api/webhooks/paypal", { event_type: "PAYMENT.CAPTURE.COMPLETED", resource: {} }],
    ];

    for (const [method, pathname, body] of unauth401Endpoints) {
      const res = await apiReq(pathname, { method, body });
      assert.equal(res.status, 401, `Expected 401 for unauthenticated ${method} ${pathname}, got ${res.status}`);
    }

    // Forged valid-format session cookie must ALSO fail server-side on both APIs (401) and pages (307 redirect)
    const forgedCookie = `${SESSION_COOKIE}=${"A".repeat(43)}`;
    const forgedApi = await apiReq("/api/admin/dashboard", { cookie: forgedCookie });
    assert.equal(forgedApi.status, 401);

    for (const pagePath of ["/admin", "/admin/staff", "/admin/settings", "/account", "/account/orders"]) {
      // No cookie (caught by middleware -> redirect)
      const noCookiePage = await apiReq(pagePath);
      assert.equal(noCookiePage.status, 307, `Expected 307 redirect for ${pagePath} without cookie`);
      // Valid-format forged cookie bypasses Edge middleware check -> MUST STILL redirect server-side!
      const forgedPage = await apiReq(pagePath, { cookie: forgedCookie });
      assert.equal(forgedPage.status, 307, `Expected 307 server-side redirect for ${pagePath} with forged session cookie`);
      const loc = forgedPage.headers.get("location") ?? "";
      assert.ok(
        loc.includes("/login"),
        `Expected redirect to login page for ${pagePath} with forged cookie, got Location: ${loc}`,
      );
    }
  });

  it("prevents horizontal IDOR between customers, guest token forgery, and cross-channel POS tampering", async (t) => {
    if (!(await serverReachable())) {
      t.skip("App server not reachable");
      return;
    }

    const custA = await createTempUser({ roleKey: "CUSTOMER", tag: "custa" });
    const custB = await createTempUser({ roleKey: "CUSTOMER", tag: "custb" });
    const cookieA = await loginAs(custA.email, custA.rawPassword, "customer");
    const cookieB = await loginAs(custB.email, custB.rawPassword, "customer");

    // Customer A creates a saved address
    const addrRes = await apiReq("/api/account/addresses", {
      method: "POST",
      cookie: cookieA,
      body: { fullName: "Cust A", phone: "012 345 678", province: "Phnom Penh", district: "Doun Penh", street: "#1" },
    });
    assert.equal(addrRes.status, 200);
    const addrA = (await addrRes.json()) as { id: string };

    // Customer B CANNOT update or delete Customer A's address
    assert.equal(
      (await apiReq(`/api/account/addresses/${addrA.id}`, {
        method: "PUT",
        cookie: cookieB,
        body: { fullName: "Hacked", phone: "012 345 678", province: "Phnom Penh", district: "Doun Penh" },
      })).status,
      404,
    );
    assert.equal((await apiReq(`/api/account/addresses/${addrA.id}`, { method: "DELETE", cookie: cookieB })).status, 404);

    // Create an ONLINE Rx order for Customer A with a real local prescription file + a PENDING payment
    const rxMed = await prisma.medicine.findFirstOrThrow({ where: { requiresPrescription: true, deletedAt: null, isActive: true } });
    const otcMed = await prisma.medicine.findFirstOrThrow({ where: { requiresPrescription: false, deletedAt: null, isActive: true } });

    const rxFileName = `authaudit-${RUN_ID}.png`;
    const rxDir = path.resolve("storage", "prescriptions");
    await mkdir(rxDir, { recursive: true });
    const rxPath = path.join(rxDir, rxFileName);
    await writeFile(rxPath, VALID_PNG_1X1, { mode: 0o600 });
    cleanupFiles.push(rxPath);

    const claimUrl = createPrescriptionClaimUrl(rxFileName, custA.user.id);
    const rxOrderA = await createOrder(
      {
        channel: "ONLINE",
        items: [{ medicineId: rxMed.id, quantity: 1 }],
        customerId: custA.customerId,
        fullName: "Cust A",
        phone: custA.phone,
        province: "Phnom Penh",
        district: "Doun Penh",
        prescriptionUrl: claimUrl,
      },
      custA.user.id,
    );
    cleanupOrderIds.push(rxOrderA.id);

    const onlineOrderA = await createOrder(
      {
        channel: "ONLINE",
        items: [{ medicineId: otcMed.id, quantity: 1 }],
        customerId: custA.customerId,
        fullName: "Cust A",
        phone: custA.phone,
        province: "Phnom Penh",
        district: "Doun Penh",
      },
      custA.user.id,
    );
    cleanupOrderIds.push(onlineOrderA.id);

    const khqrMethod = await prisma.paymentMethod.findUniqueOrThrow({ where: { code: "KHQR" } });
    const payA = await prisma.payment.create({
      data: {
        reference: `PAY-AUDIT-${RUN_ID}`,
        orderId: onlineOrderA.id,
        methodId: khqrMethod.id,
        amountUsd: onlineOrderA.total,
        currency: "USD",
        amount: onlineOrderA.total,
        status: "PENDING",
      },
    });

    // Customer B CANNOT read, pay, cancel, invoice, check, or mutate Customer A's order/payment/prescription
    const fakeId = "cm00000000000000000000001";
    assert.equal((await apiReq(`/api/orders/${onlineOrderA.id}`, { cookie: cookieB })).status, 403);
    // Uniform 403 on nonexistent ID for Customer B (no existence oracle!)
    assert.equal((await apiReq(`/api/orders/${fakeId}`, { cookie: cookieB })).status, 403);
    assert.equal((await apiReq(`/api/orders/${onlineOrderA.id}/cancel`, { method: "POST", cookie: cookieB })).status, 404);
    assert.equal(
      (await apiReq(`/api/orders/${onlineOrderA.id}/pay`, { method: "POST", cookie: cookieB, body: { method: "KHQR", currency: "USD" } })).status,
      403,
    );
    assert.equal((await apiReq(`/api/payments/${payA.id}`, { cookie: cookieB })).status, 403);
    assert.equal((await apiReq(`/api/payments/${fakeId}`, { cookie: cookieB })).status, 403);
    assert.equal((await apiReq(`/api/payments/${payA.id}/check`, { method: "POST", cookie: cookieB })).status, 403);
    assert.equal(
      (await apiReq(`/api/payments/${payA.id}/usdt-hash`, { method: "POST", cookie: cookieB, body: { txHash: "0x" + "b".repeat(64) } })).status,
      403,
    );
    assert.equal((await apiReq(`/api/payments/${payA.id}/paypal-capture`, { method: "POST", cookie: cookieB })).status, 403);
    assert.equal((await apiReq(`/api/files/prescriptions/${rxFileName}`, { cookie: cookieB })).status, 403);
    assert.equal((await apiReq(`/checkout/pay/${onlineOrderA.id}`, { cookie: cookieB })).status, 404);
    assert.equal((await apiReq(`/invoice/${onlineOrderA.id}`, { cookie: cookieB })).status, 404);

    // Even the computed HMAC token CANNOT unlock a signed-in customer order without their authenticated session!
    const customerOrderTok = orderAccessToken(onlineOrderA.id);
    assert.equal((await apiReq(`/api/orders/${onlineOrderA.id}?token=${customerOrderTok}`)).status, 403);
    assert.equal((await apiReq(`/api/orders/${onlineOrderA.id}/pay?token=${customerOrderTok}`, { method: "POST", body: { method: "KHQR", currency: "USD" } })).status, 403);

    // Tampered guest token fails with 403 (and returns uniform 403 on nonexistent ID too)
    const badTok = "wrongtoken1234567890123456789012";
    assert.equal((await apiReq(`/api/orders/${onlineOrderA.id}?token=${badTok}`)).status, 403);
    assert.equal((await apiReq(`/api/orders/${fakeId}?token=${badTok}`)).status, 403);
    assert.equal(
      (await apiReq(`/api/orders/${onlineOrderA.id}/pay?token=${badTok}`, { method: "POST", body: { method: "KHQR", currency: "USD" } })).status,
      403,
    );

    // Customer A's own access succeeds (and /checkout/pay does NOT expose an unnecessary guest token for session-authed customer)
    assert.equal((await apiReq(`/api/orders/${onlineOrderA.id}`, { cookie: cookieA })).status, 200);
    assert.equal((await apiReq(`/api/files/prescriptions/${rxFileName}`, { cookie: cookieA })).status, 200);
    const payPageA = await apiReq(`/checkout/pay/${onlineOrderA.id}`, { cookie: cookieA });
    assert.equal(payPageA.status, 200);
    const payPageHtmlA = await payPageA.text();
    assert.equal(
      payPageHtmlA.includes(orderAccessToken(onlineOrderA.id)),
      false,
      "Authenticated customer /checkout/pay page must not leak an everlasting orderAccessToken in HTML",
    );

    // Cross-channel: POS order linked to Customer A CANNOT be cancelled online or paid via /api/orders/:id/pay or /checkout/pay/:id
    const posOrderForA = await createOrder(
      {
        channel: "POS",
        items: [{ medicineId: otcMed.id, quantity: 1 }],
        customerId: custA.customerId,
        fullName: "Cust A",
        phone: custA.phone,
      },
      null,
    );
    cleanupOrderIds.push(posOrderForA.id);
    const cashMethod = await prisma.paymentMethod.findUniqueOrThrow({ where: { code: "CASH" } });
    const posPay = await prisma.payment.create({
      data: {
        reference: `PAY-POSAUDIT-${RUN_ID}`,
        orderId: posOrderForA.id,
        methodId: cashMethod.id,
        amountUsd: posOrderForA.total,
        currency: "USD",
        amount: posOrderForA.total,
        status: "PENDING",
      },
    });

    assert.equal((await apiReq(`/api/orders/${posOrderForA.id}/cancel`, { method: "POST", cookie: cookieA })).status, 403);
    assert.equal(
      (await apiReq(`/api/orders/${posOrderForA.id}/pay`, { method: "POST", cookie: cookieA, body: { method: "KHQR", currency: "USD" } })).status,
      403,
    );
    assert.equal((await apiReq(`/checkout/pay/${posOrderForA.id}`, { cookie: cookieA })).status, 404);
    assert.equal(
      (await apiReq(`/api/payments/${posPay.id}/usdt-hash`, { method: "POST", cookie: cookieA, body: { txHash: "0x" + "c".repeat(64) } })).status,
      403,
    );
  });

  it("enforces strict RBAC separation across CUSTOMER, INVENTORY_STAFF, CASHIER, PHARMACIST, ADMIN, and SUPER_ADMIN", async (t) => {
    if (!(await serverReachable())) {
      t.skip("App server not reachable");
      return;
    }

    const cust = await createTempUser({ roleKey: "CUSTOMER", tag: "rbac-cust" });
    const inv = await createTempUser({ roleKey: "INVENTORY_STAFF", tag: "rbac-inv" });
    const cashier = await createTempUser({ roleKey: "CASHIER", tag: "rbac-cashier" });
    const pharm = await createTempUser({ roleKey: "PHARMACIST", tag: "rbac-pharm" });
    const admin = await createTempUser({ roleKey: "ADMIN", tag: "rbac-admin" });
    const superAdmin = await createTempUser({ roleKey: "SUPER_ADMIN", tag: "rbac-super" });

    // Customer CANNOT log in with scope="admin"
    const badAdminLogin = await apiReq("/api/auth/login", {
      method: "POST",
      body: { identifier: cust.email, password: cust.rawPassword, scope: "admin" },
    });
    assert.equal(badAdminLogin.status, 403);
    assert.equal(badAdminLogin.headers.get("set-cookie"), null);

    const custCookie = await loginAs(cust.email, cust.rawPassword, "customer");
    const invCookie = await loginAs(inv.email, inv.rawPassword, "admin");
    const cashierCookie = await loginAs(cashier.email, cashier.rawPassword, "admin");
    const pharmCookie = await loginAs(pharm.email, pharm.rawPassword, "admin");
    const adminCookie = await loginAs(admin.email, admin.rawPassword, "admin");
    const superCookie = await loginAs(superAdmin.email, superAdmin.rawPassword, "admin");

    const rxMed = await prisma.medicine.findFirstOrThrow({ where: { requiresPrescription: true, deletedAt: null, isActive: true } });
    const otcMed = await prisma.medicine.findFirstOrThrow({ where: { requiresPrescription: false, deletedAt: null, isActive: true } });
    const rxFileName = `rbac-rx-${RUN_ID}.png`;
    const rxDir = path.resolve("storage", "prescriptions");
    await mkdir(rxDir, { recursive: true });
    const rxPath = path.join(rxDir, rxFileName);
    await writeFile(rxPath, VALID_PNG_1X1, { mode: 0o600 });
    cleanupFiles.push(rxPath);

    const rxOrder = await createOrder(
      {
        channel: "ONLINE",
        items: [{ medicineId: rxMed.id, quantity: 1 }],
        customerId: cust.customerId,
        fullName: "RBAC Cust",
        phone: cust.phone,
        province: "Phnom Penh",
        district: "Doun Penh",
        prescriptionUrl: createPrescriptionClaimUrl(rxFileName, cust.user.id),
      },
      cust.user.id,
    );
    cleanupOrderIds.push(rxOrder.id);

    const khqrMethod = await prisma.paymentMethod.findUniqueOrThrow({ where: { code: "KHQR" } });
    const rxPay = await prisma.payment.create({
      data: {
        reference: `PAY-RBAC-${RUN_ID}`,
        orderId: rxOrder.id,
        methodId: khqrMethod.id,
        amountUsd: rxOrder.total,
        currency: "USD",
        amount: rxOrder.total,
        status: "PENDING",
      },
    });

    // ── 1. CUSTOMER cannot access any admin APIs or admin pages ──
    for (const p of ["/api/admin/dashboard", "/api/admin/medicines", "/api/admin/orders", "/api/admin/staff", "/api/admin/settings/payments", "/api/admin/pos/methods"]) {
      assert.equal((await apiReq(p, { cookie: custCookie })).status, 403, `Customer must get 403 on ${p}`);
    }
    const custAdminPage = await apiReq("/admin", { cookie: custCookie });
    assert.equal(custAdminPage.status, 307);
    assert.equal(custAdminPage.headers.get("location")?.endsWith("/"), true);

    // ── 2. STAFF cannot access customer-only APIs or /account pages ──
    for (const p of ["/api/account/addresses", "/api/account/wishlist", "/api/orders"]) {
      assert.equal((await apiReq(p, { cookie: cashierCookie })).status, 403, `Staff must get 403 on ${p}`);
    }
    const staffAcctPage = await apiReq("/account/profile", { cookie: cashierCookie });
    assert.equal(staffAcctPage.status, 307);
    assert.ok((staffAcctPage.headers.get("location") ?? "").includes("/admin"));

    // ── 3. INVENTORY_STAFF RBAC & dashboard scoping ──
    assert.equal((await apiReq("/api/admin/inventory", { cookie: invCookie })).status, 200);
    assert.equal((await apiReq("/api/admin/suppliers", { cookie: invCookie })).status, 200);
    assert.equal((await apiReq("/api/admin/purchases", { cookie: invCookie })).status, 200);
    for (const [m, p, b] of [
      ["GET", "/api/admin/orders"],
      ["GET", "/api/admin/customers"],
      ["GET", "/api/admin/payments"],
      ["POST", `/api/admin/payments/${rxPay.id}/check`],
      ["GET", "/api/admin/pos/methods"],
      ["POST", "/api/admin/pos/sale", { items: [{ medicineId: otcMed.id, quantity: 1 }], method: "CASH" }],
      ["GET", "/api/admin/reports/sales"],
      ["GET", "/api/admin/settings/store"],
      ["GET", "/api/admin/settings/payments"],
      ["GET", "/api/admin/staff"],
      ["GET", "/api/admin/audit"],
      ["GET", `/api/files/prescriptions/${rxFileName}`],
    ] as [string, string, unknown?][]) {
      assert.equal((await apiReq(p, { method: m, cookie: invCookie, body: b })).status, 403, `INVENTORY_STAFF must get 403 on ${m} ${p}`);
    }
    // Scoped dashboard for INVENTORY_STAFF: no recent customer orders, no payments, no customer count, no profit
    const invDash = await apiReq("/api/admin/dashboard", { cookie: invCookie });
    assert.equal(invDash.status, 200);
    const invDashJson = (await invDash.json()) as { recent: unknown[]; payments: unknown[]; totals: { customers: number; monthProfit: number } };
    assert.equal(invDashJson.recent.length, 0, "INVENTORY_STAFF dashboard must not expose recent orders");
    assert.equal(invDashJson.payments.length, 0, "INVENTORY_STAFF dashboard must not expose payment breakdown");
    assert.equal(invDashJson.totals.customers, 0, "INVENTORY_STAFF dashboard must not expose customer count");
    assert.equal(invDashJson.totals.monthProfit, 0, "INVENTORY_STAFF dashboard must not expose profit");

    // Unauthorized direct admin pages redirect cleanly (307 -> /admin, NEVER 500!)
    for (const deniedPage of ["/admin/orders", "/admin/payments", "/admin/pos", "/admin/staff", "/admin/settings", "/admin/reports", "/admin/audit"]) {
      const r = await apiReq(deniedPage, { cookie: invCookie });
      assert.equal(r.status, 307, `INVENTORY_STAFF visiting ${deniedPage} must redirect (307), not crash (${r.status})`);
      assert.ok((r.headers.get("location") ?? "").endsWith("/admin"));
    }

    // ── 4. CASHIER RBAC & prescription exfiltration chain blocked ──
    assert.equal((await apiReq("/api/admin/pos/methods", { cookie: cashierCookie })).status, 200);
    assert.equal((await apiReq("/api/admin/orders", { cookie: cashierCookie })).status, 200);

    // Prescription exfiltration chain completely blocked for CASHIER:
    const cashierAdminOrd = await apiReq(`/api/admin/orders/${rxOrder.id}`, { cookie: cashierCookie });
    assert.equal(cashierAdminOrd.status, 200);
    assert.equal(((await cashierAdminOrd.json()) as { prescriptionUrl: string | null }).prescriptionUrl, null);

    const cashierPubOrd = await apiReq(`/api/orders/${rxOrder.id}`, { cookie: cashierCookie });
    assert.equal(cashierPubOrd.status, 200);
    assert.equal(((await cashierPubOrd.json()) as { prescriptionUrl: string | null }).prescriptionUrl, null, "GET /api/orders/:id must redact prescriptionUrl for CASHIER");

    assert.equal((await apiReq(`/checkout/pay/${rxOrder.id}`, { cookie: cashierCookie })).status, 404, "CASHIER must not access customer /checkout/pay/:id (prevents token exfiltration)");
    assert.equal((await apiReq(`/api/files/prescriptions/${rxFileName}`, { cookie: cashierCookie })).status, 403);

    // CASHIER cannot mutate customer online payments, dispense Rx at POS, apply manual discounts, or access inventory/batches/reports/staff
    assert.equal((await apiReq(`/api/orders/${rxOrder.id}/pay`, { method: "POST", cookie: cashierCookie, body: { method: "KHQR", currency: "USD" } })).status, 403);
    assert.equal((await apiReq(`/api/payments/${rxPay.id}/usdt-hash`, { method: "POST", cookie: cashierCookie, body: { txHash: "0x" + "d".repeat(64) } })).status, 403);
    assert.equal((await apiReq(`/api/payments/${rxPay.id}/paypal-capture`, { method: "POST", cookie: cashierCookie })).status, 403);
    assert.equal(
      (await apiReq("/api/admin/pos/sale", { method: "POST", cookie: cashierCookie, body: { items: [{ medicineId: rxMed.id, quantity: 1 }], method: "CASH" } })).status,
      403,
    );
    assert.equal(
      (await apiReq("/api/admin/pos/sale", { method: "POST", cookie: cashierCookie, body: { items: [{ medicineId: otcMed.id, quantity: 1 }], manualDiscount: 1, method: "CASH" } })).status,
      403,
    );

    // CASHIER medicine detail redacts batches & movements (no inventory.read)
    const cashierMed = await apiReq(`/api/admin/medicines/${otcMed.id}`, { cookie: cashierCookie });
    assert.equal(cashierMed.status, 200);
    const cashierMedJson = (await cashierMed.json()) as { batches: unknown[]; movements: unknown[] };
    assert.equal(cashierMedJson.batches.length, 0, "CASHIER must not receive batch cost/supplier records via medicine detail");
    assert.equal(cashierMedJson.movements.length, 0, "CASHIER must not receive stock movements via medicine detail");

    // CASHIER dashboard redacts inventory valuation & profit
    const cashierDash = await apiReq("/api/admin/dashboard", { cookie: cashierCookie });
    assert.equal(cashierDash.status, 200);
    const cashierDashJson = (await cashierDash.json()) as { stock: { costValue: number; retailValue: number }; totals: { monthProfit: number } };
    assert.equal(cashierDashJson.stock.costValue, 0);
    assert.equal(cashierDashJson.stock.retailValue, 0);
    assert.equal(cashierDashJson.totals.monthProfit, 0);

    // CASHIER POS page redacts provider env diagnostics
    const cashierPosPage = await apiReq("/admin/pos", { cookie: cashierCookie });
    assert.equal(cashierPosPage.status, 200);
    const cashierPosHtml = await cashierPosPage.text();
    assert.equal(/BAKONG_API_TOKEN|PAYPAL_CLIENT_ID|TRONGRID_API_KEY/.test(cashierPosHtml), false, "POS page must not leak env var diagnostics to CASHIER");

    for (const [m, p, b] of [
      ["POST", `/api/admin/orders/${rxOrder.id}/status`, { status: "CONFIRMED" }],
      ["POST", `/api/admin/orders/${rxOrder.id}/prescription`, { approve: true }],
      ["POST", `/api/admin/orders/${rxOrder.id}/refund`, { reason: "attempt" }],
      ["GET", "/api/admin/inventory"],
      ["GET", "/api/admin/reports/sales"],
      ["GET", "/api/admin/settings/store"],
      ["GET", "/api/admin/settings/payments"],
      ["GET", "/api/admin/staff"],
      ["GET", "/api/admin/audit"],
    ] as [string, string, unknown?][]) {
      assert.equal((await apiReq(p, { method: m, cookie: cashierCookie, body: b })).status, 403, `CASHIER must get 403 on ${m} ${p}`);
    }

    for (const deniedPage of ["/admin/staff", "/admin/settings", "/admin/reports", "/admin/inventory", "/admin/medicines/new", "/admin/categories", "/admin/marketing"]) {
      const r = await apiReq(deniedPage, { cookie: cashierCookie });
      assert.equal(r.status, 307, `CASHIER visiting ${deniedPage} must redirect (307), got ${r.status}`);
    }

    // ── 5. PHARMACIST RBAC ──
    assert.equal((await apiReq(`/api/files/prescriptions/${rxFileName}`, { cookie: pharmCookie })).status, 200);
    assert.equal(
      (await apiReq(`/api/admin/orders/${rxOrder.id}/status`, { method: "POST", cookie: pharmCookie, body: { status: "CANCELLED", note: "nope" } })).status,
      403,
    );
    assert.equal((await apiReq(`/api/admin/orders/${rxOrder.id}/refund`, { method: "POST", cookie: pharmCookie, body: { reason: "nope" } })).status, 403);
    assert.equal((await apiReq(`/api/admin/medicines/${otcMed.id}`, { method: "DELETE", cookie: pharmCookie })).status, 403);
    assert.equal((await apiReq("/api/admin/staff", { cookie: pharmCookie })).status, 403);
    assert.equal((await apiReq("/api/admin/settings/payments", { cookie: pharmCookie })).status, 403);
    assert.equal((await apiReq("/api/admin/reports/sales", { cookie: pharmCookie })).status, 403);

    // ── 6. ADMIN RBAC (cannot manage staff or payment gateways) ──
    assert.equal((await apiReq("/api/admin/settings/store", { cookie: adminCookie })).status, 200);
    assert.equal((await apiReq("/api/admin/reports/sales", { cookie: adminCookie })).status, 200);
    assert.equal((await apiReq("/api/admin/audit", { cookie: adminCookie })).status, 200);
    assert.equal((await apiReq("/api/admin/staff", { cookie: adminCookie })).status, 403);
    assert.equal((await apiReq("/api/admin/settings/payments", { cookie: adminCookie })).status, 403);
    assert.equal((await apiReq("/admin/staff", { cookie: adminCookie })).status, 307);

    // ── 7. SUPER_ADMIN allowed on staff & payment settings, cannot self-demote or self-suspend ──
    assert.equal((await apiReq("/api/admin/staff", { cookie: superCookie })).status, 200);
    assert.equal((await apiReq("/api/admin/settings/payments", { cookie: superCookie })).status, 200);
    const selfDemote = await apiReq(`/api/admin/staff/${superAdmin.user.id}`, {
      method: "PUT",
      cookie: superCookie,
      body: { name: superAdmin.user.name, email: superAdmin.email, role: "CASHIER", status: "ACTIVE" },
    });
    assert.equal(selfDemote.status, 400);
  });

  it("blocks mass-assignment privilege escalation, headerless CSRF, and revokes reset tokens on password change", async (t) => {
    if (!(await serverReachable())) {
      t.skip("App server not reachable");
      return;
    }

    const cust = await createTempUser({ roleKey: "CUSTOMER", tag: "csrf-pw" });
    const cookie = await loginAs(cust.email, cust.rawPassword, "customer");

    // Mass assignment on /api/account/profile rejected (422)
    const massAssign = await apiReq("/api/account/profile", {
      method: "PATCH",
      cookie,
      body: { name: "Escalated", phone: "012 999 888", role: "SUPER_ADMIN", isStaff: true },
    });
    assert.equal(massAssign.status, 422);

    // Headerless authenticated CSRF (Cookie present, no Origin / Referer / Sec-Fetch-Site) blocked with 403
    const headerlessCsrf = await apiReq("/api/account/profile", {
      method: "PATCH",
      cookie,
      origin: null,
      body: { name: "CsrfAttempt", phone: "012 999 888" },
    });
    assert.equal(headerlessCsrf.status, 403, "Authenticated mutating request omitting Origin/Referer/Sec-Fetch-Site must be blocked (403)");

    // Cross-origin CSRF blocked with 403
    const crossOriginCsrf = await apiReq("/api/account/profile", {
      method: "PATCH",
      cookie,
      origin: "https://attacker.invalid",
      body: { name: "CsrfAttempt", phone: "012 999 888" },
    });
    assert.equal(crossOriginCsrf.status, 403);

    // Pending password-reset token is revoked when the user changes their password
    const rawResetToken = `auditResetTok_${RUN_ID}_${"z".repeat(24)}`;
    await prisma.passwordResetToken.create({
      data: {
        tokenHash: hashPasswordResetToken(rawResetToken),
        userId: cust.user.id,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      },
    });
    const pwRes = await apiReq("/api/account/password", {
      method: "POST",
      cookie,
      body: { currentPassword: cust.rawPassword, newPassword: "NewStrongPass#2026" },
    });
    assert.equal(pwRes.status, 200);
    const remainingTokens = await prisma.passwordResetToken.count({ where: { userId: cust.user.id } });
    assert.equal(remainingTokens, 0, "Password change must revoke any pending PasswordResetToken rows");

    // Old session cookie is immediately invalidated after password change
    const replayOld = await apiReq("/api/account/profile", { cookie });
    assert.equal(replayOld.status, 401);
  });
});

after(async () => {
  for (const oid of cleanupOrderIds) {
    await cancelOrder(oid, null, "Auth audit test cleanup", { system: true }).catch(() => {});
    await prisma.order.delete({ where: { id: oid } }).catch(() => {});
  }
  for (const uid of cleanupUserIds) {
    await prisma.auditLog.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.user.delete({ where: { id: uid } }).catch(() => {});
  }
  for (const fp of cleanupFiles) {
    await unlink(fp).catch(() => {});
  }
  await prisma.$disconnect();
});
