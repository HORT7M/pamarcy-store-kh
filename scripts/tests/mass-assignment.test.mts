import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { prisma } from "../../src/lib/db.ts";
import { hashSessionToken, SESSION_COOKIE } from "../../src/lib/auth/session.ts";
import { createOrder, cancelOrder } from "../../src/lib/services/orders.ts";
import { initiatePayment, recordCashPayment } from "../../src/lib/services/payments/index.ts";
import {
  pickAllowed,
  PROTECTED_ACCOUNT_FIELDS,
  PROTECTED_COMMERCE_FIELDS,
  PROFILE_UPDATE_FIELDS,
  ADDRESS_WRITE_FIELDS,
  CART_QUOTE_FIELDS,
  ONLINE_ORDER_CREATE_FIELDS,
  ONLINE_PAYMENT_INITIATE_FIELDS,
  REVIEW_WRITE_FIELDS,
  MEDICINE_WRITE_FIELDS,
  CATEGORY_WRITE_FIELDS,
  BRAND_WRITE_FIELDS,
  SUPPLIER_WRITE_FIELDS,
  BANNER_WRITE_FIELDS,
  DISCOUNT_WRITE_FIELDS,
  STOCK_IN_FIELDS,
  BATCH_ADJUST_FIELDS,
  ADMIN_CUSTOMER_USER_UPDATE_FIELDS,
  ADMIN_STAFF_USER_WRITE_FIELDS,
  ADMIN_STAFF_EMPLOYEE_WRITE_FIELDS,
  STORE_SETTINGS_FIELDS,
  KHQR_CONFIG_FIELDS,
  USDT_NETWORK_CONFIG_FIELDS,
  PAYPAL_CONFIG_FIELDS,
} from "../../src/lib/allowlist.ts";
import {
  registerSchema,
  profileSchema,
  addressSchema,
  cartQuoteSchema,
  checkoutSchema,
  onlineInitiatePaymentSchema,
  reviewSchema,
  medicineSchema,
  medicineUpdateSchema,
  categorySchema,
  brandSchema,
  supplierSchema,
  bannerSchema,
  discountSchema,
  stockInSchema,
  adjustSchema,
  customerUpdateSchema,
  staffCreateSchema,
  staffSchema,
  posSaleSchema,
  storeSettingsSchema,
  paymentSettingsSchema,
} from "../../src/lib/validators.ts";

if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}

const APP = process.env.APP_URL || "http://localhost:3000";
const cleanupSessions: string[] = [];
const cleanupOrderIds: string[] = [];
const cleanupAddressIds: string[] = [];

function walkRouteFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkRouteFiles(full, out);
    else if (ent.name === "route.ts") out.push(full);
  }
  return out;
}

async function createSessionCookie(userId: string, isStaff: boolean): Promise<string> {
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

async function findActiveUserByRole(roleKey: string) {
  const u = await prisma.user.findFirst({
    where: { deletedAt: null, status: "ACTIVE", role: { key: roleKey } },
    include: { customer: true, role: true },
    orderBy: { createdAt: "asc" },
  });
  assert.ok(u, `Expected active user with role ${roleKey}`);
  return u;
}

async function postJson(
  urlPath: string,
  payload: unknown,
  opts: { method?: string; cookie?: string } = {},
) {
  return fetch(`${APP}${urlPath}`, {
    method: opts.method ?? "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: APP,
      ...(opts.cookie ? { Cookie: opts.cookie } : {}),
    },
    body: JSON.stringify(payload),
  });
}

