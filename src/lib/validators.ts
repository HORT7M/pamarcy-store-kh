import { z } from "zod";
import { OrderStatus, PaymentMethodCode, PaymentStatus, PurchaseStatus, StockMovementType } from "@prisma/client";
import { normalizeKhPhone } from "./phone";
import { isValidIsoDate, parseDateInput } from "./date";
import { findProvince } from "./cambodia";

// ───────────────────── Safe String & Number Primitives ─────────────────────

/** Single-line text: forbids NUL, CR, LF, TAB and all ASCII control characters. */
const NO_CONTROL_SINGLE_LINE = /^[^\x00-\x1f\x7f]*$/;
/** Multiline text: allows TAB/LF/CR for descriptions & notes, forbids NUL and other control chars. */
const NO_CONTROL_MULTILINE = /^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$/;
const NUMERIC_STRING_RE = /^-?\d+(?:\.\d+)?$/;
const POSITIVE_INT_QUERY_RE = /^\d{1,7}$/;
const NON_NEG_DECIMAL_QUERY_RE = /^\d{1,7}(?:\.\d{1,2})?$/;

const trimmed = (max = 200) =>
  z.string().trim().max(max).regex(NO_CONTROL_SINGLE_LINE, "Contains invalid control characters");

const trimmedMultiline = (max = 2000) =>
  z.string().trim().max(max).regex(NO_CONTROL_MULTILINE, "Contains invalid control characters");

const optStr = (max = 500) =>
  z
    .string()
    .trim()
    .max(max)
    .regex(NO_CONTROL_SINGLE_LINE, "Contains invalid control characters")
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

const optMultiline = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max)
    .regex(NO_CONTROL_MULTILINE, "Contains invalid control characters")
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

/**
 * Strict finite numeric parser: accepts JS finite numbers or canonical decimal strings.
 * Explicitly rejects booleans, empty strings, NaN, Infinity, objects, and arrays.
 */
function preprocessStrictNumber(v: unknown): unknown {
  if (typeof v === "number") return Number.isFinite(v) ? v : Number.NaN;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t || t.length > 24 || !NUMERIC_STRING_RE.test(t)) return Number.NaN;
    const n = Number(t);
    return Number.isFinite(n) ? n : Number.NaN;
  }
  return v;
}

const strictNumber = (schema: z.ZodNumber) => z.preprocess(preprocessStrictNumber, schema);

const optNullableNumber = (schema: z.ZodNumber) =>
  z.preprocess(
    (v) => (v === null || v === undefined || (typeof v === "string" && v.trim() === "") ? null : preprocessStrictNumber(v)),
    schema.nullable(),
  );

const optNumber = (schema: z.ZodNumber) =>
  z.preprocess(
    (v) => (v === undefined || (typeof v === "string" && v.trim() === "") ? undefined : preprocessStrictNumber(v)),
    schema.optional(),
  );

const money = strictNumber(z.number({ message: "Must be a valid number" }).min(0, "Must be ≥ 0").max(1_000_000, "Amount exceeds maximum allowed"));
const optNullableMoney = optNullableNumber(z.number({ message: "Must be a valid number" }).min(0, "Must be ≥ 0").max(1_000_000, "Amount exceeds maximum allowed"));

const safeInt = (min: number, max: number, msg?: string) =>
  strictNumber(z.number({ message: msg ?? "Must be a whole number" }).int(msg ?? "Must be a whole number").min(min, msg).max(max, msg));

const optNullableInt = (min: number, max: number) =>
  optNullableNumber(z.number({ message: "Must be a whole number" }).int("Must be a whole number").min(min).max(max));

/** Strict query-string integer (rejects floats, negative signs, exponents, non-digits). */
export const queryInt = (min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(POSITIVE_INT_QUERY_RE, "Must be a positive whole number")
    .transform((v) => Number(v))
    .refine((n) => Number.isSafeInteger(n) && n >= min && n <= max, `Must be between ${min} and ${max}`);

/** Strict query-string non-negative decimal amount (up to 2 decimal places). */
export const queryMoney = (min = 0, max = 1_000_000) =>
  z
    .string()
    .trim()
    .regex(NON_NEG_DECIMAL_QUERY_RE, "Must be a valid non-negative amount")
    .transform((v) => Number(v))
    .refine((n) => Number.isFinite(n) && n >= min && n <= max, `Must be between ${min} and ${max}`);

export const optionalQuery = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), schema.optional());

// ───────────────────── Identifiers, Slugs, Tokens ─────────────────────

export const ENTITY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const SLUG_PARAM_RE = /^[A-Za-z0-9_-]{1,120}$/;
export const CATEGORY_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ORDER_ACCESS_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
export const BATCH_NUMBER_RE = /^[A-Za-z0-9\-_./ ]{1,50}$/;
export const BARCODE_RE = /^[A-Za-z0-9\-_. ]{1,50}$/;
export const DISCOUNT_CODE_RE = /^[A-Za-z0-9_-]{3,40}$/;

export const entityIdSchema = z
  .string()
  .trim()
  .min(1, "ID is required")
  .max(64, "Invalid ID")
  .regex(ENTITY_ID_RE, "Invalid ID format");

