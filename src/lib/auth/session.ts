import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { cache } from "react";
import { prisma } from "@/lib/db";
import { getAuthSecret } from "@/lib/env";
import { roleHas, type Permission, ROLES, type RoleKey } from "./permissions";
import { forbidden, unauthorized } from "@/lib/errors";

export const SESSION_COOKIE = "pamarcy_session";
export const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;

const DEFAULT_CUSTOMER_TTL_DAYS = 30;
const DEFAULT_CUSTOMER_IDLE_DAYS = 7;
const DEFAULT_CUSTOMER_ROTATE_MINUTES = 24 * 60; // 24h

const DEFAULT_STAFF_TTL_HOURS = 12;
const DEFAULT_STAFF_IDLE_MINUTES = 120; // 2h
const DEFAULT_STAFF_ROTATE_MINUTES = 60; // 1h

const MAX_STAFF_SESSIONS = 5;
const MAX_CUSTOMER_SESSIONS = 10;

const ROTATED_SUPPRESS_CLEAR_MS = 5_000;
const MAX_RECENTLY_ROTATED = 1_000;
const recentlyRotatedHashes = new Map<string, number>();

const mutableCookieContext = new AsyncLocalStorage<boolean>();

/** Marks an execution scope (Route Handler / Server Action) where `cookies().set(...)` is allowed. */
export function runWithMutableCookies<T>(fn: () => Promise<T>): Promise<T> {
  return mutableCookieContext.run(true, fn);
}

export function canMutateCookies(): boolean {
  return mutableCookieContext.getStore() === true;
}

function noteRecentlyRotated(tokenHash: string, nowMs: number) {
  if (recentlyRotatedHashes.size >= MAX_RECENTLY_ROTATED) {
    for (const [k, exp] of recentlyRotatedHashes) {
      if (exp <= nowMs) recentlyRotatedHashes.delete(k);
    }
    if (recentlyRotatedHashes.size >= MAX_RECENTLY_ROTATED) recentlyRotatedHashes.clear();
  }
  recentlyRotatedHashes.set(tokenHash, nowMs + ROTATED_SUPPRESS_CLEAR_MS);
}

function wasRecentlyRotated(tokenHash: string, nowMs: number): boolean {
  const exp = recentlyRotatedHashes.get(tokenHash);
  if (!exp) return false;
  if (exp <= nowMs) {
    recentlyRotatedHashes.delete(tokenHash);
    return false;
  }
  return true;
}

function posNum(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const getStaffTtlMs = () => posNum(process.env.SESSION_STAFF_TTL_HOURS, DEFAULT_STAFF_TTL_HOURS) * 3_600_000;
export const getStaffIdleMs = () => posNum(process.env.SESSION_STAFF_IDLE_MINUTES, DEFAULT_STAFF_IDLE_MINUTES) * 60_000;
export const getStaffRotateMs = () => posNum(process.env.SESSION_STAFF_ROTATE_MINUTES, DEFAULT_STAFF_ROTATE_MINUTES) * 60_000;

export const getCustomerTtlMs = () => posNum(process.env.SESSION_CUSTOMER_TTL_DAYS, DEFAULT_CUSTOMER_TTL_DAYS) * 86_400_000;
export const getCustomerIdleMs = () => posNum(process.env.SESSION_CUSTOMER_IDLE_DAYS, DEFAULT_CUSTOMER_IDLE_DAYS) * 86_400_000;
export const getCustomerRotateMs = () => posNum(process.env.SESSION_CUSTOMER_ROTATE_MINUTES, DEFAULT_CUSTOMER_ROTATE_MINUTES) * 60_000;

export function isValidSessionTokenFormat(token: string | null | undefined): token is string {
  return typeof token === "string" && SESSION_TOKEN_RE.test(token);
}

export function hashSessionToken(token: string): string {
  return createHmac("sha256", getAuthSecret()).update(token).digest("hex");
}

export function getSessionSameSite(): "lax" | "strict" {
  const raw = process.env.SESSION_COOKIE_SAMESITE?.trim().toLowerCase();
  return raw === "strict" ? "strict" : "lax";
}

/**
 * Determines whether the `Secure` attribute should be set on session cookies.
 * Always `true` in production (unless explicitly overridden via `COOKIE_SECURE=false`),
 * and automatically `true` whenever served over HTTPS (`x-forwarded-proto: https`,
 * RFC 7239 `Forwarded: proto=https`, or `https://` APP_URL).
 */
export function isSecureRequest(reqHeaders?: { get(name: string): string | null } | null): boolean {
  const explicit = process.env.COOKIE_SECURE?.trim().toLowerCase();
  if (explicit === "true" || explicit === "1") return true;
  if (explicit === "false" || explicit === "0") return false;
  if (process.env.NODE_ENV === "production") return true;
  const proto = reqHeaders?.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (proto === "https") return true;
  const forwarded = reqHeaders?.get("forwarded");
  if (forwarded && /(?:^|[;,\s])proto="?https"?(?:$|[;,\s])/i.test(forwarded)) return true;
  if ((process.env.APP_URL ?? "").trim().toLowerCase().startsWith("https://")) return true;
  return false;
}

export function buildSessionCookieOptions(expiresAt: Date, secure: boolean, nowMs = Date.now()) {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - nowMs) / 1000));
  return {
    httpOnly: true as const,
    secure,
    sameSite: getSessionSameSite(),
    path: "/",
    maxAge,
    expires: expiresAt,
  };
}

