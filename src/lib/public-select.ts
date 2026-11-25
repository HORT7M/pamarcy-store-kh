/**
 * Prisma `select` allow-lists for fields a client is allowed to receive.
 * Prefer these over `include` / bare model returns so new DB columns never leak by default.
 */
export const addressSelect = {
  id: true, label: true, fullName: true, phone: true, province: true, district: true,
  commune: true, village: true, street: true, instructions: true, isDefault: true,
} as const;