const optEntityId = optStr(64).refine((v) => v === null || ENTITY_ID_RE.test(v), "Invalid ID format");

export const idParamSchema = z.object({ id: entityIdSchema }).strict();

export const slugParamSchema = z
  .string()
  .trim()
  .min(1, "Slug is required")
  .max(120, "Invalid slug")
  .regex(SLUG_PARAM_RE, "Invalid slug format");

export const slugOnlyParamSchema = z.object({ slug: slugParamSchema }).strict();

export const categorySlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(CATEGORY_SLUG_RE, "Lowercase letters, numbers and dashes only");

export const orderAccessTokenSchema = z
  .string()
  .trim()
  .regex(ORDER_ACCESS_TOKEN_RE, "Invalid access token");

export const orderTokenQuerySchema = z
  .object({ token: optionalQuery(orderAccessTokenSchema) })
  .strict();

export const paginationQueryFields = {
  page: optionalQuery(queryInt(1, 10_000)),
  pageSize: optionalQuery(queryInt(1, 100)),
};

// ───────────────────── URL, Image, Link & Social Allowlists ─────────────────────

const ALLOWED_REMOTE_IMAGE_HOSTS = new Set(["res.cloudinary.com", "upload.wikimedia.org"]);
const ALLOWED_SOCIAL_HOSTS = new Set([
  "facebook.com",
  "www.facebook.com",
  "m.facebook.com",
  "fb.com",
  "www.fb.com",
  "t.me",
  "telegram.me",
  "web.telegram.org",
]);
const SOCIAL_HANDLE_RE = /^@?[A-Za-z0-9._-]{2,64}$/;
const LOCAL_STATIC_IMAGE_RE = /^\/images\/(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9/_-]+\.(?:jpg|jpeg|png|webp)$/i;
const LOCAL_UPLOAD_IMAGE_RE = /^\/api\/files\/uploads\/(?:products|categories|banners)\/[a-z0-9-]+\.(?:jpg|png|webp)$/;
const PRESCRIPTION_CLAIM_URL_RE = /^\/api\/files\/prescriptions\/[a-z0-9-]+\.(?:jpg|png|webp|pdf)\?claim=[0-9]{10,16}\.[A-Za-z0-9_-]{32,64}$/;

export function isSafeImageUrl(v: string): boolean {
  if (!v || v.length > 500 || /[\x00-\x1f\x7f\\]/.test(v)) return false;
  if (LOCAL_STATIC_IMAGE_RE.test(v) || LOCAL_UPLOAD_IMAGE_RE.test(v)) return true;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && ALLOWED_REMOTE_IMAGE_HOSTS.has(u.hostname.toLowerCase()) && !u.username && !u.password;
  } catch {
    return false;
  }
}

export function isSafeAppLink(v: string): boolean {
  if (!v || v.length > 300 || /[\x00-\x1f\x7f\\]/.test(v)) return false;
  if (v.startsWith("/") && !v.startsWith("//") && !v.includes("..")) return true;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password;
  } catch {
    return false;
  }
}

export function isSafeSocialValue(v: string): boolean {
  if (!v) return true;
  if (v.length > 200 || /[\x00-\x1f\x7f\\]/.test(v)) return false;
  if (SOCIAL_HANDLE_RE.test(v)) return true;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && ALLOWED_SOCIAL_HOSTS.has(u.hostname.toLowerCase()) && !u.username && !u.password;
  } catch {
    return false;
  }
}

const optSafeImageUrl = optStr(500).refine((v) => v === null || isSafeImageUrl(v), "Invalid or untrusted image URL");
const reqSafeImageUrl = trimmed(500).min(1, "Image URL is required").refine(isSafeImageUrl, "Invalid or untrusted image URL");
const optSafeLink = optStr(300).refine((v) => v === null || isSafeAppLink(v), "Invalid target link URL");
const optPrescriptionClaimUrl = optStr(500).refine(
  (v) => v === null || PRESCRIPTION_CLAIM_URL_RE.test(v),
  "Invalid prescription upload reference – please upload your prescription again",
);

// ───────────────────── Dates & Date Ranges ─────────────────────

export const dateStr = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date")
  .refine((v) => {
    if (!isValidIsoDate(v)) return false;
    const year = Number(v.slice(0, 4));
    return year >= 1900 && year <= 2100;
  }, "Invalid date");

const optDateStr = z.preprocess(
  (v) => (v === null || v === undefined || (typeof v === "string" && v.trim() === "") ? null : v),
  dateStr.nullable(),
);

export const optionalQueryDate = optionalQuery(dateStr);

function validateDateOrder(
  from: string | null | undefined,
  to: string | null | undefined,
  ctx: z.RefinementCtx,
  opts: { fromPath?: string; toPath?: string; maxDays?: number; msg?: string } = {},
) {
  if (!from || !to) return;
  const fromDt = parseDateInput(from);
  const toDt = parseDateInput(to);
  if (fromDt > toDt) {
    ctx.addIssue({
      code: "custom",
      message: opts.msg ?? "End date must be on or after start date",
      path: [opts.toPath ?? "to"],
    });
    return;
  }
  if (opts.maxDays !== undefined) {
    const spanDays = Math.floor((toDt.getTime() - fromDt.getTime()) / 86_400_000);
    if (spanDays > opts.maxDays) {
      ctx.addIssue({
        code: "custom",
        message: `Date range cannot exceed ${opts.maxDays} days`,
        path: [opts.toPath ?? "to"],
      });
    }
  }
}

