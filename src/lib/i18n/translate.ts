import type { Dict, Locale } from "./dictionaries";

type Path<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Path<T[K], `${P}${K}.`>;
}[keyof T & string];

export type TKey = Path<Dict>;
export type TFunc = (key: TKey, vars?: Record<string, string | number>) => string;
export type TryTFunc = (key: string, fallback?: string, vars?: Record<string, string | number>) => string;

function lookup(dict: unknown, key: string): string | undefined {
  if (!dict || typeof dict !== "object") return undefined;
  let cur: unknown = dict;
  let rest = key;
  while (cur && typeof cur === "object") {
    const rec = cur as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(rec, rest)) {
      const val = rec[rest];
      return typeof val === "string" && val.length > 0 ? val : undefined;
    }
    const dot = rest.indexOf(".");
    if (dot === -1) return undefined;
    const seg = rest.slice(0, dot);
    if (!Object.prototype.hasOwnProperty.call(rec, seg)) return undefined;
    cur = rec[seg];
    rest = rest.slice(dot + 1);
  }
  return undefined;
}

function interpolate(str: string, vars?: Record<string, string | number>): string {
  if (!vars) return str;
  let s = str;
  for (const [k, val] of Object.entries(vars)) {
    const replacement = String(val);
    s = s.replaceAll(`{${k}}`, () => replacement);
  }
  return s;
}

/**
 * Create a type-safe translator with automatic fallback to English, then the raw key.
 */
export function makeT(dict: Dict, fallbackDict?: Dict): TFunc {
  return (key: TKey, vars?: Record<string, string | number>): string => {
    const raw = lookup(dict, key) ?? (fallbackDict ? lookup(fallbackDict, key) : undefined) ?? key;
    return interpolate(raw, vars);
  };
}

/**
 * Dynamic key lookup with graceful fallback (dict → en → fallback text → key).
 */
export function makeTryT(dict: Dict, fallbackDict?: Dict): TryTFunc {
  return (key: string, fallback?: string, vars?: Record<string, string | number>): string => {
    const raw = lookup(dict, key) ?? (fallbackDict ? lookup(fallbackDict, key) : undefined) ?? fallback ?? key;
    return interpolate(raw, vars);
  };
}

/**
 * Translate a category name by slug for vi / zh-CN / fr while preserving km & en DB fields verbatim.
 */
export function localizeCategoryName(
  cat: { slug?: string | null; nameEn?: string | null; nameKm?: string | null },
  locale: Locale,
  tryT: TryTFunc,
): string {
  const base = locale === "km" ? (cat.nameKm || cat.nameEn || "") : (cat.nameEn || cat.nameKm || "");
  if (locale === "km" || locale === "en" || !cat.slug) return base;
  return tryT(`catalogData.categories.${cat.slug}`, base);
}

/**
 * Translate a payment method label by code (KHQR, USDT, PAYPAL, CASH).
 */
export function localizePaymentMethod(
  method: { code?: string | null; nameEn?: string | null; nameKm?: string | null },
  locale: Locale,
  tryT: TryTFunc,
): string {
  const base = locale === "km" ? (method.nameKm || method.nameEn || method.code || "") : (method.nameEn || method.code || "");
  if (locale === "km" || locale === "en" || !method.code) return base;
  return tryT(`catalogData.paymentMethods.${method.code}`, base);
}

/**
 * Translate seeded marketing banners when they match known titles, while preserving custom banners.
 */
export function localizeBanner(
  banner: { titleEn?: string | null; titleKm?: string | null; subtitleEn?: string | null; subtitleKm?: string | null },
  locale: Locale,
  t: TFunc,
): { title: string; subtitle: string } {
  const title = locale === "km" ? (banner.titleKm || banner.titleEn || "") : (banner.titleEn || "");
  const subtitle = locale === "km" ? (banner.subtitleKm || banner.subtitleEn || "") : (banner.subtitleEn || "");
  if (locale === "km" || locale === "en") return { title, subtitle };
  if (banner.titleEn === "Vitamins for the Whole Family") {
    return { title: t("catalogData.banners.b1Title"), subtitle: t("catalogData.banners.b1Sub") };
  }
  if (banner.titleEn === "Talk to Our Pharmacists") {
    return { title: t("catalogData.banners.b2Title"), subtitle: t("catalogData.banners.b2Sub") };
  }
  return { title, subtitle };
}

