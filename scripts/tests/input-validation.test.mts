import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { z } from "zod";
import {
  assertSafeJsonStructure,
  parseBody,
  parseParams,
  parseQuery,
  readBodyTextWithLimit,
} from "../../src/lib/api.ts";
import { ApiError } from "../../src/lib/errors.ts";
import {
  addressSchema,
  adjustSchema,
  adminAuditQuerySchema,
  adminBatchesQuerySchema,
  adminCustomersQuerySchema,
  adminInventoryQuerySchema,
  adminMedicinesQuerySchema,
  adminMovementsQuerySchema,
  adminOrdersQuerySchema,
  adminPaymentsQuerySchema,
  adminPurchasesQuerySchema,
  adminReportParamSchema,
  adminReportQuerySchema,
  adminSuppliersQuerySchema,
  bannerSchema,
  brandSchema,
  cartQuoteSchema,
  cashPaymentSchema,
  categorySchema,
  changePasswordSchema,
  checkoutSchema,
  customerOrdersQuerySchema,
  customerUpdateSchema,
  discountSchema,
  fulfilSchema,
  idParamSchema,
  isSafeAppLink,
  isSafeImageUrl,
  isSafeSocialValue,
  loginRequestSchema,
  logoutSchema,
  medicineSchema,
  notificationsReadSchema,
  onlineInitiatePaymentSchema,
  orderRefundSchema,
  orderStatusSchema,
  orderTokenQuerySchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  paymentSettingsSchema,
  paypalWebhookEventSchema,
  posCancelSchema,
  posLookupQuerySchema,
  posSaleSchema,
  prescriptionFileQuerySchema,
  prescriptionReviewSchema,
  productsQuerySchema,
  profileSchema,
  purchaseSchema,
  receiveSchema,
  registerSchema,
  reviewSchema,
  slugOnlyParamSchema,
  staffSchema,
  stockInSchema,
  storeSettingsSchema,
  supplierSchema,
  usdtHashSchema,
  wishlistToggleSchema,
} from "../../src/lib/validators.ts";

const ROOT = path.resolve(".");

function collectRouteFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) collectRouteFiles(full, acc);
    else if (entry === "route.ts") acc.push(full);
  }
  return acc;
}