// ───────────────────── Cambodia Geography Allowlist ─────────────────────

export const provinceSchema = trimmed(60)
  .min(1, "Province is required")
  .refine((v) => findProvince(v) !== undefined, "Select a valid Cambodian province")
  .transform((v) => findProvince(v)!.en);

export const optProvinceSchema = optStr(60)
  .refine((v) => v === null || findProvince(v) !== undefined, "Select a valid Cambodian province")
  .transform((v) => (v ? findProvince(v)!.en : null));

function validateDistrictInProvince(
  province: string | null | undefined,
  district: string | null | undefined,
  ctx: z.RefinementCtx,
) {
  if (!district) return;
  if (!province) {
    ctx.addIssue({ code: "custom", message: "Province is required when district is specified", path: ["province"] });
    return;
  }
  const prov = findProvince(province);
  if (!prov || !prov.districts.includes(district)) {
    ctx.addIssue({ code: "custom", message: `Select a valid district in ${prov?.en ?? province}`, path: ["district"] });
  }
}

// ───────────────────── Email, Phone & Password ─────────────────────

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, "Email is too long")
  .regex(NO_CONTROL_SINGLE_LINE, "Invalid email")
  .email("Invalid email");

const optEmailSchema = z.preprocess(
  (v) => (v === null || v === undefined || (typeof v === "string" && v.trim() === "") ? null : v),
  emailSchema.nullable(),
);

export const khPhone = z
  .string()
  .trim()
  .max(25, "Enter a valid Cambodian phone number (+855)")
  .regex(NO_CONTROL_SINGLE_LINE, "Enter a valid Cambodian phone number (+855)")
  .refine((v) => normalizeKhPhone(v) !== null, "Enter a valid Cambodian phone number (+855)")
  .transform((v) => normalizeKhPhone(v)!);

const optKhPhone = z.preprocess(
  (v) => (v === null || v === undefined || (typeof v === "string" && v.trim() === "") ? null : v),
  khPhone.nullable(),
);

export const password = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password must be at most 128 characters")
  .regex(/^[^\x00\r\n]*$/, "Password contains invalid characters")
  .regex(/[A-Za-z]/, "Password must contain a letter")
  .regex(/\d/, "Password must contain a number");

const currentPasswordSchema = z
  .string()
  .min(1, "Password is required")
  .max(128, "Password is too long")
  .regex(/^[^\x00]*$/, "Invalid password");

// ───────────────────── Auth & Account Schemas ─────────────────────

export const registerSchema = z
  .object({
    name: trimmed(100).min(2, "Name is required"),
    email: emailSchema,
    phone: khPhone,
    password,
  })
  .strict();

export const loginSchema = z
  .object({
    identifier: trimmed(200).min(3, "Enter email or phone"),
    password: currentPasswordSchema,
  })
  .strict();

export const loginRequestSchema = loginSchema
  .extend({ scope: z.enum(["customer", "admin"]).default("customer") })
  .strict();

export const logoutSchema = z
  .object({ all: z.boolean().optional().default(false) })
  .strict();

export const changePasswordSchema = z
  .object({ currentPassword: currentPasswordSchema, newPassword: password })
  .strict();

export const passwordResetRequestSchema = z
  .object({ identifier: trimmed(200).min(3, "Enter email or phone") })
  .strict();

export const passwordResetConfirmSchema = z
  .object({
    token: trimmed(200)
      .min(16, "Invalid reset token")
      .regex(/^[A-Za-z0-9_-]{16,200}$/, "Invalid reset token"),
    newPassword: password,
  })
  .strict();

export const profileSchema = z
  .object({
    name: trimmed(100).min(2, "Name is required"),
    phone: khPhone,
    locale: z.enum(["km", "en", "vi", "zh-CN", "fr"]).optional(),
  })
  .strict();

export const addressSchema = z
  .object({
    label: optStr(50),
    fullName: trimmed(100).min(2, "Full name is required"),
    phone: khPhone,
    province: provinceSchema,
    district: trimmed(60).min(1, "District is required"),
    commune: optStr(60),
    village: optStr(60),
    street: optStr(200),
    instructions: optMultiline(300),
    isDefault: z.boolean().optional().default(false),
  })
  .strict()
  .superRefine((d, ctx) => validateDistrictInProvince(d.province, d.district, ctx));

export const notificationsReadSchema = z
  .object({
    ids: z.array(entityIdSchema).min(1).max(100).optional(),
  })
  .strict();

export const wishlistToggleSchema = z
  .object({ medicineId: entityIdSchema })
  .strict();

// ───────────────────── Cart, Checkout, Orders & Payments ─────────────────────

export const cartLineSchema = z
  .object({
    medicineId: entityIdSchema,
    quantity: safeInt(1, 999, "Quantity must be between 1 and 999"),
  })
  .strict();