/**
 * Translate role names & permission descriptions via catalogData.
 */
export function localizeRoleName(code: string, fallback: string, tryT: TryTFunc): string {
  return tryT(`catalogData.roles.${code}`, fallback);
}

export function localizePermissionDesc(code: string, fallback: string, tryT: TryTFunc): string {
  return tryT(`catalogData.permissions.${code.replace(/\./g, "_")}`, fallback);
}

/**
 * Translate report headers / KPI labels / P&L line names safely.
 */
export function localizeReportLabel(label: string, tryT: TryTFunc): string {
  return tryT(`reportsAdmin.labels.${label}`, label);
}

/**
 * Translate audit log entity codes safely.
 */
export function localizeAuditEntity(entity: string, tryT: TryTFunc): string {
  return tryT(`auditAdmin.entities.${entity}`, entity);
}

/**
 * Localize default walk-in counter customer label while keeping real customer names intact.
 */
export function localizeCustomerDisplayName(name: string, t: TFunc): string {
  return name.trim().toLowerCase() === "walk-in" ? t("ordersAdmin.walkInCounter") : name;
}

/**
 * Localize database-stored system/customer notification titles and messages into the active locale.
 */
export function localizeNotification(
  n: { title: string; message: string },
  t: TFunc,
  tryT: TryTFunc,
): { title: string; message: string } {
  let title = n.title;
  let message = n.message;

  const newOrder = title.match(/^New order (.+)$/);
  if (newOrder) {
    title = t("messages.notifNewOrder", { number: newOrder[1]! });
  } else if (/^New customer registered$/.test(title)) {
    title = t("messages.notifNewCustomer");
  } else {
    const rxNeeded = title.match(/^Prescription review needed [–-] (.+)$/);
    if (rxNeeded) {
      title = t("messages.notifRxNeeded", { number: rxNeeded[1]! });
    } else {
      const rxApproved = title.match(/^Prescription approved [–-] (.+)$/);
      if (rxApproved) {
        title = t("messages.notifRxApproved", { number: rxApproved[1]! });
      } else {
        const rxRejected = title.match(/^Prescription rejected [–-] (.+)$/);
        if (rxRejected) {
          title = t("messages.notifRxRejected", { number: rxRejected[1]! });
        } else {
          const orderCancelled = title.match(/^Order (.+) cancelled$/);
          if (orderCancelled) {
            title = t("messages.notifOrderCancelled", { number: orderCancelled[1]! });
          } else {
            const orderTitle = title.match(/^Order (.+)$/);
            if (orderTitle) {
              title = t("messages.notifOrderTitle", { number: orderTitle[1]! });
            } else {
              const payReceived = title.match(/^Payment received [–-] (.+)$/);
              if (payReceived) {
                title = t("messages.notifPaymentReceived", { number: payReceived[1]! });
              } else {
                const payFailed = title.match(/^Payment failed [–-] (.+)$/);
                if (payFailed) {
                  title = t("messages.notifPaymentFailed", { number: payFailed[1]! });
                } else {
                  const expired = title.match(/^Expired: (.+)$/);
                  if (expired) {
                    title = t("messages.notifExpiredBatch", { name: expired[1]! });
                  } else {
                    const expiringSoon = title.match(/^Expiring soon: (.+)$/);
                    if (expiringSoon) {
                      title = t("messages.notifExpiringSoon", { name: expiringSoon[1]! });
                    } else {
                      const lowStock = title.match(/^Low stock: (.+)$/);
                      if (lowStock) {
                        title = t("messages.notifLowStock", { name: lowStock[1]! });
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // Message localization
  if (message === "An order with prescription-only medicines is waiting for pharmacist review.") {
    message = t("messages.notifRxNeededMsg");
  } else if (message === "Thank you! Your order is confirmed.") {
    message = t("messages.notifPaymentReceivedMsg");
  } else if (message === "Your prescription was approved. You can now complete payment.") {
    message = t("messages.notifRxApprovedMsg");
  } else if (message === "Your prescription could not be approved.") {
    message = t("messages.notifRxRejectedMsg");
  } else {
    const statusMatch = message.match(/^Status: (.+)$/);
    if (statusMatch) {
      const code = statusMatch[1]!.trim().toUpperCase().replace(/\s+/g, "_");
      message = t("messages.notifOrderStatus", { status: tryT(`status.${code}`, statusMatch[1]!) });
    } else {
      const lowMatch = message.match(/^(\S+) has (-?\d+) units available \(minimum (\d+)\)\.$/);
      if (lowMatch) {
        message = t("messages.notifLowStockMsg", { sku: lowMatch[1]!, avail: lowMatch[2]!, min: lowMatch[3]! });
      } else {
        const expMatch = message.match(
          /^Batch (.+?) \((\d+) units\) (expired|expires) on (\d{2}\/\d{2}\/\d{4})\.(.*)$/,
        );
        if (expMatch) {
          message =
            expMatch[3] === "expired"
              ? t("messages.notifBatchExpiredMsg", { batch: expMatch[1]!, qty: expMatch[2]!, date: expMatch[4]! })
              : t("messages.notifBatchExpiringMsg", { batch: expMatch[1]!, qty: expMatch[2]!, date: expMatch[4]! });
        } else if (message.includes(" · Payment was received – refund required.")) {
          const prefix = message.replace(" · Payment was received – refund required.", "");
          message = `${translateApiError(prefix, t)} · ${t("messages.notifRefundRequiredSuffix")}`;
        }
      }
    }
  }

  return { title, message };
}

/** Exact-match mapping from common API & validation English error strings to i18n message keys. */
const EXACT_ERROR_MAP: Record<string, TKey> = {
  // Authentication & accounts
  "Invalid email/phone or password": "messages.invalidCredentials",
  "This account has been suspended. Please contact the pharmacy.": "messages.accountSuspended",
  "This account does not have staff access": "messages.noStaffAccess",
  "Too many login attempts. Please try again later.": "messages.rateLimited",
  "Too many requests": "messages.tooManyRequests",
  "Too many requests, please slow down.": "messages.tooManyRequests",
  "Too many uploads, please slow down.": "messages.tooManyUploads",
  "Email already registered": "messages.emailRegistered",
  "Email is already registered": "messages.emailRegistered",
  "Phone number already registered": "messages.phoneRegistered",
  "Phone number is already registered": "messages.phoneRegistered",
  "Phone number is already used by another account": "messages.phoneInUse",
  "Email or phone already in use": "messages.emailOrPhoneInUse",
  "Email or phone already used by another account": "messages.emailOrPhoneInUse",
  "Current password is incorrect": "messages.currentPasswordIncorrect",
  "Invalid or expired password reset link": "messages.invalidResetLink",
  "Authentication required": "messages.authRequired",
  "You do not have permission to perform this action": "messages.permissionDenied",
  "Only a Super Admin can manage Super Admin accounts": "messages.superAdminOnlyManage",
  "Only a Super Admin can assign the Super Admin role": "messages.superAdminOnlyAssign",
  "You cannot change your own role or suspend yourself": "messages.cannotModifySelf",
  "At least one active Super Admin is required": "messages.superAdminRequired",

  // Discounts, cart & checkout
  "Invalid discount code": "messages.invalidDiscount",
  "This discount code is not active yet": "messages.discountNotActive",
  "This discount code has expired": "messages.discountExpired",
  "This discount code has reached its usage limit": "messages.discountLimit",
  "Cart is empty": "messages.cartEmpty",
  "Some products are no longer available": "messages.productsUnavailable",
  "Prescription image is required for prescription medicines": "messages.rxRequiredOnline",
  "A prescription image is required for prescription-only medicines": "messages.rxRequiredOnline",
  "This prescription upload has already been linked to another order – please upload again": "messages.rxAlreadyLinked",
  "Prescription medicines must be dispensed by a pharmacist": "messages.rxPharmacistOnly",
  "Prescription-only medicines must be dispensed by a pharmacist": "messages.rxPharmacistOnly",
  "Enter a valid Cambodia phone number": "checkout.invalidPhone",
  "Enter a valid Cambodian phone number (+855)": "checkout.invalidPhone",

  // Orders & fulfilment
  "Order not found": "messages.orderNotFound",
  "Order must be paid before confirmation": "messages.orderMustBePaid",
  "Prescription must be approved first": "messages.rxMustBeApproved",
  "Order must be confirmed first": "messages.orderMustBeConfirmed",
  "Only confirmed orders can be fulfilled": "messages.onlyConfirmedFulfil",
  "No items have been fulfilled (picked from stock) yet": "messages.noItemsFulfilled",
  "Delivered orders cannot be cancelled": "messages.deliveredCannotCancel",
  "Order has been cancelled": "messages.orderCancelled",
  "Order is already paid": "messages.orderAlreadyPaid",
  "Enter at least one quantity to fulfil": "messages.enterQtyToFulfil",
  "Manual discounts require supervisor permission": "messages.manualDiscountSupervisor",
  "You cannot cancel orders": "messages.cannotCancelOrders",

  // Payments & gateways
  "Payment not found": "messages.paymentNotFound",
  "Not available": "pay.unavailable",
  "Payment method not available": "messages.paymentMethodUnavailable",
  "Selected USDT network is not available": "messages.usdtNetworkUnavailable",
  "Cash tendered is less than the amount due": "messages.cashLessThanDue",
  "No paid payment found for this order": "messages.noPaidPayment",
  "Only paid payments can be refunded": "messages.onlyPaidRefundable",
  "This transaction hash has already been used for another payment": "messages.txHashAlreadyUsed",
  "This transaction hash was submitted for another payment": "messages.txHashAlreadyUsed",
  "A payment is currently being verified for this order. Please wait.": "messages.paymentVerifying",
  "Waiting for pharmacist to review your prescription before payment": "messages.rxPendingPayment",
  "Prescription was rejected": "messages.rxRejected",
  "Enter the refund transaction reference (bank / blockchain) after sending the funds back": "messages.refundRefRequired",
  "Enter a valid 64-character hexadecimal transaction hash": "messages.invalidTxHash",
  "Bakong account not configured": "messages.bakongNotConfigured",
  "BAKONG_API_TOKEN missing – payments cannot be verified": "messages.bakongTokenMissing",
  "No USDT network fully configured": "messages.usdtNotConfigured",
  "PayPal credentials missing": "messages.paypalCredsMissing",

  // Inventory, purchases & catalog
  "Expiry date is required for this medicine": "messages.expiryRequired",
  "Expiry date is required for the opening batch": "messages.expiryRequired",
  "Cannot receive stock that is already expired": "messages.cannotReceiveExpired",
  "Opening batch cannot already be expired": "messages.cannotReceiveExpired",
  "You do not have permission to add opening stock": "messages.noOpeningStockPerm",
  "Enter at least one received quantity": "messages.enterQtyToReceive",
  "Only purchase orders with no received stock can be cancelled": "messages.onlyUnreceivedPoCancel",
  "Each medicine can only appear once": "messages.duplicateMedicinePo",
  "Supplier has open purchase orders": "messages.supplierHasOpenPos",

  // Not found / generic / upload / bot
  "Not found": "messages.notFound",
  "Record not found": "messages.recordNotFound",
  "Record is referenced by other data": "messages.recordInUse",
  "Already exists": "messages.alreadyExists",
  "Address not found": "messages.addressNotFound",
  "Product not found": "messages.productNotFound",
  "Category not found": "messages.categoryNotFound",
  "Brand not found": "messages.brandNotFound",
  "Supplier not found": "messages.supplierNotFound",
  "Medicine not found": "messages.medicineNotFound",
  "Batch not found": "messages.batchNotFound",
  "Discount not found": "messages.discountNotFound",
  "Customer not found": "messages.customerNotFound",
  "File too large": "messages.fileTooLarge",
  "File too large (max 5 MB)": "messages.fileTooLarge",
  "No file uploaded": "messages.noFileUploaded",
  "Human verification required": "security.required",
  "Human verification failed": "security.required",
  "Invalid input": "messages.invalidInput",
  "Invalid request parameters": "messages.invalidInput",
  "Something went wrong": "common.error",
  "Something went wrong. Please try again.": "common.error",
  "This service is temporarily unavailable. Please try again later.": "messages.serviceUnavailable",

  // Common Zod form validation messages
  "Invalid email": "common.invalidEmail",
  "Name is required": "messages.nameRequired",
  "Full name is required": "messages.fullNameRequired",
  "District is required": "messages.districtRequired",
  "Province is required": "messages.provinceRequired",
  "Select a valid Cambodian province": "messages.validProvince",
  "Enter email or phone": "messages.emailOrPhoneRequired",
  "Password is required": "messages.passwordRequired",
  "Password must be at least 8 characters": "messages.passwordMin8",
  "Password must contain a letter": "messages.passwordNeedLetter",
  "Password must contain a number": "messages.passwordNeedNumber",
  "Reason is required": "messages.reasonRequired",
  "SKU is required": "messages.skuRequired",
  "SKU may contain letters, numbers, - _ .": "messages.skuInvalid",
  "Batch number is required": "messages.batchRequired",
  "Invalid batch number": "messages.batchInvalid",
  "Code must be at least 3 characters": "messages.codeMin3",
  "Letters, numbers, - and _ only": "messages.codeInvalidChars",
  "Percentage cannot exceed 100": "messages.percentMax100",
  "Invalid or untrusted image URL": "messages.invalidImageUrl",
  "Invalid date": "messages.invalidDate",
  "Must be a valid number": "messages.invalidNumber",
  "Price must be greater than 0": "messages.pricePositive",
  "Select at least one currency": "messages.selectCurrency",
  "Invalid wallet address format": "messages.invalidWalletFormat",
  "Invalid contract address format": "messages.invalidContractFormat",
  "Merchant name is required": "messages.merchantNameRequired",
  "Merchant city is required": "messages.merchantCityRequired",
  "Brand name is required": "messages.brandNameRequired",
  "Supplier name is required": "messages.supplierNameRequired",
  "English name is required": "messages.englishNameRequired",
  "Khmer name is required": "messages.khmerNameRequired",
  "English title is required": "messages.englishTitleRequired",
  "Khmer title is required": "messages.khmerTitleRequired",
};

/**
 * Translate common server/API/validation error messages into the active locale.
 */
export function translateApiError(msg: string | null | undefined, t: TFunc): string {
  if (!msg) return t("common.error");
  const trimmed = msg.trim();
  const exact = EXACT_ERROR_MAP[trimmed];
  if (exact) return t(exact);

  const minOrderMatch = trimmed.match(/^Minimum order of \$([0-9.]+) required for this code$/);
  if (minOrderMatch) {
    return t("messages.discountMinOrder", { amount: minOrderMatch[1]! });
  }
  const stockMatch = trimmed.match(/^Insufficient stock for (.+): requested (\d+), available (\d+)$/);
  if (stockMatch) {
    return t("messages.insufficientStock", { item: stockMatch[1]!, req: stockMatch[2]!, avail: stockMatch[3]! });
  }
  const catInUse = trimmed.match(/^Category has (\d+) medicine\(s\)\. Move them to another category first\.$/);
  if (catInUse) {
    return t("messages.categoryInUse", { n: catInUse[1]! });
  }
  const brandInUse = trimmed.match(/^Brand is used by (\d+) medicine\(s\)$/);
  if (brandInUse) {
    return t("messages.brandInUse", { n: brandInUse[1]! });
  }
  const maxAddr = trimmed.match(/^You can save at most (\d+) addresses$/);
  if (maxAddr) {
    return t("messages.maxAddresses", { n: maxAddr[1]! });
  }
  const reservedMatch = trimmed.match(/^Cannot reduce below reserved quantity \((\d+) units are reserved for orders\)$/);
  if (reservedMatch) {
    return t("messages.belowReservedQty", { n: reservedMatch[1]! });
  }
  const recvExceed = trimmed.match(/^(.+): cannot receive (\d+), only (\d+) outstanding$/);
  if (recvExceed) {
    return t("messages.exceedsOutstanding", { name: recvExceed[1]!, qty: recvExceed[2]!, rem: recvExceed[3]! });
  }
  const medExpiry = trimmed.match(/^(.+): expiry date is required$/);
  if (medExpiry) {
    return t("messages.medExpiryRequired", { name: medExpiry[1]! });
  }
  const medExpired = trimmed.match(/^(.+): stock is already expired$/);
  if (medExpired) {
    return t("messages.medAlreadyExpired", { name: medExpired[1]! });
  }
  const alreadyExistsField = trimmed.match(/^Already exists \((.+)\)$/);
  if (alreadyExistsField) {
    return t("messages.alreadyExistsField", { field: alreadyExistsField[1]! });
  }
  if (/^Invalid .+ transaction hash format$/.test(trimmed)) {
    return t("messages.invalidTxHash");
  }
  return trimmed;
}
