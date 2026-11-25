/**
 * Explicit Field Allowlists for Mass Assignment & Parameter Tampering Protection
 *
 * Every API route that mutates persistent state MUST:
 *   1. Validate input with a strict Zod schema (rejecting unknown keys with 422), AND
 *   2. Project the validated payload through `pickAllowed(...)` using an explicit,
 *      resource-specific allowlist before passing data to Prisma or internal services.
 *
 * Protected fields (role, roleId, permissions, isStaff, userId, user_id, customerId,
 * passwordHash, status on self-service routes, pricing/totals, counters, audit columns,
 * soft-delete flags) are NEVER included in client-writable allowlists and are always
 * derived server-side from the authenticated session, RBAC policy, or database state.
 */

const FORBIDDEN_PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Protected fields that must never be accepted from untrusted client payloads on
 * self-service endpoints or mass-assigned onto privileged models.
 */
export const PROTECTED_ACCOUNT_FIELDS = [
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
  "status",
  "passwordHash",
  "password_hash",
  "deletedAt",
  "deleted_at",
  "lastLoginAt",
  "createdAt",
  "updatedAt",
] as const;

export const PROTECTED_COMMERCE_FIELDS = [
  "subtotal",
  "discountAmount",
  "discount_amount",
  "discountId",
  "deliveryFee",
  "delivery_fee",
  "total",
  "amount",
  "amountUsd",
  "unitPrice",
  "unit_price",
  "unitCost",
  "unit_cost",
  "lineTotal",
  "line_total",
  "exchangeRate",
  "paymentStatus",
  "payment_status",
  "fulfillmentStatus",
  "fulfillment_status",
  "prescriptionStatus",
  "prescription_status",
  "reviewedById",
  "reviewedAt",
  "cashierId",
  "cashier_id",
  "channel",
  "manualDiscount",
  "staffCanDispenseRx",
  "soldCount",
  "usedCount",
  "receivedQuantity",
  "fulfilledQuantity",
  "providerTxnId",
  "providerRef",
  "paidAt",
  "refundedAt",
  "refundAmount",
  "createdById",
] as const;

/**
 * Copies ONLY explicitly allowlisted own properties from `source` into a fresh object.
 * Never copies prototype chain properties or unlisted fields.
 */
export function pickAllowed<
  T extends Record<string, unknown>,
  const K extends readonly (keyof T & string)[],
>(
  source: T,
  allowedKeys: K,
  opts: { omitUndefined?: boolean } = {},
): Pick<T, K[number]> {
  const out = {} as Record<string, unknown>;
  for (const key of allowedKeys) {
    if (FORBIDDEN_PROTOTYPE_KEYS.has(key)) continue;
    if (!Object.hasOwn(source, key)) continue;
    const val = source[key];
    if (opts.omitUndefined && val === undefined) continue;
    out[key] = val;
  }
  return out as Pick<T, K[number]>;
}

// ───────────────────── Customer / Self-Service Allowlists ─────────────────────

export const PROFILE_UPDATE_FIELDS = ["name", "phone", "locale"] as const;

export const ADDRESS_WRITE_FIELDS = [
  "label",
  "fullName",
  "phone",
  "province",
  "district",
  "commune",
  "village",
  "street",
  "instructions",
  "isDefault",
] as const;

export const CART_QUOTE_FIELDS = ["items", "discountCode", "province"] as const;

export const ONLINE_ORDER_CREATE_FIELDS = [
  "items",
  "discountCode",
  "fullName",
  "phone",
  "email",
  "province",
  "district",
  "commune",
  "village",
  "street",
  "instructions",
  "prescriptionUrl",
] as const;

export const ONLINE_PAYMENT_INITIATE_FIELDS = ["method", "currency", "network"] as const;

export const REVIEW_WRITE_FIELDS = ["rating", "comment"] as const;

// ───────────────────── Admin Domain Allowlists ─────────────────────

export const MEDICINE_WRITE_FIELDS = [
  "nameEn",
  "nameKm",
  "genericName",
  "sku",
  "barcode",
  "categoryId",
  "brandId",
  "manufacturer",
  "activeIngredients",
  "dosageForm",
  "strength",
  "dosageInfo",
  "usageInstructions",
  "warnings",
  "descriptionEn",
  "descriptionKm",
  "unit",
  "price",
  "compareAtPrice",
  "costPrice",
  "imageUrl",
  "images",
  "requiresPrescription",
  "tracksExpiry",
  "isFeatured",
  "isActive",
] as const;

export const CATEGORY_WRITE_FIELDS = [
  "nameEn",
  "nameKm",
  "description",
  "icon",
  "imageUrl",
  "sortOrder",
  "isActive",
] as const;

export const BRAND_WRITE_FIELDS = ["name", "manufacturer", "country"] as const;

export const SUPPLIER_WRITE_FIELDS = [
  "name",
  "contactName",
  "phone",
  "email",
  "province",
  "district",
  "address",
  "taxId",
  "notes",
] as const;

export const BANNER_WRITE_FIELDS = [
  "titleEn",
  "titleKm",
  "subtitleEn",
  "subtitleKm",
  "imageUrl",
  "link",
  "sortOrder",
  "isActive",
] as const;

export const DISCOUNT_WRITE_FIELDS = [
  "code",
  "description",
  "type",
  "value",
  "minSubtotal",
  "maxDiscount",
  "usageLimit",
  "isActive",
] as const;

export const STOCK_IN_FIELDS = [
  "medicineId",
  "batchNumber",
  "lotNumber",
  "quantity",
  "costPrice",
  "supplierId",
] as const;

export const BATCH_ADJUST_FIELDS = ["mode", "quantity", "reason", "type"] as const;

export const ADMIN_CUSTOMER_USER_UPDATE_FIELDS = ["name", "phone", "email", "status"] as const;

export const ADMIN_STAFF_USER_WRITE_FIELDS = ["name", "email", "phone"] as const;

export const ADMIN_STAFF_EMPLOYEE_WRITE_FIELDS = ["position", "licenseNo"] as const;

export const STORE_SETTINGS_FIELDS = [
  "storeNameEn",
  "storeNameKm",
  "phone",
  "email",
  "addressEn",
  "addressKm",
  "openingHours",
  "licenseNo",
  "exchangeRate",
  "deliveryFeePhnomPenh",
  "deliveryFeeProvince",
  "freeDeliveryThreshold",
  "reservationMinutes",
  "lowStockDefault",
  "emailNotifications",
  "notificationEmail",
  "facebook",
  "telegram",
] as const;

export const KHQR_CONFIG_FIELDS = [
  "merchantName",
  "merchantCity",
  "accountId",
  "merchantType",
  "merchantId",
  "acquiringBank",
  "mobileNumber",
  "currencies",
  "expiryMinutes",
] as const;

export const USDT_NETWORK_CONFIG_FIELDS = [
  "code",
  "enabled",
  "walletAddress",
  "contractAddress",
  "decimals",
  "confirmations",
] as const;

export const PAYPAL_CONFIG_FIELDS = ["brandName"] as const;