function validateMergedCartQuantities(items: { medicineId: string; quantity: number }[], ctx: z.RefinementCtx) {
  const totals = new Map<string, number>();
  for (const item of items) {
    const next = (totals.get(item.medicineId) ?? 0) + item.quantity;
    if (next > 999) {
      ctx.addIssue({
        code: "custom",
        message: "Total quantity per medicine cannot exceed 999",
        path: ["items"],
      });
      return;
    }
    totals.set(item.medicineId, next);
  }
}

export const cartQuoteSchema = z
  .object({
    items: z.array(cartLineSchema).min(1, "Cart is empty").max(100, "Too many items in cart"),
    discountCode: optStr(40),
    province: optProvinceSchema,
  })
  .strict()
  .superRefine((d, ctx) => validateMergedCartQuantities(d.items, ctx));

export const checkoutSchema = z
  .object({
    items: z.array(cartLineSchema).min(1, "Cart is empty").max(100, "Too many items in cart"),
    discountCode: optStr(40),
    fullName: trimmed(100).min(2, "Full name is required"),
    phone: khPhone,
    email: optEmailSchema,
    province: provinceSchema,
    district: trimmed(60).min(1, "District is required"),
    commune: optStr(60),
    village: optStr(60),
    street: optStr(200),
    instructions: optMultiline(500),
    prescriptionUrl: optPrescriptionClaimUrl,
    saveAddress: z.boolean().optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    validateMergedCartQuantities(d.items, ctx);
    validateDistrictInProvince(d.province, d.district, ctx);
  });

function validatePaymentMethodOptions(
  d: { method: string; currency?: string; network?: string },
  ctx: z.RefinementCtx,
) {
  if (d.method === "USDT" && !d.network) {
    ctx.addIssue({ code: "custom", message: "Select a USDT network", path: ["network"] });
  }
  if (d.method !== "USDT" && d.network !== undefined) {
    ctx.addIssue({ code: "custom", message: "Network is only valid for USDT payments", path: ["network"] });
  }
  if (d.method !== "KHQR" && d.currency !== undefined) {
    ctx.addIssue({ code: "custom", message: "Currency selection is only valid for KHQR payments", path: ["currency"] });
  }
}

export const initiatePaymentSchema = z
  .object({
    method: z.enum(["KHQR", "USDT", "PAYPAL", "CASH"]),
    currency: z.enum(["USD", "KHR"]).optional(),
    network: z.enum(["TRC20", "ERC20", "BEP20", "POLYGON"]).optional(),
  })
  .strict()
  .superRefine(validatePaymentMethodOptions);

export const onlineInitiatePaymentSchema = z
  .object({
    method: z.enum(["KHQR", "USDT", "PAYPAL"], { message: "Selected payment method is not available online" }),
    currency: z.enum(["USD", "KHR"]).optional(),
    network: z.enum(["TRC20", "ERC20", "BEP20", "POLYGON"]).optional(),
  })
  .strict()
  .superRefine(validatePaymentMethodOptions);

export const usdtHashSchema = z
  .object({
    txHash: trimmed(66).regex(/^(?:0x)?[0-9a-fA-F]{64}$/, "Enter a valid 64-character hexadecimal transaction hash"),
  })
  .strict();

export const reviewSchema = z
  .object({
    rating: safeInt(1, 5, "Rating must be between 1 and 5"),
    comment: optMultiline(1000),
  })
  .strict();

export const productsQuerySchema = z
  .object({
    q: optionalQuery(trimmed(100)),
    category: optionalQuery(categorySlugSchema),
    brand: optionalQuery(
      trimmed(500).refine((v) => {
        const parts = v.split(",").filter(Boolean);
        return parts.length <= 20 && parts.every((b) => CATEGORY_SLUG_RE.test(b) && b.length <= 100);
      }, "Invalid brand filter"),
    ),
    minPrice: optionalQuery(queryMoney(0, 1_000_000)),
    maxPrice: optionalQuery(queryMoney(0, 1_000_000)),
    sort: optionalQuery(z.enum(["popular", "newest", "price_asc", "price_desc", "name"])),
    inStock: optionalQuery(z.enum(["1", "0"])),
    rx: optionalQuery(z.enum(["rx", "otc"])),
    page: optionalQuery(queryInt(1, 10_000)),
    pageSize: optionalQuery(queryInt(1, 48)),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.minPrice !== undefined && d.maxPrice !== undefined && d.minPrice > d.maxPrice) {
      ctx.addIssue({ code: "custom", message: "Minimum price cannot exceed maximum price", path: ["minPrice"] });
    }
  });

export const customerOrdersQuerySchema = z
  .object({ ...paginationQueryFields })
  .strict();

export const prescriptionFileQuerySchema = z
  .object({
    orderId: optionalQuery(entityIdSchema),
    token: optionalQuery(orderAccessTokenSchema),
  })
  .strict();

// ───────────────────── Admin Body Schemas ─────────────────────