describe("Static API endpoint validation coverage audit", () => {
  const routes = collectRouteFiles(path.join(ROOT, "src/app/api")).sort();

  it("validates path parameters on every dynamic API route", () => {
    const missing: string[] = [];
    for (const file of routes) {
      if (!file.includes("[")) continue;
      const content = readFileSync(file, "utf8");
      const validated =
        content.includes("parseParams(") ||
        content.includes("SAFE_NAME_RE") ||
        content.includes("readStoredPublicImage(");
      if (!validated) missing.push(path.relative(ROOT, file));
    }
    assert.deepEqual(missing, [], `Dynamic routes missing param validation: ${missing.join(", ")}`);
  });

  it("never reads raw unbounded request bodies via req.json() or req.text()", () => {
    const offenders: string[] = [];
    for (const file of routes) {
      const content = readFileSync(file, "utf8");
      if (/\breq\.(?:json|text)\s*\(/.test(content)) offenders.push(path.relative(ROOT, file));
    }
    assert.deepEqual(offenders, [], `Routes bypassing bounded body parsing: ${offenders.join(", ")}`);
  });

  it("never accesses raw req.nextUrl.searchParams without parseQuery", () => {
    const offenders: string[] = [];
    for (const file of routes) {
      const content = readFileSync(file, "utf8");
      if (content.includes("searchParams") && !content.includes("parseQuery(")) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    assert.deepEqual(offenders, [], `Routes reading raw searchParams: ${offenders.join(", ")}`);
  });
});

describe("Core request parser hardening (parseBody, parseQuery, parseParams)", () => {
  const simpleSchema = z.object({ name: z.string().min(1) }).strict();

  it("rejects non-JSON Content-Type with 415", async () => {
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ name: "ok" }),
    });
    await assert.rejects(
      () => parseBody(req, simpleSchema),
      (err: unknown) => err instanceof ApiError && err.status === 415,
    );
  });

  it("rejects malformed JSON and empty bodies cleanly with 400", async () => {
    const bad = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    await assert.rejects(
      () => parseBody(bad, simpleSchema),
      (err: unknown) => err instanceof ApiError && err.status === 400,
    );

    const empty = new Request("http://localhost/api/test", { method: "POST" });
    await assert.rejects(
      () => parseBody(empty, simpleSchema),
      (err: unknown) => err instanceof ApiError && err.status === 400,
    );

    const emptyAllowed = new Request("http://localhost/api/test", { method: "POST" });
    assert.deepEqual(await parseBody(emptyAllowed, logoutSchema, { allowEmpty: true }), { all: false });
  });

  it("enforces request body size limits via Content-Length and streaming chunks (413)", async () => {
    const hugeHeader = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "999999" },
      body: "{}",
    });
    await assert.rejects(
      () => readBodyTextWithLimit(hugeHeader, 1024),
      (err: unknown) => err instanceof ApiError && err.status === 413,
    );

    const chunked = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "a".repeat(2048) }),
    });
    await assert.rejects(
      () => parseBody(chunked, simpleSchema, { maxBytes: 1024 }),
      (err: unknown) => err instanceof ApiError && err.status === 413,
    );
  });

  it("blocks prototype pollution keys, null bytes, and excessive nesting depth", async () => {
    const protoReq = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"name":"ok","__proto__":{"polluted":true}}',
    });
    await assert.rejects(
      () => parseBody(protoReq, simpleSchema),
      (err: unknown) => err instanceof ApiError && err.status === 400 && /Unexpected object key/i.test(err.message),
    );

    const nulReq = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"name":"abc\\u0000def"}',
    });
    await assert.rejects(
      () => parseBody(nulReq, simpleSchema),
      (err: unknown) => err instanceof ApiError && err.status === 400 && /Null bytes/i.test(err.message),
    );

    let deep: Record<string, unknown> = { a: 1 };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    assert.throws(
      () => assertSafeJsonStructure(deep),
      (err: unknown) => err instanceof ApiError && err.status === 400 && /deeply nested/i.test(err.message),
    );
  });

  it("blocks duplicate query params, oversized queries, control chars, and unexpected params", () => {
    const dupReq = new NextRequest("http://localhost/api/products?page=1&page=2");
    assert.throws(
      () => parseQuery(dupReq, productsQuerySchema),
      (err: unknown) => err instanceof ApiError && err.status === 400 && /Duplicate query/i.test(err.message),
    );

    const longReq = new NextRequest(`http://localhost/api/products?q=${"a".repeat(2100)}`);
    assert.throws(
      () => parseQuery(longReq, productsQuerySchema),
      (err: unknown) => err instanceof ApiError && err.status === 400 && /too long/i.test(err.message),
    );

    const ctrlReq = new NextRequest("http://localhost/api/products?q=abc%0d%0aSet-Cookie:x=1");
    assert.throws(
      () => parseQuery(ctrlReq, productsQuerySchema),
      (err: unknown) => err instanceof ApiError && err.status === 400 && /Invalid characters/i.test(err.message),
    );

    const extraReq = new NextRequest("http://localhost/api/products?evil=1");
    assert.throws(() => parseQuery(extraReq, productsQuerySchema));
  });

  it("rejects malformed route params (path traversal, control chars, oversized IDs)", async () => {
    await assert.rejects(() => parseParams({ id: "../etc/passwd" }, idParamSchema));
    await assert.rejects(() => parseParams({ id: "a".repeat(65) }, idParamSchema));
    await assert.rejects(() => parseParams({ id: "abc\x00def" }, idParamSchema));
    await assert.rejects(() => parseParams({ slug: "bad slug/with/slash" }, slugOnlyParamSchema));
    assert.deepEqual(await parseParams({ id: "cm123_abc-45" }, idParamSchema), { id: "cm123_abc-45" });
    assert.deepEqual(await parseParams({ slug: "paracetamol-500mg" }, slugOnlyParamSchema), { slug: "paracetamol-500mg" });
  });
});