after(async () => {
  for (const id of cleanupOrderIds) {
    await cancelOrder(id, null, "mass-assignment test cleanup", { system: true }).catch(() => {});
  }
  if (cleanupAddressIds.length) {
    await prisma.address.deleteMany({ where: { id: { in: cleanupAddressIds } } }).catch(() => {});
  }
  if (cleanupSessions.length) {
    await prisma.session.deleteMany({ where: { tokenHash: { in: cleanupSessions } } }).catch(() => {});
  }
  await prisma.$disconnect();
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. STATIC AUDIT: ZERO MASS ASSIGNMENT / RAW BODY SPREADS / BARE STAFF CHECKS
// ═══════════════════════════════════════════════════════════════════════════════

describe("Static API mass-assignment & authorization audit", () => {
  it("never passes raw parsed body objects directly to Prisma create/update or spreads unprojected body objects", () => {
    const routes = walkRouteFiles("src/app/api");
    assert.ok(routes.length >= 70, `Expected >=70 API route files, found ${routes.length}`);

    for (const file of routes) {
      const content = readFileSync(file, "utf8");
      assert.equal(
        /\bdata:\s*await\s+parseBody\b/.test(content),
        false,
        `${file} must not pass parseBody() directly into Prisma data`,
      );
      assert.equal(
        /\bdata:\s*(body|b)\s*[,}]/.test(content),
        false,
        `${file} must not pass raw body variable into Prisma data (use pickAllowed)`,
      );
      assert.equal(
        /\.\.\.(body|b)\s*[,}]/.test(content),
        false,
        `${file} must not spread raw parsed body directly (use pickAllowed)`,
      );
      // Exclude PayPal webhook which reads raw text for signature verification
      if (!file.endsWith(path.join("webhooks", "paypal", "route.ts"))) {
        assert.equal(
          /\breq\.json\s*\(/.test(content),
          false,
          `${file} must not call req.json() directly (use parseBody)`,
        );
      }
    }
  });

  it("enforces explicit RBAC permission strings on every /api/admin/** route (no bare requireStaff())", () => {
    const adminRoutes = walkRouteFiles("src/app/api/admin");
    assert.ok(adminRoutes.length >= 30, `Expected >=30 admin route files, found ${adminRoutes.length}`);
    for (const file of adminRoutes) {
      const content = readFileSync(file, "utf8");
      assert.equal(
        /\brequireStaff\(\s*\)/.test(content),
        false,
        `${file} must specify an explicit RBAC permission in requireStaff("...")`,
      );
    }
  });

  it("never includes protected account or commerce fields in client-writable allowlists", () => {
    const selfServiceAllowlists: Record<string, readonly string[]> = {
      PROFILE_UPDATE_FIELDS,
      ADDRESS_WRITE_FIELDS,
      CART_QUOTE_FIELDS,
      ONLINE_ORDER_CREATE_FIELDS,
      ONLINE_PAYMENT_INITIATE_FIELDS,
      REVIEW_WRITE_FIELDS,
    };

    const protectedSet = new Set<string>([
      ...PROTECTED_ACCOUNT_FIELDS,
      ...PROTECTED_COMMERCE_FIELDS,
    ]);

    for (const [name, fields] of Object.entries(selfServiceAllowlists)) {
      for (const f of fields) {
        assert.equal(
          protectedSet.has(f),
          false,
          `Self-service allowlist ${name} must NEVER contain protected field "${f}"`,
        );
      }
    }

    // Even admin resource allowlists must NEVER include privilege/identity/system columns
    const strictlyNeverAllowlisted = new Set<string>([
      "id",
      "role",
      "roleId",
      "role_id",
      "permissions",
      "isStaff",
      "is_staff",
      "isAdmin",
      "is_admin",
      "userId",
      "user_id",
      "customerId",
      "customer_id",
      "employeeId",
      "employee_id",
      "employeeCode",
      "passwordHash",
      "password_hash",
      "deletedAt",
      "deleted_at",
      "lastLoginAt",
      "createdAt",
      "updatedAt",
      "createdById",
      "cashierId",
      "reviewedById",
      "soldCount",
      "usedCount",
      "paymentStatus",
      "fulfillmentStatus",
      "prescriptionStatus",
      "subtotal",
      "discountAmount",
      "deliveryFee",
      "total",
      "amountUsd",
      "manualDiscount",
      "staffCanDispenseRx",
      "channel",
    ]);

    const adminAllowlists: Record<string, readonly string[]> = {
      MEDICINE_WRITE_FIELDS,
      CATEGORY_WRITE_FIELDS,
      BRAND_WRITE_FIELDS,
      SUPPLIER_WRITE_FIELDS,
      BANNER_WRITE_FIELDS,
      DISCOUNT_WRITE_FIELDS,
      STOCK_IN_FIELDS,
      BATCH_ADJUST_FIELDS,
      ADMIN_CUSTOMER_USER_UPDATE_FIELDS,
      ADMIN_STAFF_USER_WRITE_FIELDS,
      ADMIN_STAFF_EMPLOYEE_WRITE_FIELDS,
      STORE_SETTINGS_FIELDS,
      KHQR_CONFIG_FIELDS,
      USDT_NETWORK_CONFIG_FIELDS,
      PAYPAL_CONFIG_FIELDS,
    };

    for (const [name, fields] of Object.entries(adminAllowlists)) {
      for (const f of fields) {
        assert.equal(
          strictlyNeverAllowlisted.has(f),
          false,
          `Admin allowlist ${name} must NEVER contain system/privilege field "${f}"`,
        );
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. UNIT TESTS: pickAllowed() & STRICT ZOD SCHEMA PARAMETER-TAMPERING REJECTION
// ═══════════════════════════════════════════════════════════════════════════════

describe("pickAllowed() projection helper", () => {
  it("strips protected account fields, unknown fields, prototype keys, and inherited properties", () => {
    const proto = { name: "InheritedName", role: "SUPER_ADMIN" };
    const attacker = Object.assign(Object.create(proto), {
      phone: "+85512345678",
      locale: "en",
      role: "SUPER_ADMIN",
      roleId: "role_super",
      userId: "victim_id",
      user_id: "victim_id",
      customerId: "victim_cust",
      permissions: ["users.manage", "settings.payments"],
      isStaff: true,
      status: "ACTIVE",
      passwordHash: "forged",
      deletedAt: null,
    });

    const out = pickAllowed(attacker, PROFILE_UPDATE_FIELDS, { omitUndefined: true });
    assert.deepEqual(out, { phone: "+85512345678", locale: "en" });
    assert.equal("name" in out, false, "Inherited prototype property must not be copied");
    for (const key of PROTECTED_ACCOUNT_FIELDS) {
      assert.equal(key in out, false, `Protected key "${key}" must not appear in output`);
    }
  });

  it("omits undefined values when omitUndefined is true and preserves explicit nulls", () => {
    const input = { name: "Alice", phone: undefined, email: "a@example.com", status: undefined };
    const out = pickAllowed(input, ADMIN_CUSTOMER_USER_UPDATE_FIELDS, { omitUndefined: true });
    assert.deepEqual(out, { name: "Alice", email: "a@example.com" });
    assert.equal(Object.hasOwn(out, "phone"), false);
    assert.equal(Object.hasOwn(out, "status"), false);
  });
});

describe("Strict Zod schema mass-assignment & parameter-tampering defenses", () => {
  const validId = "cm00000000000000000000001";

  it("rejects protected account fields across register, profile, address, customerUpdate, and staff schemas", () => {
    const poisonedFields = [
      { role: "SUPER_ADMIN" },
      { roleId: validId },
      { role_id: validId },
      { userId: validId },
      { user_id: validId },
      { customerId: validId },
      { permissions: ["users.manage"] },
      { isStaff: true },
      { isAdmin: true },
      { passwordHash: "$2b$10$fake" },
      { deletedAt: null },
    ];

    const baseRegister = {
      name: "Test User",
      email: "test.mass@example.com",
      phone: "+85512999888",
      password: "ValidPassword123",
    };
    const baseProfile = { name: "Test User", phone: "+85512999888", locale: "en" as const };
    const baseAddress = {
      fullName: "Test User",
      phone: "+85512999888",
      province: "Phnom Penh",
      district: "Doun Penh",
    };

    for (const extra of poisonedFields) {
      assert.equal(registerSchema.safeParse({ ...baseRegister, ...extra }).success, false, `registerSchema must reject ${JSON.stringify(extra)}`);
      assert.equal(profileSchema.safeParse({ ...baseProfile, ...extra }).success, false, `profileSchema must reject ${JSON.stringify(extra)}`);
      assert.equal(addressSchema.safeParse({ ...baseAddress, ...extra }).success, false, `addressSchema must reject ${JSON.stringify(extra)}`);
    }

    // Profile must also reject email & status changes
    assert.equal(profileSchema.safeParse({ ...baseProfile, email: "hijack@example.com" }).success, false);
    assert.equal(profileSchema.safeParse({ ...baseProfile, status: "ACTIVE" }).success, false);
    assert.equal(registerSchema.safeParse({ ...baseRegister, status: "ACTIVE" }).success, false);

    // customerUpdateSchema must reject empty payload and protected fields
    assert.equal(customerUpdateSchema.safeParse({}).success, false, "Empty customer update payload must be rejected");
    assert.equal(customerUpdateSchema.safeParse({ role: "SUPER_ADMIN" }).success, false);
    assert.equal(customerUpdateSchema.safeParse({ userId: validId }).success, false);
    assert.equal(customerUpdateSchema.safeParse({ permissions: ["*"] }).success, false);
    assert.equal(customerUpdateSchema.safeParse({ name: "Valid Customer" }).success, true);

    // staffCreateSchema requires password, forbids CUSTOMER role and SUSPENDED status on create
    const baseStaff = {
      name: "New Pharmacist",
      email: "new.pharm@example.com",
      phone: "+85512999777",
      role: "PHARMACIST" as const,
      password: "StrongPassword123",
    };
    assert.equal(staffCreateSchema.safeParse(baseStaff).success, true);
    assert.equal(staffCreateSchema.safeParse({ ...baseStaff, password: "" }).success, false);
    assert.equal(staffCreateSchema.safeParse({ ...baseStaff, status: "SUSPENDED" }).success, false);
    assert.equal(staffCreateSchema.safeParse({ ...baseStaff, role: "CUSTOMER" }).success, false);
    assert.equal(staffCreateSchema.safeParse({ ...baseStaff, permissions: ["*"] }).success, false);
    assert.equal(staffCreateSchema.safeParse({ ...baseStaff, employeeCode: "EMP-001" }).success, false);
    assert.equal(staffSchema.safeParse({ ...baseStaff, role: "CUSTOMER" }).success, false);
    assert.equal(staffSchema.safeParse({ ...baseStaff, roleId: validId }).success, false);
  });

  it("rejects commerce pricing, discount, ownership, and status tampering in cart/checkout/payment/review/POS schemas", () => {
    const baseCart = { items: [{ medicineId: validId, quantity: 2 }], province: "Phnom Penh" };
    for (const extra of [{ manualDiscount: 100 }, { price: 0.01 }, { total: 0 }, { deliveryFee: 0 }, { channel: "POS" }]) {
      assert.equal(cartQuoteSchema.safeParse({ ...baseCart, ...extra }).success, false, `cartQuoteSchema must reject ${JSON.stringify(extra)}`);
    }

    const baseCheckout = {
      items: [{ medicineId: validId, quantity: 1 }],
      fullName: "Customer",
      phone: "+85512111222",
      province: "Phnom Penh",
      district: "Doun Penh",
    };
    for (const extra of [
      { manualDiscount: 50 },
      { staffCanDispenseRx: true },
      { cashierId: validId },
      { customerId: validId },
      { userId: validId },
      { user_id: validId },
      { channel: "POS" },
      { total: 0.01 },
      { subtotal: 0.01 },
      { deliveryFee: 0 },
      { paymentStatus: "PAID" },
      { status: "DELIVERED" },
      { prescriptionStatus: "APPROVED" },
      { notes: "internal note" },
    ]) {
      assert.equal(checkoutSchema.safeParse({ ...baseCheckout, ...extra }).success, false, `checkoutSchema must reject ${JSON.stringify(extra)}`);
    }

    // Online payment initiation must reject CASH, channel override, amount tampering, status tampering
    assert.equal(onlineInitiatePaymentSchema.safeParse({ method: "CASH" }).success, false);
    assert.equal(onlineInitiatePaymentSchema.safeParse({ method: "KHQR", channel: "pos" }).success, false);
    assert.equal(onlineInitiatePaymentSchema.safeParse({ method: "KHQR", amount: 0.01 }).success, false);
    assert.equal(onlineInitiatePaymentSchema.safeParse({ method: "KHQR", status: "PAID" }).success, false);

    // Review must reject customerId/userId/medicineId tampering
    assert.equal(reviewSchema.safeParse({ rating: 5, comment: "Great", customerId: validId }).success, false);
    assert.equal(reviewSchema.safeParse({ rating: 5, comment: "Great", user_id: validId }).success, false);

    // POS sale must reject staffCanDispenseRx, cashierId, paymentStatus, total tampering
    const basePos = { items: [{ medicineId: validId, quantity: 1 }], method: "CASH" as const };
    assert.equal(posSaleSchema.safeParse({ ...basePos, staffCanDispenseRx: true }).success, false);
    assert.equal(posSaleSchema.safeParse({ ...basePos, cashierId: validId }).success, false);
    assert.equal(posSaleSchema.safeParse({ ...basePos, total: 0.01 }).success, false);
    assert.equal(posSaleSchema.safeParse({ ...basePos, paymentStatus: "PAID" }).success, false);
  });

  it("enforces medicineUpdateSchema, adjustSchema mode/type coupling, and rejects counter/deletedAt tampering on admin schemas", () => {
    const baseMed = {
      nameEn: "Paracetamol 500mg",
      nameKm: "ប៉ារ៉ាសេតាម៉ុល",
      sku: "PARA-500-TEST",
      categoryId: validId,
      price: 2.5,
      costPrice: 1.0,
    };
    assert.equal(medicineUpdateSchema.safeParse(baseMed).success, true);
    assert.equal(medicineUpdateSchema.safeParse({ ...baseMed, initialStock: null }).success, true);
    assert.equal(
      medicineUpdateSchema.safeParse({ ...baseMed, initialStock: { batchNumber: "B1", quantity: 100 } }).success,
      false,
      "PUT medicineUpdateSchema must reject non-null initialStock",
    );
    assert.equal(medicineSchema.safeParse({ ...baseMed, soldCount: 9999 }).success, false);
    assert.equal(medicineSchema.safeParse({ ...baseMed, deletedAt: null }).success, false);
    assert.equal(medicineSchema.safeParse({ ...baseMed, slug: "forged-slug" }).success, false);

    // adjustSchema mode/type coupling
    assert.equal(adjustSchema.safeParse({ mode: "out", quantity: 5, reason: "Damaged", type: "STOCK_OUT" }).success, true);
    assert.equal(adjustSchema.safeParse({ mode: "out", quantity: 5, reason: "Expired", type: "EXPIRED_WRITE_OFF" }).success, true);
    assert.equal(adjustSchema.safeParse({ mode: "set", quantity: 10, reason: "Cycle count", type: "ADJUSTMENT" }).success, true);
    assert.equal(adjustSchema.safeParse({ mode: "set", quantity: 10, reason: "Mismatch", type: "STOCK_OUT" }).success, false);
    assert.equal(adjustSchema.safeParse({ mode: "set", quantity: 10, reason: "Mismatch", type: "EXPIRED_WRITE_OFF" }).success, false);
    assert.equal(adjustSchema.safeParse({ mode: "out", quantity: 5, reason: "Mismatch", type: "ADJUSTMENT" }).success, false);
    assert.equal(adjustSchema.safeParse({ mode: "out", quantity: 5, reason: "Inject", userId: validId }).success, false);

    // Stock-in must reject userId, type, reserved tampering
    assert.equal(stockInSchema.safeParse({ medicineId: validId, batchNumber: "B1", quantity: 10, userId: validId }).success, false);
    assert.equal(stockInSchema.safeParse({ medicineId: validId, batchNumber: "B1", quantity: 10, type: "PURCHASE_RECEIVE" }).success, false);

    // Discount, category, brand, supplier, banner, settings reject protected/unknown keys
    assert.equal(discountSchema.safeParse({ code: "SAVE10", type: "PERCENTAGE", value: 10, usedCount: 0 }).success, false);
    assert.equal(discountSchema.safeParse({ code: "SAVE10", type: "PERCENTAGE", value: 10, deletedAt: null }).success, false);
    assert.equal(categorySchema.safeParse({ nameEn: "Cat", nameKm: "ប្រភេទ", deletedAt: null }).success, false);
    assert.equal(brandSchema.safeParse({ name: "Brand", deletedAt: null, slug: "x" }).success, false);
    assert.equal(supplierSchema.safeParse({ name: "Supplier", deletedAt: null }).success, false);
    assert.equal(bannerSchema.safeParse({ titleEn: "Banner", titleKm: "បដា", imageUrl: "/uploads/banners/a.png", id: validId }).success, false);
    assert.equal(storeSettingsSchema.safeParse({ storeNameEn: "Store", storeNameKm: "ហាង", role: "SUPER_ADMIN" }).success, false);
    assert.equal(
      paymentSettingsSchema.safeParse({
        KHQR: { enabled: false, online: false, pos: false, config: { secretToken: "injected" } },
        USDT: { enabled: false, online: false, pos: false, config: { expiryMinutes: 30, networks: [] } },
        PAYPAL: { enabled: false, online: false, pos: false, config: { brandName: "Store" } },
        CASH: { enabled: true, online: false, pos: true, config: {} },
      }).success,
      false,
      "paymentSettingsSchema must reject unknown keys inside provider config",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. SERVICE-LEVEL STATE-MACHINE & CHANNEL-BINDING TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("Payment service channel-binding & cash state-machine guards", () => {
  it("prevents initiatePayment channel mismatch and blocks recordCashPayment on expired/cancelled/online payments", async () => {
    const cust = await findActiveUserByRole("CUSTOMER");
    const cashier = await findActiveUserByRole("CASHIER");
    const med = await prisma.medicine.findFirstOrThrow({
      where: {
        deletedAt: null,
        isActive: true,
        requiresPrescription: false,
        inventory: { is: { quantity: { gt: 5 } } },
      },
    });
    const cashMethod = await prisma.paymentMethod.findUniqueOrThrow({ where: { code: "CASH" } });

    // Create an ONLINE order
    const onlineOrder = await createOrder(
      {
        channel: "ONLINE",
        items: [{ medicineId: med.id, quantity: 1 }],
        customerId: cust.customer!.id,
        fullName: cust.name,
        phone: "+85512340001",
        province: "Phnom Penh",
        district: "Doun Penh",
      },
      cust.id,
    );
    cleanupOrderIds.push(onlineOrder.id);
    try {
    // Channel mismatch: cannot initiate POS payment for an ONLINE order
    await assert.rejects(
      () => initiatePayment(onlineOrder.id, { method: "CASH", channel: "pos" }, cashier.id),
      /channel|online/i,
      "initiatePayment must reject POS channel on an ONLINE order",
    );
    } finally {
      await cancelOrder(onlineOrder.id, null, "immediate test cleanup", { system: true }).catch(() => {});
    }

    // Create a POS order + CASH payment, then expire/cancel it and verify recordCashPayment refuses to resurrect it
    const posOrder = await createOrder(
      {
        channel: "POS",
        items: [{ medicineId: med.id, quantity: 1 }],
        cashierId: cashier.id,
        fullName: "Walk-in",
        phone: "+85500000000",
        staffCanDispenseRx: false,
      },
      cashier.id,
    );
    cleanupOrderIds.push(posOrder.id);

    // Channel mismatch: cannot initiate ONLINE payment for a POS order
    await assert.rejects(
      () => initiatePayment(posOrder.id, { method: "KHQR", channel: "online" }, cust.id),
      /channel/i,
      "initiatePayment must reject online channel on a POS order",
    );

    const expiredPay = await prisma.payment.create({
      data: {
        reference: `PAY-MA-EXP-${Date.now()}`,
        orderId: posOrder.id,
        methodId: cashMethod.id,
        status: "EXPIRED",
        amountUsd: posOrder.total,
        currency: "USD",
        amount: posOrder.total,
      },
    });
    await assert.rejects(
      () => recordCashPayment(expiredPay.id, Number(posOrder.total) + 10, cashier.id),
      /expired|already/i,
      "recordCashPayment must reject EXPIRED payments",
    );

    // Cancel POS order and verify a PENDING payment attached to it cannot be paid in cash
    const pendingPay = await prisma.payment.create({
      data: {
        reference: `PAY-MA-PEND-${Date.now()}`,
        orderId: posOrder.id,
        methodId: cashMethod.id,
        status: "PENDING",
        amountUsd: posOrder.total,
        currency: "USD",
        amount: posOrder.total,
      },
    });
    await cancelOrder(posOrder.id, cashier.id, "Test cancel before cash");
    await assert.rejects(
      () => recordCashPayment(pendingPay.id, Number(posOrder.total) + 10, cashier.id),
      /no longer open|expired|already|cancelled/i,
      "recordCashPayment must reject payments on cancelled orders",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. LIVE HTTP MASS-ASSIGNMENT, PARAMETER-TAMPERING & AUTHORIZATION E2E TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("Live HTTP mass-assignment & server-side authorization enforcement", () => {
  it("blocks protected field injection on self-service register, profile, addresses, cart, checkout, and reviews", async () => {
    const cust = await findActiveUserByRole("CUSTOMER");
    const custCookie = await createSessionCookie(cust.id, false);
    const otherCust = await prisma.user.findFirst({
      where: { deletedAt: null, status: "ACTIVE", role: { key: "CUSTOMER" }, id: { not: cust.id } },
      include: { customer: true },
    });
    const med = await prisma.medicine.findFirstOrThrow({
      where: { deletedAt: null, isActive: true, requiresPrescription: false, inventory: { is: { quantity: { gt: 2 } } } },
    });

    // 4a. Register cannot inject role / roleId / permissions / status / isStaff / user_id
    const regTamper = await postJson("/api/auth/register", {
      name: "Attacker",
      email: `attacker.${Date.now()}@example.com`,
      phone: `+85599${String(Date.now()).slice(-7)}`,
      password: "AttackerPassword123",
      role: "SUPER_ADMIN",
      permissions: ["users.manage"],
      isStaff: true,
    });
    assert.equal(regTamper.status, 422, `Register with injected role must return 422, got ${regTamper.status}`);

    // 4b. Profile PATCH cannot modify role, roleId, permissions, user_id, email, status, passwordHash
    const beforeUser = await prisma.user.findUniqueOrThrow({ where: { id: cust.id }, include: { role: true } });
    for (const extra of [
      { role: "SUPER_ADMIN" },
      { roleId: "cm00000000000000000000001" },
      { permissions: ["users.manage", "settings.payments"] },
      { user_id: "cm00000000000000000000001" },
      { userId: "cm00000000000000000000001" },
      { email: "hijacked@example.com" },
      { status: "SUSPENDED" },
      { passwordHash: "$2b$10$forged" },
    ]) {
      const res = await postJson(
        "/api/account/profile",
        { name: beforeUser.name, phone: beforeUser.phone ?? "+85512900001", locale: "en", ...extra },
        { method: "PATCH", cookie: custCookie },
      );
      assert.equal(res.status, 422, `PATCH /api/account/profile must reject ${JSON.stringify(extra)}, got ${res.status}`);
    }
    const afterUser = await prisma.user.findUniqueOrThrow({ where: { id: cust.id }, include: { role: true } });
    assert.equal(afterUser.role.key, "CUSTOMER", "Customer role must remain CUSTOMER");
    assert.equal(afterUser.email, beforeUser.email, "Customer email must remain unchanged");
    assert.equal(afterUser.status, beforeUser.status, "Customer status must remain unchanged");

    // 4c. Address POST/PUT cannot inject customerId / user_id
    const addrTamper = await postJson(
      "/api/account/addresses",
      {
        fullName: "Attacker",
        phone: "+85512900002",
        province: "Phnom Penh",
        district: "Doun Penh",
        customerId: otherCust?.customer?.id ?? "cm00000000000000000000001",
      },
      { cookie: custCookie },
    );
    assert.equal(addrTamper.status, 422, `POST /api/account/addresses with customerId must return 422, got ${addrTamper.status}`);

    // Create legitimate address, then try tampering customerId on PUT
    const legitAddrRes = await postJson(
      "/api/account/addresses",
      { fullName: "Legit Addr", phone: "+85512900003", province: "Phnom Penh", district: "Doun Penh" },
      { cookie: custCookie },
    );
    assert.equal(legitAddrRes.status, 200, `Expected legitimate address creation to succeed, got ${legitAddrRes.status}`);
    const legitAddr = (await legitAddrRes.json()) as { id: string };
    cleanupAddressIds.push(legitAddr.id);

    const putTamper = await postJson(
      `/api/account/addresses/${legitAddr.id}`,
      {
        fullName: "Legit Addr",
        phone: "+85512900003",
        province: "Phnom Penh",
        district: "Doun Penh",
        customerId: otherCust?.customer?.id ?? "cm00000000000000000000001",
      },
      { method: "PUT", cookie: custCookie },
    );
    assert.equal(putTamper.status, 422, `PUT /api/account/addresses/:id with customerId must return 422, got ${putTamper.status}`);

    // 4d. Cart quote & online checkout cannot inject pricing / discount / privileged order fields
    const cartTamper = await postJson("/api/cart/quote", {
      items: [{ medicineId: med.id, quantity: 1 }],
      province: "Phnom Penh",
      manualDiscount: 999,
    });
    assert.equal(cartTamper.status, 422, `POST /api/cart/quote with manualDiscount must return 422, got ${cartTamper.status}`);

    const orderTamper = await postJson(
      "/api/orders",
      {
        items: [{ medicineId: med.id, quantity: 1 }],
        fullName: cust.name,
        phone: "+85512900004",
        province: "Phnom Penh",
        district: "Doun Penh",
        manualDiscount: 999,
        staffCanDispenseRx: true,
        paymentStatus: "PAID",
        total: 0.01,
      },
      { cookie: custCookie },
    );
    assert.equal(orderTamper.status, 422, `POST /api/orders with tampered commerce fields must return 422, got ${orderTamper.status}`);

    // 4e. Review cannot inject customerId / user_id
    const revTamper = await postJson(
      `/api/products/${med.slug}/reviews`,
      { rating: 5, comment: "Nice", customerId: otherCust?.customer?.id ?? "cm000000000000000000001" },
      { cookie: custCookie },
    );
    assert.equal(revTamper.status, 422, `POST /api/products/:slug/reviews with customerId must return 422, got ${revTamper.status}`);
  });

  it("enforces server-side RBAC, privilege boundaries, channel binding, and admin allowlists", async () => {
    const cust = await prisma.user.findFirstOrThrow({
      where: { deletedAt: null, status: "ACTIVE", role: { key: "CUSTOMER" } },
      include: { customer: true, role: true },
      orderBy: { createdAt: "desc" },
    });
    const invStaff = await findActiveUserByRole("INVENTORY_STAFF");
    const cashier = await findActiveUserByRole("CASHIER");
    const pharmacist = await findActiveUserByRole("PHARMACIST");
    const admin = await findActiveUserByRole("ADMIN");
    const superAdmin = await findActiveUserByRole("SUPER_ADMIN");

    const [custCookie, invCookie, cashierCookie, pharmCookie, adminCookie, superCookie] = await Promise.all([
      createSessionCookie(cust.id, false),
      createSessionCookie(invStaff.id, true),
      createSessionCookie(cashier.id, true),
      createSessionCookie(pharmacist.id, true),
      createSessionCookie(admin.id, true),
      createSessionCookie(superAdmin.id, true),
    ]);

    const med = await prisma.medicine.findFirstOrThrow({
      where: { deletedAt: null, isActive: true, requiresPrescription: false, inventory: { is: { quantity: { gt: 4 } } } },
    });
    const cat = await prisma.category.findFirstOrThrow({ where: { deletedAt: null } });
    const khqrMethod = await prisma.paymentMethod.findUniqueOrThrow({ where: { code: "KHQR" } });
    const usdtMethod = await prisma.paymentMethod.findUniqueOrThrow({ where: { code: "USDT" } });

    // Create a customer online order + pending payments for cross-role / BFLA tests
    const onlineOrder = await createOrder(
      {
        channel: "ONLINE",
        items: [{ medicineId: med.id, quantity: 1 }],
        customerId: cust.customer!.id,
        fullName: cust.name,
        phone: "+85512340009",
        province: "Phnom Penh",
        district: "Doun Penh",
      },
      cust.id,
    );
    cleanupOrderIds.push(onlineOrder.id);

    const pendingKhqr = await prisma.payment.create({
      data: {
        reference: `PAY-MA-KHQR-${Date.now()}`,
        orderId: onlineOrder.id,
        methodId: khqrMethod.id,
        status: "PENDING",
        amountUsd: onlineOrder.total,
        currency: "USD",
        amount: onlineOrder.total,
      },
    });
    const pendingUsdt = await prisma.payment.create({
      data: {
        reference: `PAY-MA-USDT-${Date.now()}`,
        orderId: onlineOrder.id,
        methodId: usdtMethod.id,
        status: "PENDING",
        amountUsd: onlineOrder.total,
        currency: "USDT",
        amount: onlineOrder.total,
        network: "TRC20",
      },
    });

    // 1. BFLA fix: INVENTORY_STAFF must get 403 on POST /api/admin/payments/:id/check
    const invCheckPay = await fetch(`${APP}/api/admin/payments/${pendingKhqr.id}/check`, {
      method: "POST",
      headers: { Origin: APP, Cookie: invCookie },
    });
    assert.equal(invCheckPay.status, 403, `INVENTORY_STAFF must get 403 on /api/admin/payments/:id/check, got ${invCheckPay.status}`);

    // 2. Privilege-escalation fix: PHARMACIST (lacks inventory.write) cannot create medicine with initialStock
    const pharmOpeningStock = await postJson(
      "/api/admin/medicines",
      {
        nameEn: "Unauthorized Stock Test",
        nameKm: "តេស្តស្តុក",
        sku: `MA-PHARM-${Date.now()}`,
        categoryId: cat.id,
        price: 5,
        costPrice: 2,
        initialStock: { batchNumber: "B-ESC-1", quantity: 50, expiryDate: "2029-12-31" },
      },
      { cookie: pharmCookie },
    );
    assert.equal(pharmOpeningStock.status, 403, `PHARMACIST with initialStock must get 403, got ${pharmOpeningStock.status}`);

    // 3. PUT /api/admin/medicines/:id rejects non-null initialStock & soldCount tampering
    const medPutStock = await postJson(
      `/api/admin/medicines/${med.id}`,
      {
        nameEn: med.nameEn,
        nameKm: med.nameKm,
        sku: med.sku,
        categoryId: med.categoryId,
        price: Number(med.price),
        costPrice: Number(med.costPrice),
        initialStock: { batchNumber: "B-INJ", quantity: 10 },
      },
      { method: "PUT", cookie: adminCookie },
    );
    assert.equal(medPutStock.status, 422, `PUT /api/admin/medicines/:id with initialStock must return 422, got ${medPutStock.status}`);

    const medPutSold = await postJson(
      `/api/admin/medicines/${med.id}`,
      {
        nameEn: med.nameEn,
        nameKm: med.nameKm,
        sku: med.sku,
        categoryId: med.categoryId,
        price: Number(med.price),
        costPrice: Number(med.costPrice),
        soldCount: 99999,
      },
      { method: "PUT", cookie: adminCookie },
    );
    assert.equal(medPutSold.status, 422, `PUT /api/admin/medicines/:id with soldCount must return 422, got ${medPutSold.status}`);

    // 4. CASHIER cannot initiate payment or submit USDT hash on a customer's online order
    const cashierOnlinePay = await postJson(
      `/api/orders/${onlineOrder.id}/pay`,
      { method: "KHQR", currency: "USD" },
      { cookie: cashierCookie },
    );
    assert.equal(cashierOnlinePay.status, 403, `CASHIER must get 403 on POST /api/orders/:id/pay, got ${cashierOnlinePay.status}`);

    const cashierUsdtHash = await postJson(
      `/api/payments/${pendingUsdt.id}/usdt-hash`,
      { txHash: "a".repeat(64) },
      { cookie: cashierCookie },
    );
    assert.equal(cashierUsdtHash.status, 403, `CASHIER must get 403 on online payment usdt-hash, got ${cashierUsdtHash.status}`);

    // 5. Customer cannot cancel a POS order linked to their account via /api/orders/:id/cancel
    const posLinkedOrder = await createOrder(
      {
        channel: "POS",
        items: [{ medicineId: med.id, quantity: 1 }],
        cashierId: cashier.id,
        customerId: cust.customer!.id,
        fullName: cust.name,
        phone: "+85512340009",
        staffCanDispenseRx: false,
      },
      cashier.id,
    );
    cleanupOrderIds.push(posLinkedOrder.id);

    const custCancelPos = await fetch(`${APP}/api/orders/${posLinkedOrder.id}/cancel`, {
      method: "POST",
      headers: { Origin: APP, Cookie: custCookie },
    });
    assert.ok([403, 409].includes(custCancelPos.status), `Customer cancelling linked POS order must get 403/409, got ${custCancelPos.status}`);
    const posStillOpen = await prisma.order.findUniqueOrThrow({ where: { id: posLinkedOrder.id }, select: { status: true } });
    assert.equal(posStillOpen.status, "PENDING", "POS order must NOT be cancelled via online cancel endpoint");

    // 6. CASHIER cannot apply manualDiscount on POS sale
    const cashierManualDisc = await postJson(
      "/api/admin/pos/sale",
      { items: [{ medicineId: med.id, quantity: 1 }], method: "CASH", manualDiscount: 1 },
      { cookie: cashierCookie },
    );
    assert.equal(cashierManualDisc.status, 403, `CASHIER applying manualDiscount must get 403, got ${cashierManualDisc.status}`);

    // 7. ADMIN cannot touch /api/admin/staff (lacks users.manage) & cannot tamper protected fields on /api/admin/customers/:id
    const adminCreateStaff = await postJson(
      "/api/admin/staff",
      { name: "Sneaky", email: `sneaky.${Date.now()}@example.com`, role: "SUPER_ADMIN", password: "StrongPassword123" },
      { cookie: adminCookie },
    );
    assert.equal(adminCreateStaff.status, 403, `ADMIN calling POST /api/admin/staff must get 403, got ${adminCreateStaff.status}`);

    const adminPatchCustRole = await postJson(
      `/api/admin/customers/${cust.customer!.id}`,
      { role: "SUPER_ADMIN", name: cust.name },
      { method: "PATCH", cookie: adminCookie },
    );
    assert.equal(adminPatchCustRole.status, 422, `PATCH /api/admin/customers/:id with role must return 422, got ${adminPatchCustRole.status}`);

    // 8. SUPER_ADMIN cannot inject protected fields (usedCount, deletedAt, permissions, employeeCode) on admin endpoints
    const staffBadCreate = await postJson(
      "/api/admin/staff",
      {
        name: "Bad Staff",
        email: `badstaff.${Date.now()}@example.com`,
        role: "CASHIER",
        password: "StrongPassword123",
        status: "SUSPENDED",
      },
      { cookie: superCookie },
    );
    assert.equal(staffBadCreate.status, 422, `POST /api/admin/staff with status=SUSPENDED must return 422, got ${staffBadCreate.status}`);

    const discTamper = await postJson(
      "/api/admin/discounts",
      { code: `MA${Date.now().toString(36).toUpperCase()}`, type: "PERCENTAGE", value: 10, usedCount: 5 },
      { cookie: superCookie },
    );
    assert.equal(discTamper.status, 422, `POST /api/admin/discounts with usedCount must return 422, got ${discTamper.status}`);

    const settingsTamper = await postJson(
      "/api/admin/settings/store",
      { storeNameEn: "Pamarcy Store", storeNameKm: "ឱសថស្ថាន", role: "SUPER_ADMIN" },
      { method: "PUT", cookie: superCookie },
    );
    assert.equal(settingsTamper.status, 422, `PUT /api/admin/settings/store with unknown key must return 422, got ${settingsTamper.status}`);
  });
});