export const medicineSchema = z
  .object({
    nameEn: trimmed(200).min(2, "English name is required"),
    nameKm: trimmed(200).min(1, "Khmer name is required"),
    genericName: optStr(200),
    sku: trimmed(50)
      .min(2, "SKU is required")
      .regex(/^[A-Za-z0-9\-_.]+$/, "SKU may contain letters, numbers, - _ ."),
    barcode: optStr(50).refine((v) => v === null || BARCODE_RE.test(v), "Invalid barcode format"),
    categoryId: entityIdSchema,
    brandId: optEntityId,
    manufacturer: optStr(200),
    activeIngredients: optStr(500),
    dosageForm: optStr(50),
    strength: optStr(50),
    dosageInfo: optMultiline(2000),
    usageInstructions: optMultiline(2000),
    warnings: optMultiline(2000),
    descriptionEn: optMultiline(5000),
    descriptionKm: optMultiline(5000),
    unit: trimmed(30).min(1, "Unit is required").default("box"),
    price: money.refine((v) => v > 0, "Price must be greater than 0"),
    compareAtPrice: optNullableMoney,
    costPrice: money,
    minStock: safeInt(0, 100_000).default(10),
    imageUrl: optSafeImageUrl,
    images: z.array(reqSafeImageUrl).max(10).optional().default([]),
    requiresPrescription: z.boolean().default(false),
    tracksExpiry: z.boolean().default(true),
    isFeatured: z.boolean().default(false),
    isActive: z.boolean().default(true),
    location: optStr(50),
    // optional opening stock when creating
    initialStock: z
      .object({
        batchNumber: trimmed(50).min(1, "Batch number is required").regex(BATCH_NUMBER_RE, "Invalid batch number"),
        quantity: safeInt(1, 1_000_000, "Opening quantity must be at least 1"),
        expiryDate: optDateStr,
        costPrice: optNumber(z.number().min(0).max(1_000_000)),
      })
      .strict()
      .optional()
      .nullable(),
  })
  .strict();

/** Update schema forbids setting opening stock on an existing medicine (null/omitted only). */
export const medicineUpdateSchema = medicineSchema
  .extend({
    initialStock: z.null().optional(),
  })
  .strict();

export const categorySchema = z
  .object({
    nameEn: trimmed(100).min(2, "English name is required"),
    nameKm: trimmed(100).min(1, "Khmer name is required"),
    slug: optionalQuery(categorySlugSchema),
    description: optMultiline(500),
    icon: optStr(50),
    imageUrl: optSafeImageUrl,
    sortOrder: safeInt(-10_000, 10_000).default(0),
    isActive: z.boolean().default(true),
  })
  .strict();

export const brandSchema = z
  .object({
    name: trimmed(100).min(1, "Brand name is required"),
    manufacturer: optStr(200),
    country: optStr(100),
  })
  .strict();

export const supplierSchema = z
  .object({
    name: trimmed(200).min(2, "Supplier name is required"),
    contactName: optStr(100),
    phone: optKhPhone,
    email: optEmailSchema,
    province: optProvinceSchema,
    district: optStr(60),
    address: optStr(300),
    taxId: optStr(50),
    notes: optMultiline(1000),
  })
  .strict()
  .superRefine((d, ctx) => validateDistrictInProvince(d.province, d.district, ctx));

export const stockInSchema = z
  .object({
    medicineId: entityIdSchema,
    batchNumber: trimmed(50).min(1, "Batch number is required").regex(BATCH_NUMBER_RE, "Invalid batch number"),
    lotNumber: optStr(50).refine((v) => v === null || BATCH_NUMBER_RE.test(v), "Invalid lot number"),
    expiryDate: optDateStr,
    manufactureDate: optDateStr,
    quantity: safeInt(1, 1_000_000, "Quantity must be between 1 and 1,000,000"),
    costPrice: money,
    supplierId: optEntityId,
    reason: optMultiline(300),
  })
  .strict()
  .superRefine((d, ctx) =>
    validateDateOrder(d.manufactureDate, d.expiryDate, ctx, {
      fromPath: "manufactureDate",
      toPath: "expiryDate",
      msg: "Expiry date must be on or after manufacture date",
    }),
  );

export const adjustSchema = z
  .object({
    mode: z.enum(["out", "set"]),
    quantity: safeInt(0, 1_000_000, "Quantity must be between 0 and 1,000,000"),
    reason: trimmedMultiline(300).min(3, "Reason is required"),
    type: z.enum(["STOCK_OUT", "ADJUSTMENT", "EXPIRED_WRITE_OFF"]).optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.mode === "out" && d.quantity < 1) {
      ctx.addIssue({ code: "custom", message: "Quantity to remove must be at least 1", path: ["quantity"] });
    }
    if ((d.type === "STOCK_OUT" || d.type === "EXPIRED_WRITE_OFF") && d.mode !== "out") {
      ctx.addIssue({ code: "custom", message: "Stock out and expired write-off require mode \"out\"", path: ["type"] });
    }
    if (d.type === "ADJUSTMENT" && d.mode !== "set") {
      ctx.addIssue({ code: "custom", message: "Cycle count adjustment requires mode \"set\"", path: ["type"] });
    }
  });