describe("Auth, account & geography schema allowlists", () => {
  it("enforces strict auth schemas and rejects mass-assignment fields and control chars", () => {
    assert.equal(
      registerSchema.safeParse({
        name: "Sokha",
        email: "sokha@example.com",
        phone: "012 345 678",
        password: "Password1",
        role: "SUPER_ADMIN",
      }).success,
      false,
    );
    assert.equal(
      registerSchema.safeParse({
        name: "Sokha\r\nBcc: evil@attacker.com",
        email: "sokha@example.com",
        phone: "012 345 678",
        password: "Password1",
      }).success,
      false,
    );
    assert.equal(
      registerSchema.safeParse({
        name: "Sokha",
        email: `${"a".repeat(250)}@example.com`,
        phone: "012 345 678",
        password: "Password1",
      }).success,
      false,
    );
    assert.equal(
      changePasswordSchema.safeParse({ currentPassword: "x".repeat(129), newPassword: "Password1" }).success,
      false,
    );
    assert.equal(loginRequestSchema.safeParse({ identifier: "a@b.com", password: "1", scope: "root" }).success, false);
    assert.equal(passwordResetRequestSchema.safeParse({ identifier: "a@b.com", extra: 1 }).success, false);
    assert.equal(passwordResetConfirmSchema.safeParse({ token: "bad token with spaces!", newPassword: "Password1" }).success, false);
    assert.equal(profileSchema.safeParse({ name: "Sokha", phone: "012345678", email: "hijack@evil.com" }).success, false);
    assert.equal(notificationsReadSchema.safeParse({ ids: ["../bad"] }).success, false);
    assert.equal(notificationsReadSchema.safeParse({ ids: [] }).success, false);
    assert.equal(wishlistToggleSchema.safeParse({ medicineId: "bad id!" }).success, false);
  });

  it("enforces Cambodia province & district allowlists and normalizes Khmer/code provinces", () => {
    const valid = addressSchema.safeParse({
      fullName: "Sokha Chea",
      phone: "012 345 678",
      province: "ភ្នំពេញ",
      district: "Doun Penh",
    });
    assert.equal(valid.success, true);
    if (valid.success) assert.equal(valid.data.province, "Phnom Penh");

    // Fake province rejected
    assert.equal(
      addressSchema.safeParse({
        fullName: "Sokha Chea",
        phone: "012 345 678",
        province: "Atlantis",
        district: "Doun Penh",
      }).success,
      false,
    );

    // Mismatched district (Siem Reap district under Phnom Penh) rejected
    assert.equal(
      addressSchema.safeParse({
        fullName: "Sokha Chea",
        phone: "012 345 678",
        province: "Phnom Penh",
        district: "Siem Reap",
      }).success,
      false,
    );

    // Extra DB metadata fields rejected
    assert.equal(
      addressSchema.safeParse({
        id: "addr_1",
        fullName: "Sokha Chea",
        phone: "012 345 678",
        province: "Phnom Penh",
        district: "Doun Penh",
      }).success,
      false,
    );

    // Supplier rejects district without province
    assert.equal(supplierSchema.safeParse({ name: "Pharma Co", district: "Doun Penh" }).success, false);
  });
});

