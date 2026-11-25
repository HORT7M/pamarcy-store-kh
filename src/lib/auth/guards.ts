import "server-only";
import { redirect } from "next/navigation";
import { getCurrentUser, type SessionUser } from "./session";
import { roleHas, type Permission } from "./permissions";

/**
 * Server-Component page guard for Admin routes.
 * Re-validates the DB session, staff role, and permission on every page render
 * (never relies on Edge middleware or layout alone) and redirects cleanly instead of
 * throwing an unhandled 500 error on unauthorized navigation.
 */
export async function requireStaffPage(perm?: Permission): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/admin/login");
  if (!user.isStaff) redirect("/");
  if (perm && !roleHas(user.role, perm)) {
    redirect(perm === "dashboard.view" ? "/" : "/admin");
  }
  return user;
}

/** Server-Component page guard requiring at least one of the specified staff permissions. */
export async function requireStaffAnyPage(perms: readonly Permission[]): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/admin/login");
  if (!user.isStaff) redirect("/");
  if (!perms.some((perm) => roleHas(user.role, perm))) {
    redirect("/admin");
  }
  return user;
}

/**
 * Server-Component page guard for Customer Account routes.
 * Re-validates the DB session and enforces non-staff customer ownership on every page.
 */
export async function requireCustomerPage(): Promise<SessionUser & { customerId: string }> {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/account");
  if (user.isStaff) redirect("/admin");
  if (!user.customerId) redirect("/");
  return user as SessionUser & { customerId: string };
}