export const purchaseSchema = z
  .object({
    supplierId: entityIdSchema,
    notes: optMultiline(1000),
    shippingCost: money.default(0),
    items: z
      .array(
        z
          .object({
            medicineId: entityIdSchema,
            quantity: safeInt(1, 1_000_000, "Quantity must be at least 1"),
            unitCost: money,
          })
          .strict(),
      )
      .min(1, "Add at least one medicine")
      .max(200, "Too many line items in a purchase order"),
  })
  .strict()
  .superRefine((d, ctx) => {
    const seen = new Set<string>();
    for (const item of d.items) {
      if (seen.has(item.medicineId)) {
        ctx.addIssue({ code: "custom", message: "Each medicine can only appear once", path: ["items"] });
        return;
      }
      seen.add(item.medicineId);
    }
  });

export const receiveSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            purchaseItemId: entityIdSchema,
            quantity: safeInt(0, 1_000_000),
            batchNumber: trimmed(50).min(1, "Batch number is required").regex(BATCH_NUMBER_RE, "Invalid batch number"),
            lotNumber: optStr(50).refine((v) => v === null || BATCH_NUMBER_RE.test(v), "Invalid lot number"),
            expiryDate: optDateStr,
            manufactureDate: optDateStr,
          })
          .strict()
          .superRefine((item, ctx) =>
            validateDateOrder(item.manufactureDate, item.expiryDate, ctx, {
              fromPath: "manufactureDate",
              toPath: "expiryDate",
              msg: "Expiry date must be on or after manufacture date",
            }),
          ),
      )
      .min(1, "Add at least one item to receive")
      .max(200, "Too many receive lines"),
  })
  .strict()
  .superRefine((d, ctx) => {
    const seen = new Set<string>();
    for (const item of d.items) {
      if (seen.has(item.purchaseItemId)) {
        ctx.addIssue({ code: "custom", message: "Duplicate purchase item in receive payload", path: ["items"] });
        return;
      }
      seen.add(item.purchaseItemId);
    }
  });

export const orderStatusSchema = z
  .object({
    status: z.enum(["CONFIRMED", "PROCESSING", "READY_FOR_DELIVERY", "SHIPPING", "DELIVERED", "CANCELLED"]),
    note: optMultiline(500),
  })
  .strict();

export const fulfilSchema = z
  .object({
    quantities: z
      .record(entityIdSchema, safeInt(0, 1_000_000))
      .refine((rec) => {
        const keys = Object.keys(rec);
        return keys.length >= 1 && keys.length <= 100;
      }, "Provide between 1 and 100 order items to fulfil"),
  })
  .strict();

export const prescriptionReviewSchema = z
  .object({
    approve: z.boolean(),
    note: optMultiline(500),
  })
  .strict();

export const refundSchema = z
  .object({
    reason: trimmedMultiline(300).min(3, "Reason is required"),
    manualReference: optStr(200),
  })
  .strict();

export const orderRefundSchema = refundSchema
  .extend({ paymentId: optEntityId.optional() })
  .strict();

export const cashPaymentSchema = z
  .object({ tendered: money })
  .strict();

export const posCancelSchema = z
  .object({ orderId: entityIdSchema })
  .strict();

export const posLookupQuerySchema = z
  .object({ q: trimmed(100).min(1, "Enter a search term or barcode") })
  .strict();

export const posSaleSchema = z
  .object({
    items: z.array(cartLineSchema).min(1, "Cart is empty").max(100, "Too many items in sale"),
    discountCode: optStr(40),
    manualDiscount: optNumber(z.number().min(0).max(100_000)),
    customerName: optStr(100),
    customerPhone: optKhPhone,
    customerId: optEntityId,
    method: z.enum(["KHQR", "USDT", "PAYPAL", "CASH"]),
    currency: z.enum(["USD", "KHR"]).optional(),
    network: z.enum(["TRC20", "ERC20", "BEP20", "POLYGON"]).optional(),
    notes: optMultiline(300),
  })
  .strict()
  .superRefine((d, ctx) => {
    validateMergedCartQuantities(d.items, ctx);
    validatePaymentMethodOptions(d, ctx);
  });

export const discountSchema = z
  .object({
    code: trimmed(40)
      .min(3, "Code must be at least 3 characters")
      .regex(/^[A-Za-z0-9_-]+$/, "Letters, numbers, - and _ only")
      .transform((v) => v.toUpperCase()),
    description: optMultiline(300),
    type: z.enum(["PERCENTAGE", "FIXED"]),
    value: strictNumber(z.number({ message: "Value must be a valid number" }).positive("Value must be greater than 0").max(1_000_000)),
    minSubtotal: money.default(0),
    maxDiscount: optNullableMoney,
    usageLimit: optNullableInt(1, 10_000_000),
    startsAt: optDateStr,
    endsAt: optDateStr,
    isActive: z.boolean().default(true),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.type === "PERCENTAGE" && d.value > 100) {
      ctx.addIssue({ code: "custom", message: "Percentage cannot exceed 100", path: ["value"] });
    }
    validateDateOrder(d.startsAt, d.endsAt, ctx, {
      fromPath: "startsAt",
      toPath: "endsAt",
      msg: "End date must be on or after start date",
    });
  });