describe("URL, image, link, prescription & numeric type allowlists", () => {
  it("blocks XSS / SSRF / traversal URLs in images, banner links, prescriptions, and social fields", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:image/svg+xml,<svg onload=alert(1)>",
      "http://res.cloudinary.com/demo/a.jpg",
      "https://evil.example.com/pic.jpg",
      "/images/../secret.jpg",
      "//evil.example.com/pic.jpg",
      "/uploads/legacy/a.jpg",
    ]) {
      assert.equal(isSafeImageUrl(bad), false, `Should reject image URL: ${bad}`);
    }
    assert.equal(isSafeImageUrl("/images/products/paracetamol-500.jpg"), true);
    assert.equal(isSafeImageUrl("/api/files/uploads/products/550e8400-e29b-41d4-a716-446655440000.jpg"), true);
    assert.equal(isSafeImageUrl("https://res.cloudinary.com/demo/image/upload/v1/a.jpg"), true);

    for (const badLink of ["javascript:alert(1)", "//evil.com", "/shop/../../admin", "http://evil.com"]) {
      assert.equal(isSafeAppLink(badLink), false, `Should reject app link: ${badLink}`);
    }
    assert.equal(isSafeAppLink("/shop?category=vitamins"), true);

    for (const badSocial of ["javascript:alert(1)", "https://evil.com/phish", "http://t.me/shop"]) {
      assert.equal(isSafeSocialValue(badSocial), false, `Should reject social value: ${badSocial}`);
    }
    assert.equal(isSafeSocialValue("@pamarcy_kh"), true);
    assert.equal(isSafeSocialValue("https://t.me/pamarcy_kh"), true);
    assert.equal(isSafeSocialValue("https://facebook.com/pamarcystore"), true);

    assert.equal(
      bannerSchema.safeParse({
        titleEn: "Promo",
        titleKm: "ប្រូម៉ូសិន",
        imageUrl: "javascript:alert(1)",
        link: "//evil.com",
      }).success,
      false,
    );

    // Unsigned or external prescription URL rejected on checkout
    assert.equal(
      checkoutSchema.safeParse({
        items: [{ medicineId: "med1", quantity: 1 }],
        fullName: "Sokha",
        phone: "012345678",
        province: "Phnom Penh",
        district: "Doun Penh",
        prescriptionUrl: "/api/files/prescriptions/unsigned.jpg",
      }).success,
      false,
    );
  });

  it("blocks boolean/empty/Infinity numeric coercion bugs across schemas", () => {
    assert.equal(reviewSchema.safeParse({ rating: true }).success, false);
    assert.equal(reviewSchema.safeParse({ rating: "" }).success, false);
    assert.equal(reviewSchema.safeParse({ rating: 3.5 }).success, false);
    assert.equal(reviewSchema.safeParse({ rating: 5, comment: "Great!" }).success, true);

    assert.equal(cashPaymentSchema.safeParse({ tendered: true }).success, false);
    assert.equal(cashPaymentSchema.safeParse({ tendered: "" }).success, false);
    assert.equal(cashPaymentSchema.safeParse({ tendered: Number.POSITIVE_INFINITY }).success, false);
    assert.equal(cashPaymentSchema.safeParse({ tendered: 25.5 }).success, true);

    assert.equal(
      medicineSchema.safeParse({
        nameEn: "Paracetamol",
        nameKm: "ប៉ារ៉ា",
        sku: "PARA-1",
        categoryId: "cat1",
        price: 5,
        costPrice: 2,
        compareAtPrice: Number.POSITIVE_INFINITY,
      }).success,
      false,
    );

    assert.equal(
      discountSchema.safeParse({
        code: "SAVE10",
        type: "FIXED",
        value: 1e12,
      }).success,
      false,
    );
    assert.equal(
      discountSchema.safeParse({
        code: "SAVE10",
        type: "PERCENTAGE",
        value: 101,
      }).success,
      false,
    );
    assert.equal(
      discountSchema.safeParse({
        code: "SAVE10",
        type: "PERCENTAGE",
        value: 10,
        startsAt: "2026-12-10",
        endsAt: "2026-12-01",
      }).success,
      false,
    );
  });

  it("validates cart quantities, payment method cross-fields, USDT hashes, and admin mutations", () => {
    // Duplicate cart lines exceeding 999 merged units rejected
    assert.equal(
      cartQuoteSchema.safeParse({
        items: [
          { medicineId: "m1", quantity: 600 },
          { medicineId: "m1", quantity: 500 },
        ],
      }).success,
      false,
    );

    // Online payment initiation blocks CASH and enforces network/currency combinations
    assert.equal(onlineInitiatePaymentSchema.safeParse({ method: "CASH" }).success, false);
    assert.equal(onlineInitiatePaymentSchema.safeParse({ method: "USDT" }).success, false);
    assert.equal(onlineInitiatePaymentSchema.safeParse({ method: "KHQR", network: "TRC20" }).success, false);
    assert.equal(onlineInitiatePaymentSchema.safeParse({ method: "PAYPAL", currency: "KHR" }).success, false);
    assert.equal(onlineInitiatePaymentSchema.safeParse({ method: "USDT", network: "TRC20" }).success, true);

    // USDT tx hash must be 64 hex chars (optional 0x)
    assert.equal(usdtHashSchema.safeParse({ txHash: "not-a-valid-hash-12345" }).success, false);
    assert.equal(usdtHashSchema.safeParse({ txHash: "a".repeat(64) }).success, true);
    assert.equal(usdtHashSchema.safeParse({ txHash: `0x${"f".repeat(64)}` }).success, true);

    // Stock adjustment: mode="out" requires qty >= 1
    assert.equal(adjustSchema.safeParse({ mode: "out", quantity: 0, reason: "Damaged" }).success, false);
    assert.equal(adjustSchema.safeParse({ mode: "set", quantity: 0, reason: "Zeroed" }).success, true);

    // Stock-in rejects manufactureDate > expiryDate
    assert.equal(
      stockInSchema.safeParse({
        medicineId: "m1",
        batchNumber: "B-001",
        quantity: 10,
        costPrice: 1.5,
        manufactureDate: "2027-01-01",
        expiryDate: "2026-01-01",
      }).success,
      false,
    );

    // Fulfil rejects empty record and malformed keys
    assert.equal(fulfilSchema.safeParse({ quantities: {} }).success, false);
    assert.equal(fulfilSchema.safeParse({ quantities: { "../bad": 1 } }).success, false);
    assert.equal(fulfilSchema.safeParse({ quantities: { item_1: 2 } }).success, true);

    // Customer PATCH preserves undefined notes when omitted
    const patch = customerUpdateSchema.parse({ status: "SUSPENDED" });
    assert.equal(patch.notes, undefined);

    // Purchase rejects duplicate medicines
    assert.equal(
      purchaseSchema.safeParse({
        supplierId: "sup1",
        items: [
          { medicineId: "m1", quantity: 5, unitCost: 1 },
          { medicineId: "m1", quantity: 3, unitCost: 1 },
        ],
      }).success,
      false,
    );

    // Receive rejects manufactureDate > expiryDate
    assert.equal(
      receiveSchema.safeParse({
        items: [
          {
            purchaseItemId: "pi1",
            quantity: 5,
            batchNumber: "B1",
            manufactureDate: "2028-01-01",
            expiryDate: "2027-01-01",
          },
        ],
      }).success,
      false,
    );

    // Payment settings reject duplicate KHQR currencies or duplicate USDT networks
    assert.equal(
      paymentSettingsSchema.safeParse({
        KHQR: {
          enabled: true,
          online: true,
          pos: true,
          config: { merchantName: "Pamarcy", merchantCity: "Phnom Penh", merchantType: "individual", currencies: ["USD", "USD"], expiryMinutes: 15 },
        },
        USDT: { enabled: false, online: false, pos: false, config: { expiryMinutes: 60, networks: [] } },
        PAYPAL: { enabled: false, online: false, pos: false, config: { brandName: "Pamarcy" } },
        CASH: { enabled: true, online: false, pos: true, config: {} },
      }).success,
      false,
    );

    // Store settings reject invalid social URL and non-KH phone
    assert.equal(
      storeSettingsSchema.safeParse({
        storeNameEn: "Pamarcy",
        storeNameKm: "ផាម៉ាស៊ី",
        phone: "+15551234567",
        email: "hello@pamarcy.com.kh",
        addressEn: "Phnom Penh",
        addressKm: "ភ្នំពេញ",
        openingHours: "07:00-21:00",
        licenseNo: "LIC-1",
        exchangeRate: 4100,
        deliveryFeePhnomPenh: 1.5,
        deliveryFeeProvince: 3,
        freeDeliveryThreshold: 30,
        reservationMinutes: 30,
        lowStockDefault: 10,
        emailNotifications: false,
        notificationEmail: "",
        facebook: "",
        telegram: "",
      }).success,
      false,
    );

    // Misc schemas sanity
    assert.equal(brandSchema.safeParse({ name: "GSK", extra: true }).success, false);
    assert.equal(categorySchema.safeParse({ nameEn: "Pain", nameKm: "ឈឺ", slug: "INVALID SLUG" }).success, false);
    assert.equal(orderStatusSchema.safeParse({ status: "PENDING" }).success, false);
    assert.equal(prescriptionReviewSchema.safeParse({ approve: "yes" }).success, false);
    assert.equal(orderRefundSchema.safeParse({ reason: "ok", paymentId: "../bad" }).success, false);
    assert.equal(posCancelSchema.safeParse({ orderId: "" }).success, false);
    assert.equal(posSaleSchema.safeParse({ items: [{ medicineId: "m1", quantity: 1 }], method: "USDT" }).success, false);
    assert.equal(staffSchema.safeParse({ name: "A", email: "a@b.com", role: "CUSTOMER" }).success, false);
    assert.equal(paypalWebhookEventSchema.safeParse({ event_type: "bad event!", resource: {} }).success, false);
  });

  it("enforces allowlists, bounds, and date ranges on all query schemas", () => {
    assert.equal(productsQuerySchema.safeParse({ minPrice: "20", maxPrice: "10" }).success, false);
    assert.equal(productsQuerySchema.safeParse({ page: "1.5" }).success, false);
    assert.equal(productsQuerySchema.safeParse({ page: "99999" }).success, false);
    assert.equal(productsQuerySchema.safeParse({ pageSize: "100" }).success, false);
    assert.equal(productsQuerySchema.safeParse({ brand: Array.from({ length: 21 }, (_, i) => `b${i}`).join(",") }).success, false);
    assert.equal(productsQuerySchema.safeParse({ q: "para", minPrice: "", sort: "popular", page: "1" }).success, true);

    assert.equal(adminAuditQuerySchema.safeParse({ entity: "UnknownEntity" }).success, false);
    assert.equal(adminAuditQuerySchema.safeParse({ entity: "Upload" }).success, true);
    assert.equal(adminCustomersQuerySchema.safeParse({ status: "DELETED" }).success, false);
    assert.equal(adminInventoryQuerySchema.safeParse({ filter: "broken" }).success, false);
    assert.equal(adminBatchesQuerySchema.safeParse({ medicineId: "../bad" }).success, false);
    assert.equal(adminMovementsQuerySchema.safeParse({ type: "FAKE" }).success, false);
    assert.equal(adminMedicinesQuerySchema.safeParse({ category: "../bad" }).success, false);
    assert.equal(adminOrdersQuerySchema.safeParse({ from: "2026-12-10", to: "2026-12-01" }).success, false);
    assert.equal(adminPaymentsQuerySchema.safeParse({ from: "2026-12-10", to: "2026-12-01" }).success, false);
    assert.equal(adminPurchasesQuerySchema.safeParse({ status: "UNKNOWN" }).success, false);
    assert.equal(adminSuppliersQuerySchema.safeParse({ q: "x".repeat(101) }).success, false);
    assert.equal(posLookupQuerySchema.safeParse({ q: "" }).success, false);
    assert.equal(customerOrdersQuerySchema.safeParse({ page: "0" }).success, false);
    assert.equal(orderTokenQuerySchema.safeParse({ token: "short" }).success, false);
    assert.equal(prescriptionFileQuerySchema.safeParse({ orderId: "../bad" }).success, false);

    // Report date range DoS guard (> 1830 days for daily reports rejected; inverted range rejected)
    assert.equal(adminReportParamSchema.safeParse({ type: "secrets" }).success, false);
    assert.equal(adminReportQuerySchema.safeParse({ from: "2000-01-01", to: "2026-01-01", g: "day" }).success, false);
    assert.equal(adminReportQuerySchema.safeParse({ from: "2026-11-25", to: "2026-11-01", g: "day" }).success, false);
    assert.equal(adminReportQuerySchema.safeParse({ from: "2026-11-01", to: "2026-11-25", g: "day", format: "csv" }).success, true);
  });
});

