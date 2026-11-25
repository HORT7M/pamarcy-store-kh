/** Single source of truth for roles & permissions (seeded into DB; enforced server-side). */
export const PERMISSIONS = {
  "dashboard.view": "View admin dashboard",
  "medicines.read": "View medicines",
  "medicines.write": "Create / edit medicines",
  "medicines.delete": "Delete medicines",
  "categories.write": "Manage categories & brands",
  "inventory.read": "View inventory, batches, expiry",
  "inventory.write": "Stock in / out / adjust",
  "suppliers.read": "View suppliers",
  "suppliers.write": "Manage suppliers",
  "purchases.read": "View purchase orders",
  "purchases.write": "Create / receive purchase orders",
  "orders.read": "View orders",
  "orders.write": "Update order status / fulfil",
  "orders.cancel": "Cancel orders",
  "orders.refund": "Refund payments",
  "prescriptions.review": "Review prescription orders",
  "pos.use": "Use point of sale",
  "customers.read": "View customers",
  "customers.write": "Edit / suspend customers",
  "payments.read": "View payments",
  "discounts.write": "Manage discount codes & banners",
  "reports.view": "View & export reports",
  "settings.manage": "Manage store settings",
  "settings.payments": "Manage payment configuration",
  "users.manage": "Manage staff accounts",
  "audit.view": "View audit logs",
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export const ROLES = {
  SUPER_ADMIN: { name: "Super Admin", isStaff: true, permissions: ALL_PERMISSIONS },
  ADMIN: {
    name: "Admin",
    isStaff: true,
    permissions: ALL_PERMISSIONS.filter((p) => p !== "users.manage" && p !== "settings.payments"),
  },
  PHARMACIST: {
    name: "Pharmacist",
    isStaff: true,
    permissions: [
      "dashboard.view", "medicines.read", "medicines.write", "categories.write", "inventory.read",
      "orders.read", "orders.write", "prescriptions.review", "pos.use", "customers.read", "payments.read",
    ] as Permission[],
  },
  CASHIER: {
    name: "Cashier",
    isStaff: true,
    permissions: ["dashboard.view", "medicines.read", "pos.use", "orders.read", "customers.read", "payments.read"] as Permission[],
  },
  INVENTORY_STAFF: {
    name: "Inventory Staff",
    isStaff: true,
    permissions: [
      "dashboard.view", "medicines.read", "inventory.read", "inventory.write",
      "suppliers.read", "suppliers.write", "purchases.read", "purchases.write",
    ] as Permission[],
  },
  CUSTOMER: { name: "Customer", isStaff: false, permissions: [] as Permission[] },
} as const;

export type RoleKey = keyof typeof ROLES;

export function roleHas(role: string, perm: Permission): boolean {
  const r = ROLES[role as RoleKey];
  return !!r && (r.permissions as readonly string[]).includes(perm);
}