export const bannerSchema = z
  .object({
    titleEn: trimmed(150).min(2, "English title is required"),
    titleKm: trimmed(150).min(1, "Khmer title is required"),
    subtitleEn: optStr(300),
    subtitleKm: optStr(300),
    imageUrl: reqSafeImageUrl,
    link: optSafeLink,
    sortOrder: safeInt(-10_000, 10_000).default(0),
    isActive: z.boolean().default(true),
  })
  .strict();

export const customerUpdateSchema = z
  .object({
    name: trimmed(100).min(2, "Name is required").optional(),
    phone: khPhone.optional(),
    email: emailSchema.optional(),
    status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
    notes: z
      .string()
      .trim()
      .max(1000)
      .regex(NO_CONTROL_MULTILINE, "Contains invalid control characters")
      .transform((v) => (v ? v : null))
      .nullable()
      .optional(),
  })
  .strict()
  .refine((d) => Object.values(d).some((v) => v !== undefined), "Provide at least one field to update");

export const staffSchema = z
  .object({
    name: trimmed(100).min(2, "Name is required"),
    email: emailSchema,
    phone: optKhPhone,
    role: z.enum(["SUPER_ADMIN", "ADMIN", "PHARMACIST", "CASHIER", "INVENTORY_STAFF"]),
    position: optStr(100),
    licenseNo: optStr(100),
    password: password.optional(),
    status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
  })
  .strict();

/** Staff creation requires a password and never creates suspended accounts via parameter tampering. */
export const staffCreateSchema = staffSchema
  .extend({
    password,
    status: z.literal("ACTIVE").optional(),
  })
  .strict();

export const storeSettingsSchema = z
  .object({
    storeNameEn: trimmed(100).min(2, "English store name is required"),
    storeNameKm: trimmed(100).min(1, "Khmer store name is required"),
    phone: khPhone,
    email: emailSchema,
    addressEn: trimmed(300).min(1, "Address is required"),
    addressKm: trimmed(300).min(1, "Khmer address is required"),
    openingHours: trimmed(100).min(1),
    licenseNo: trimmed(100).min(1),
    exchangeRate: safeInt(1000, 10_000, "Exchange rate must be between 1,000 and 10,000"),
    deliveryFeePhnomPenh: money,
    deliveryFeeProvince: money,
    freeDeliveryThreshold: money,
    reservationMinutes: safeInt(5, 1440, "Reservation window must be between 5 and 1,440 minutes"),
    lowStockDefault: safeInt(0, 100_000),
    emailNotifications: z.boolean(),
    notificationEmail: z.union([z.literal(""), emailSchema]),
    facebook: trimmed(200).refine(isSafeSocialValue, "Enter a valid Facebook URL or handle"),
    telegram: trimmed(200).refine(isSafeSocialValue, "Enter a valid Telegram URL or handle"),
  })
  .strict();

export const paymentSettingsSchema = z
  .object({
    KHQR: z
      .object({
        enabled: z.boolean(),
        online: z.boolean(),
        pos: z.boolean(),
        config: z
          .object({
            merchantName: trimmed(25).min(1, "Merchant name is required"),
            merchantCity: trimmed(15).min(1, "Merchant city is required"),
            accountId: z
              .string()
              .trim()
              .max(32)
              .regex(/^$|^[^@\s\x00-\x1f\x7f]+@[^@\s\x00-\x1f\x7f]+$/, "Format: name@bank")
              .optional(),
            merchantType: z.enum(["individual", "merchant"]),
            merchantId: z
              .string()
              .trim()
              .max(32)
              .regex(/^[A-Za-z0-9._-]*$/, "Invalid merchant ID")
              .optional(),
            acquiringBank: z
              .string()
              .trim()
              .max(32)
              .regex(NO_CONTROL_SINGLE_LINE, "Invalid acquiring bank")
              .optional(),
            mobileNumber: z
              .string()
              .trim()
              .max(15)
              .regex(/^$|^\+?[0-9\s-]{6,15}$/, "Invalid mobile number")
              .optional(),
            currencies: z
              .array(z.enum(["USD", "KHR"]))
              .min(1, "Select at least one currency")
              .max(2)
              .refine((arr) => new Set(arr).size === arr.length, "Duplicate currencies are not allowed"),
            expiryMinutes: safeInt(2, 60, "KHQR expiry must be between 2 and 60 minutes"),
          })
          .strict(),
      })
      .strict(),
    USDT: z
      .object({
        enabled: z.boolean(),
        online: z.boolean(),
        pos: z.boolean(),
        config: z
          .object({
            expiryMinutes: safeInt(10, 1440, "USDT expiry must be between 10 and 1,440 minutes"),
            networks: z
              .array(
                z
                  .object({
                    code: z.enum(["TRC20", "ERC20", "BEP20", "POLYGON"]),
                    enabled: z.boolean(),
                    walletAddress: z.string().trim().max(64).regex(/^[A-Za-z0-9]*$/, "Invalid wallet address format"),
                    contractAddress: z.string().trim().max(64).regex(/^[A-Za-z0-9]*$/, "Invalid contract address format"),
                    decimals: safeInt(0, 18),
                    confirmations: safeInt(1, 200),
                  })
                  .strict(),
              )
              .max(4)
              .refine((arr) => new Set(arr.map((n) => n.code)).size === arr.length, "Duplicate USDT network entries are not allowed"),
          })
          .strict(),
      })
      .strict(),
    PAYPAL: z
      .object({
        enabled: z.boolean(),
        online: z.boolean(),
        pos: z.boolean(),
        config: z.object({ brandName: trimmed(127).min(1, "Brand name is required") }).strict(),
      })
      .strict(),
    CASH: z
      .object({
        enabled: z.boolean(),
        online: z.literal(false).default(false),
        pos: z.boolean(),
        config: z.object({}).strict().default({}),
      })
      .strict(),
  })
  .strict();