describe("Live HTTP input-validation enforcement (when server is running)", () => {
  const APP = process.env.APP_URL || "http://localhost:3000";

  async function serverReachable(): Promise<boolean> {
    try {
      const r = await fetch(`${APP}/api/categories`, { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch {
      return false;
    }
  }

  it("rejects malformed bodies, wrong Content-Type, oversized payloads, HPP, bad params, and unallowlisted fields over HTTP", async (t) => {
    if (!(await serverReachable())) {
      t.skip(`No live server listening at ${APP}`);
      return;
    }

    // 1. Query validation: inverted price range, duplicate param (HPP), unknown param, bad slug
    assert.equal((await fetch(`${APP}/api/products?minPrice=50&maxPrice=10`)).status, 422);
    assert.equal((await fetch(`${APP}/api/products?page=1&page=2`)).status, 400);
    assert.equal((await fetch(`${APP}/api/products?unexpected=1`)).status, 422);
    assert.equal((await fetch(`${APP}/api/products/bad%20slug!`)).status, 422);

    // 2. Body Content-Type (415), invalid JSON (400), prototype pollution (400), oversized body (413)
    const ctRes = await fetch(`${APP}/api/cart/quote`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: APP },
      body: JSON.stringify({ items: [{ medicineId: "m1", quantity: 1 }] }),
    });
    assert.equal(ctRes.status, 415);

    const badJsonRes = await fetch(`${APP}/api/cart/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: APP },
      body: "{bad-json",
    });
    assert.equal(badJsonRes.status, 400);

    const protoRes = await fetch(`${APP}/api/cart/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: APP },
      body: '{"items":[{"medicineId":"m1","quantity":1}],"__proto__":{"polluted":true}}',
    });
    assert.equal(protoRes.status, 400);

    const hugeRes = await fetch(`${APP}/api/cart/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: APP },
      body: JSON.stringify({ items: [{ medicineId: "m1", quantity: 1 }], discountCode: "A".repeat(200_000) }),
    });
    assert.equal(hugeRes.status, 413);

    // 3. Strict schema rejection: unexpected key & fake Cambodia province (422)
    const extraKeyRes = await fetch(`${APP}/api/cart/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: APP },
      body: JSON.stringify({ items: [{ medicineId: "m1", quantity: 1 }], isAdmin: true }),
    });
    assert.equal(extraKeyRes.status, 422);

    const badProvRes = await fetch(`${APP}/api/cart/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: APP },
      body: JSON.stringify({ items: [{ medicineId: "m1", quantity: 1 }], province: "Atlantis" }),
    });
    assert.equal(badProvRes.status, 422);

    // 4. PayPal webhook rejects non-JSON Content-Type (415) and missing signature headers (401)
    const whCt = await fetch(`${APP}/api/webhooks/paypal`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });
    assert.equal(whCt.status, 415);

    const whNoSig = await fetch(`${APP}/api/webhooks/paypal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_type: "PAYMENT.CAPTURE.COMPLETED", resource: {} }),
    });
    assert.equal(whNoSig.status, 401);

    // 5. Shop SSR page safely ignores malformed page / min / max / unknown query params (200)
    const shopRes = await fetch(`${APP}/shop?page=999999999&min=Infinity&max=-50&sort=DROP_TABLE&evil=1`);
    assert.equal(shopRes.status, 200);
    const html = await shopRes.text();
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    assert.equal(hrefs.some((h) => h.includes("evil=1") || h.includes("DROP_TABLE")), false);
  });
});