export function buildClearSessionCookieOptions(secure: boolean) {
  return {
    httpOnly: true as const,
    secure,
    sameSite: getSessionSameSite(),
    path: "/",
    maxAge: 0,
    expires: new Date(0),
  };
}

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: RoleKey;
  isStaff: boolean;
  customerId: string | null;
  permissions: Permission[];
};

function extractClientMeta(h: { get(name: string): string | null }) {
  const rawIp = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip")?.trim() || null;
  return {
    ip: rawIp ? rawIp.slice(0, 64) : null,
    userAgent: h.get("user-agent")?.slice(0, 250) ?? null,
  };
}

async function tryClearCookieInMutableContext() {
  if (!canMutateCookies()) return;
  try {
    const [jar, h] = await Promise.all([cookies(), headers()]);
    jar.set(SESSION_COOKIE, "", buildClearSessionCookieOptions(isSecureRequest(h)));
  } catch {
    /* ignore outside mutable cookie context */
  }
}

/**
 * Issues a new cryptographically random session token, invalidating any existing session token
 * on the request (session fixation protection) and enforcing per-user concurrent session caps.
 */
export async function createSession(userId: string, isStaff: boolean) {
  const [jar, h] = await Promise.all([cookies(), headers()]);
  const prevToken = jar.get(SESSION_COOKIE)?.value;
  const prevTokenHash = isValidSessionTokenFormat(prevToken) ? hashSessionToken(prevToken) : null;

  const nowMs = Date.now();
  const now = new Date(nowMs);
  const ttlMs = isStaff ? getStaffTtlMs() : getCustomerTtlMs();
  const idleMs = isStaff ? getStaffIdleMs() : getCustomerIdleMs();
  const maxSessions = isStaff ? MAX_STAFF_SESSIONS : MAX_CUSTOMER_SESSIONS;
  const expiresAt = new Date(nowMs + ttlMs);
  const token = randomBytes(32).toString("base64url");
  const { ip, userAgent } = extractClientMeta(h);

  // Invalidate any pre-existing session token and prune stale sessions for this user in one query
  await prisma.session.deleteMany({
    where: {
      OR: [
        ...(prevTokenHash ? [{ tokenHash: prevTokenHash }] : []),
        { userId, expiresAt: { lte: now } },
        { userId, lastSeenAt: { lte: new Date(nowMs - idleMs) } },
      ],
    },
  });
  const active = await prisma.session.findMany({
    where: { userId },
    orderBy: { lastSeenAt: "desc" },
    select: { id: true },
  });
  if (active.length >= maxSessions) {
    const excessIds = active.slice(maxSessions - 1).map((s) => s.id);
    if (excessIds.length) {
      await prisma.session.deleteMany({ where: { id: { in: excessIds } } });
    }
  }

  await Promise.all([
    prisma.session.create({
      data: {
        tokenHash: hashSessionToken(token),
        userId,
        scope: isStaff ? "admin" : "customer",
        ip,
        userAgent,
        createdAt: now,
        lastSeenAt: now,
        expiresAt,
      },
    }),
    prisma.user.update({ where: { id: userId }, data: { lastLoginAt: now } }),
  ]);

  jar.set(SESSION_COOKIE, token, buildSessionCookieOptions(expiresAt, isSecureRequest(h), nowMs));
}