// ───────────────────── Admin Query & Report Schemas ─────────────────────

export const AUDIT_ENTITIES = [
  "User",
  "Medicine",
  "MedicineBatch",
  "Category",
  "Brand",
  "Supplier",
  "Purchase",
  "Order",
  "Payment",
  "PaymentMethod",
  "Discount",
  "Banner",
  "Customer",
  "SystemSetting",
  "Report",
  "Upload",
  "BotProtection",
] as const;

export const REPORT_TYPES = [
  "sales",
  "medicine-sales",
  "purchases",
  "inventory",
  "expiry",
  "customers",
  "profit-loss",
  "payments",
] as const;

export const adminAuditQuerySchema = z
  .object({
    q: optionalQuery(trimmed(100)),
    entity: optionalQuery(z.enum(AUDIT_ENTITIES)),
    ...paginationQueryFields,
  })
  .strict();

export const adminCustomersQuerySchema = z
  .object({
    q: optionalQuery(trimmed(100)),
    status: optionalQuery(z.enum(["ACTIVE", "SUSPENDED"])),
    ...paginationQueryFields,
  })
  .strict();

export const adminInventoryQuerySchema = z
  .object({
    q: optionalQuery(trimmed(100)),
    filter: optionalQuery(z.enum(["all", "low", "out", "expired"])),
    ...paginationQueryFields,
  })
  .strict();

export const adminBatchesQuerySchema = z
  .object({ medicineId: entityIdSchema })
  .strict();

export const adminMovementsQuerySchema = z
  .object({
    medicineId: optionalQuery(entityIdSchema),
    type: optionalQuery(z.enum(StockMovementType)),
    q: optionalQuery(trimmed(100)),
    ...paginationQueryFields,
  })
  .strict();

export const adminMedicinesQuerySchema = z
  .object({
    q: optionalQuery(trimmed(100)),
    category: optionalQuery(entityIdSchema),
    status: optionalQuery(z.enum(["active", "inactive", "low", "out"])),
    rx: optionalQuery(z.enum(["rx", "otc"])),
    ...paginationQueryFields,
  })
  .strict();

export const adminOrdersQuerySchema = z
  .object({
    q: optionalQuery(trimmed(100)),
    status: optionalQuery(z.enum(OrderStatus)),
    payment: optionalQuery(z.enum(PaymentStatus)),
    channel: optionalQuery(z.enum(["ONLINE", "POS"])),
    rx: optionalQuery(z.enum(["pending"])),
    from: optionalQueryDate,
    to: optionalQueryDate,
    ...paginationQueryFields,
  })
  .strict()
  .superRefine((d, ctx) => validateDateOrder(d.from, d.to, ctx));

export const adminPaymentsQuerySchema = z
  .object({
    q: optionalQuery(trimmed(100)),
    status: optionalQuery(z.enum(PaymentStatus)),
    method: optionalQuery(z.enum(PaymentMethodCode)),
    from: optionalQueryDate,
    to: optionalQueryDate,
    ...paginationQueryFields,
  })
  .strict()
  .superRefine((d, ctx) => validateDateOrder(d.from, d.to, ctx));

export const adminPurchasesQuerySchema = z
  .object({
    q: optionalQuery(trimmed(100)),
    status: optionalQuery(z.enum(PurchaseStatus)),
    supplierId: optionalQuery(entityIdSchema),
    ...paginationQueryFields,
  })
  .strict();

export const adminSuppliersQuerySchema = z
  .object({ q: optionalQuery(trimmed(100)) })
  .strict();

export const adminReportParamSchema = z
  .object({ type: z.enum(REPORT_TYPES) })
  .strict();

export const adminReportQuerySchema = z
  .object({
    from: optionalQueryDate,
    to: optionalQueryDate,
    g: optionalQuery(z.enum(["day", "week", "month", "year"])),
    format: optionalQuery(z.enum(["json", "csv"])),
  })
  .strict()
  .superRefine((d, ctx) => {
    const maxDays = (d.g ?? "day") === "day" ? 1830 : 7305;
    validateDateOrder(d.from, d.to, ctx, { maxDays });
  });

// ───────────────────── Webhook Schemas ─────────────────────

export const paypalWebhookEventSchema = z.object({
  id: trimmed(128).optional(),
  event_type: trimmed(100).regex(/^[A-Z0-9._-]+$/, "Invalid PayPal event type"),
  resource: z.record(z.string(), z.unknown()),
});