/**
 * Explicitly rotates the current session token while preserving the original absolute `expiresAt`
 * deadline so session lifetime cannot be extended indefinitely. Old token is invalidated immediately.
 */
export async function rotateSession(): Promise<boolean> {
  const [jar, h] = await Promise.all([cookies(), headers()]);
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!isValidSessionTokenFormat(token)) return false;

  const oldTokenHash = hashSessionToken(token);
  const session = await prisma.session.findUnique({
    where: { tokenHash: oldTokenHash },
    include: { user: { select: { status: true, deletedAt: true, role: { select: { isStaff: true } } } } },
  });
  if (!session) return false;

  const nowMs = Date.now();
  const idleMs = session.scope === "admin" ? getStaffIdleMs() : getCustomerIdleMs();
  const expectedScope = session.user.role.isStaff ? "admin" : "customer";
  if (
    session.expiresAt.getTime() <= nowMs + 1_000 ||
    nowMs - session.lastSeenAt.getTime() >= idleMs ||
    session.user.status !== "ACTIVE" ||
    session.user.deletedAt !== null ||
    session.scope !== expectedScope
  ) {
    await prisma.session.deleteMany({ where: { id: session.id } }).catch(() => {});
    jar.set(SESSION_COOKIE, "", buildClearSessionCookieOptions(isSecureRequest(h)));
    return false;
  }

  const newToken = randomBytes(32).toString("base64url");
  const newTokenHash = hashSessionToken(newToken);
  const now = new Date(nowMs);
  const { ip, userAgent } = extractClientMeta(h);

  const rotated = await prisma.$transaction(async (tx) => {
    const del = await tx.session.deleteMany({ where: { id: session.id } });
    if (del.count !== 1) return false;
    await tx.session.create({
      data: {
        tokenHash: newTokenHash,
        userId: session.userId,
        scope: session.scope,
        ip,
        userAgent,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: session.expiresAt,
      },
    });
    return true;
  });

  if (rotated) {
    noteRecentlyRotated(oldTokenHash, nowMs);
    jar.set(SESSION_COOKIE, newToken, buildSessionCookieOptions(session.expiresAt, isSecureRequest(h), nowMs));
  }
  return rotated;
}

/**
 * Invalidates the active session in PostgreSQL (or all sessions for the user when `opts.all` is true)
 * and clears the browser session cookie with matching HttpOnly/Secure/SameSite attributes.
 */
export async function destroySession(opts?: { all?: boolean }): Promise<{ invalidated: boolean; userId: string | null; isStaff: boolean }> {
  const [jar, h] = await Promise.all([cookies(), headers()]);
  const token = jar.get(SESSION_COOKIE)?.value;
  let userId: string | null = null;
  let isStaff = false;
  let invalidated = false;

  if (isValidSessionTokenFormat(token)) {
    const tokenHash = hashSessionToken(token);
    const existing = await prisma.session.findUnique({
      where: { tokenHash },
      select: { userId: true, scope: true, user: { select: { role: { select: { isStaff: true } } } } },
    });
    if (existing) {
      userId = existing.userId;
      isStaff = existing.user.role.isStaff || existing.scope === "admin";
      const res = opts?.all
        ? await prisma.session.deleteMany({ where: { userId: existing.userId } })
        : await prisma.session.deleteMany({ where: { tokenHash } });
      invalidated = res.count > 0;
    }
  }

  jar.set(SESSION_COOKIE, "", buildClearSessionCookieOptions(isSecureRequest(h)));
  return { invalidated, userId, isStaff };
}

export async function destroyAllSessions(userId: string) {
  await prisma.session.deleteMany({ where: { userId } });
}

/** Prunes expired, idle-timed-out, and suspended/deleted user sessions from PostgreSQL. */
export async function pruneExpiredSessions(now = new Date()): Promise<number> {
  const nowMs = now.getTime();
  const staffIdleCutoff = new Date(nowMs - getStaffIdleMs());
  const customerIdleCutoff = new Date(nowMs - getCustomerIdleMs());
  const res = await prisma.session.deleteMany({
    where: {
      OR: [
        { expiresAt: { lte: now } },
        { scope: "admin", lastSeenAt: { lte: staffIdleCutoff } },
        { scope: "customer", lastSeenAt: { lte: customerIdleCutoff } },
        { user: { OR: [{ status: { not: "ACTIVE" } }, { deletedAt: { not: null } }] } },
      ],
    },
  });
  return res.count;
}

/** Current user (cached per request). Returns null when not signed in, idle/expired, or suspended. */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  if (!isValidSessionTokenFormat(token)) {
    await tryClearCookieInMutableContext();
    return null;
  }

  const nowMs = Date.now();
  const tokenHash = hashSessionToken(token);
  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: { user: { include: { role: true, customer: { select: { id: true } } } } },
  });
  if (!session) {
    // Reject immediately; skip clearing cookie only if this exact token was rotated moments ago
    // so an in-flight concurrent browser request cannot overwrite the freshly rotated cookie.
    if (!wasRecentlyRotated(tokenHash, nowMs)) {
      await tryClearCookieInMutableContext();
    }
    return null;
  }

  const isStaffSession = session.scope === "admin";
  const idleMs = isStaffSession ? getStaffIdleMs() : getCustomerIdleMs();
  const u = session.user;
  const expectedScope = u.role.isStaff ? "admin" : "customer";

  const expiredAbsolute = session.expiresAt.getTime() <= nowMs;
  const expiredIdle = nowMs - session.lastSeenAt.getTime() >= idleMs;
  const invalidUserOrScope = u.status !== "ACTIVE" || u.deletedAt !== null || session.scope !== expectedScope;

  if (expiredAbsolute || expiredIdle || invalidUserOrScope) {
    await prisma.session.deleteMany({ where: { id: session.id } }).catch(() => {});
    await tryClearCookieInMutableContext();
    return null;
  }

  const rotateMs = isStaffSession ? getStaffRotateMs() : getCustomerRotateMs();
  const tokenAgeMs = nowMs - session.createdAt.getTime();
  const touchThresholdMs = Math.min(300_000, Math.max(1_000, Math.floor(idleMs / 2)));

  if (canMutateCookies() && tokenAgeMs >= rotateMs && session.expiresAt.getTime() - nowMs > 1_000) {
    try {
      const h = await headers();
      const newToken = randomBytes(32).toString("base64url");
      const newTokenHash = hashSessionToken(newToken);
      const now = new Date(nowMs);
      const { ip, userAgent } = extractClientMeta(h);

      const rotated = await prisma.$transaction(async (tx) => {
        const del = await tx.session.deleteMany({ where: { id: session.id } });
        if (del.count !== 1) return false;
        await tx.session.create({
          data: {
            tokenHash: newTokenHash,
            userId: session.userId,
            scope: session.scope,
            ip,
            userAgent,
            createdAt: now,
            lastSeenAt: now,
            expiresAt: session.expiresAt,
          },
        });
        return true;
      });

      if (rotated) {
        noteRecentlyRotated(tokenHash, nowMs);
        jar.set(SESSION_COOKIE, newToken, buildSessionCookieOptions(session.expiresAt, isSecureRequest(h), nowMs));
      }
    } catch {
      /* non-fatal if rotation loses a concurrent race */
    }
  } else if (nowMs - session.lastSeenAt.getTime() >= touchThresholdMs) {
    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date(nowMs) } }).catch(() => {});
  }

  const role = u.role.key as RoleKey;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    role,
    isStaff: u.role.isStaff,
    customerId: u.customer?.id ?? null,
    permissions: [...(ROLES[role]?.permissions ?? [])],
  };
});

export async function requireUser(): Promise<SessionUser> {
  const u = await getCurrentUser();
  if (!u) throw unauthorized();
  return u;
}

export async function requireCustomer(): Promise<SessionUser & { customerId: string }> {
  const u = await requireUser();
  if (u.isStaff || !u.customerId) throw forbidden("Customer account required");
  return u as SessionUser & { customerId: string };
}

export async function requireStaff(perm?: Permission): Promise<SessionUser> {
  const u = await requireUser();
  if (!u.isStaff) throw forbidden();
  if (perm && !roleHas(u.role, perm)) throw forbidden();
  return u;
}

export async function requireStaffAny(perms: readonly Permission[]): Promise<SessionUser> {
  const u = await requireUser();
  if (!u.isStaff) throw forbidden();
  if (!perms.some((perm) => roleHas(u.role, perm))) throw forbidden();
  return u;
}

export function can(u: SessionUser | null, perm: Permission) {
  return !!u && u.isStaff && roleHas(u.role, perm);
}

export function canAny(u: SessionUser | null, perms: readonly Permission[]) {
  return !!u && u.isStaff && perms.some((perm) => roleHas(u.role, perm));
}
