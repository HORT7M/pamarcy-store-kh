import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { prisma } from "../../src/lib/db.ts";
import { hashPassword } from "../../src/lib/auth/password.ts";
import {
  SESSION_COOKIE,
  SESSION_TOKEN_RE,
  buildClearSessionCookieOptions,
  buildSessionCookieOptions,
  getCustomerIdleMs,
  getCustomerRotateMs,
  getCustomerTtlMs,
  getSessionSameSite,
  getStaffIdleMs,
  getStaffRotateMs,
  getStaffTtlMs,
  hashSessionToken,
  isSecureRequest,
  isValidSessionTokenFormat,
  pruneExpiredSessions,
} from "../../src/lib/auth/session.ts";

if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}

const APP = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");

type ParsedCookie = {
  raw: string;
  name: string;
  value: string;
  attrs: Map<string, string | true>;
};

function parseSessionSetCookie(res: Response): ParsedCookie | null {
  const all = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")!] : []);
  const target = all.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!target) return null;
  const parts = target.split(";").map((p) => p.trim()).filter(Boolean);
  const [nameVal, ...rest] = parts;
  const eq = nameVal.indexOf("=");
  const name = nameVal.slice(0, eq);
  const value = nameVal.slice(eq + 1);
  const attrs = new Map<string, string | true>();
  for (const attr of rest) {
    const i = attr.indexOf("=");
    if (i === -1) attrs.set(attr.toLowerCase(), true);
    else attrs.set(attr.slice(0, i).trim().toLowerCase(), attr.slice(i + 1).trim());
  }
  return { raw: target, name, value, attrs };
}

function assertClearCookie(c: ParsedCookie | null, opts?: { expectSecure?: boolean }) {
  assert.ok(c, "Expected Set-Cookie header clearing pamarcy_session");
  assert.equal(c.name, SESSION_COOKIE);
  assert.equal(c.value, "", "Cleared cookie must have empty value");
  assert.equal(c.attrs.get("httponly"), true, "Cleared cookie must retain HttpOnly");
  assert.equal(c.attrs.get("path"), "/", "Cleared cookie must retain Path=/");
  assert.equal(String(c.attrs.get("samesite") ?? "").toLowerCase(), "lax", "Cleared cookie must retain SameSite");
  assert.equal(c.attrs.get("max-age"), "0", "Cleared cookie must set Max-Age=0");
  assert.equal(c.attrs.has("domain"), false, "Cleared cookie must stay host-only (no Domain)");
  if (opts?.expectSecure !== undefined) {
    assert.equal(c.attrs.get("secure") === true, opts.expectSecure, `Cleared cookie Secure attribute mismatch`);
  }
}

describe("Cookie security configuration & token format helpers", () => {
  it("computes Secure attribute accurately across NODE_ENV, proxies, APP_URL, and overrides", () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origCookieSecure = process.env.COOKIE_SECURE;
    const origAppUrl = process.env.APP_URL;
    const env = process.env as Record<string, string | undefined>;
    try {
      delete env.COOKIE_SECURE;
      env.NODE_ENV = "development";
      env.APP_URL = "http://localhost:3000";

      assert.equal(isSecureRequest(new Headers()), false);
      assert.equal(isSecureRequest(new Headers({ "x-forwarded-proto": "https" })), true);
      assert.equal(isSecureRequest(new Headers({ "x-forwarded-proto": "https, http" })), true);
      assert.equal(isSecureRequest(new Headers({ forwarded: "for=192.0.2.1;proto=https" })), true);

      env.APP_URL = "https://pamarcy.com.kh";
      assert.equal(isSecureRequest(new Headers()), true);

      env.APP_URL = "http://localhost:3000";
      env.NODE_ENV = "production";
      assert.equal(isSecureRequest(new Headers()), true);

      env.COOKIE_SECURE = "false";
      assert.equal(isSecureRequest(new Headers({ "x-forwarded-proto": "https" })), false);

      env.NODE_ENV = "development";
      env.COOKIE_SECURE = "true";
      assert.equal(isSecureRequest(new Headers()), true);
    } finally {
      env.NODE_ENV = origNodeEnv;
      if (origCookieSecure === undefined) delete env.COOKIE_SECURE;
      else env.COOKIE_SECURE = origCookieSecure;
      if (origAppUrl === undefined) delete env.APP_URL;
      else env.APP_URL = origAppUrl;
    }
  });

  it("configures HttpOnly, Secure, SameSite, Path, Max-Age, and Expires on issue and clear options", () => {
    const origSameSite = process.env.SESSION_COOKIE_SAMESITE;
    try {
      delete process.env.SESSION_COOKIE_SAMESITE;
      assert.equal(getSessionSameSite(), "lax");

      const nowMs = Date.now();
      const exp = new Date(nowMs + 3_600_000);
      const setOpts = buildSessionCookieOptions(exp, true, nowMs);
      assert.equal(setOpts.httpOnly, true);
      assert.equal(setOpts.secure, true);
      assert.equal(setOpts.sameSite, "lax");
      assert.equal(setOpts.path, "/");
      assert.equal(setOpts.maxAge, 3600);
      assert.equal(setOpts.expires.getTime(), exp.getTime());
      assert.equal("domain" in setOpts, false);

      process.env.SESSION_COOKIE_SAMESITE = "strict";
      assert.equal(getSessionSameSite(), "strict");
      const strictClear = buildClearSessionCookieOptions(true);
      assert.equal(strictClear.httpOnly, true);
      assert.equal(strictClear.secure, true);
      assert.equal(strictClear.sameSite, "strict");
      assert.equal(strictClear.path, "/");
      assert.equal(strictClear.maxAge, 0);
      assert.equal(strictClear.expires.getTime(), 0);

      process.env.SESSION_COOKIE_SAMESITE = "none"; // unsafe value must never be accepted
      assert.equal(getSessionSameSite(), "lax");
    } finally {
      if (origSameSite === undefined) delete process.env.SESSION_COOKIE_SAMESITE;
      else process.env.SESSION_COOKIE_SAMESITE = origSameSite;
    }
  });

  it("validates token format, HMAC-SHA256 hashing, and default TTL / idle / rotation windows", () => {
    const valid = randomBytes(32).toString("base64url");
    assert.equal(SESSION_TOKEN_RE.test(valid), true);
    assert.equal(isValidSessionTokenFormat(valid), true);
    assert.equal(isValidSessionTokenFormat(""), false);
    assert.equal(isValidSessionTokenFormat("short"), false);
    assert.equal(isValidSessionTokenFormat("a".repeat(65)), false);
    assert.equal(isValidSessionTokenFormat(`${valid.slice(0, 40)}!@#`), false);
    assert.equal(isValidSessionTokenFormat(null), false);

    const hash1 = hashSessionToken(valid);
    const hash2 = hashSessionToken(valid);
    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64);
    assert.match(hash1, /^[a-f0-9]{64}$/);
    assert.notEqual(hash1, valid);

    assert.ok(getStaffTtlMs() > 0);
    assert.ok(getStaffIdleMs() > 0 && getStaffIdleMs() <= getStaffTtlMs());
    assert.ok(getStaffRotateMs() > 0 && getStaffRotateMs() <= getStaffIdleMs());
    assert.ok(getCustomerTtlMs() > 0);
    assert.ok(getCustomerIdleMs() > 0 && getCustomerIdleMs() <= getCustomerTtlMs());
    assert.ok(getCustomerRotateMs() > 0 && getCustomerRotateMs() <= getCustomerIdleMs());
  });

  it("ensures non-session preference cookies set Path=/, SameSite=Lax, and conditional Secure on HTTPS", () => {
    const provider = readFileSync("src/components/providers/i18n-provider.tsx", "utf8");
    assert.match(provider, /SameSite=Lax/);
    assert.match(provider, /Path=\//);
    assert.match(provider, /window\.location\.protocol === "https:"/);
    assert.match(provider, /; Secure/);
  });
});

describe("Session lifecycle, expiration, rotation, and logout invalidation (E2E)", () => {
  const tag = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
  const staffEmail = `session-staff-${tag}@pamarcy.test`;
  const staff2Email = `session-staff2-${tag}@pamarcy.test`;
  const customerEmail = `session-cust-${tag}@pamarcy.test`;
  const staffPhone = `+85598${String(Math.floor(100000 + Math.random() * 899999))}`;
  const staff2Phone = `+85596${String(Math.floor(100000 + Math.random() * 899999))}`;
  const customerPhone = `+85597${String(Math.floor(100000 + Math.random() * 899999))}`;
  const initialPassword = `SecT3st!${randomBytes(6).toString("hex")}`;
  const rotatedPassword = `NewP4ss!${randomBytes(6).toString("hex")}`;

  let staffUserId = "";
  let staff2UserId = "";
  let customerUserId = "";
  let serverAvailable = false;

  before(async () => {
    const [cashierRole, customerRole] = await Promise.all([
      prisma.role.findUniqueOrThrow({ where: { key: "CASHIER" } }),
      prisma.role.findUniqueOrThrow({ where: { key: "CUSTOMER" } }),
    ]);
    const pwHash = await hashPassword(initialPassword);

    const staff = await prisma.user.create({
      data: {
        name: "Session Audit Staff",
        email: staffEmail,
        phone: staffPhone,
        passwordHash: pwHash,
        roleId: cashierRole.id,
        employee: { create: { employeeCode: `EMP-SEC-${tag.toUpperCase()}`, position: "Cashier" } },
      },
    });
    staffUserId = staff.id;

    const staff2 = await prisma.user.create({
      data: {
        name: "Session Audit Staff 2",
        email: staff2Email,
        phone: staff2Phone,
        passwordHash: pwHash,
        roleId: cashierRole.id,
        employee: { create: { employeeCode: `EMP-SEC2-${tag.toUpperCase()}`, position: "Cashier" } },
      },
    });
    staff2UserId = staff2.id;

    const cust = await prisma.user.create({
      data: {
        name: "Session Audit Customer",
        email: customerEmail,
        phone: customerPhone,
        passwordHash: pwHash,
        roleId: customerRole.id,
        customer: { create: {} },
      },
    });
    customerUserId = cust.id;

    try {
      const probe = await fetch(`${APP}/api/auth/me`);
      serverAvailable = probe.status === 200;
    } catch {
      serverAvailable = false;
    }
  });

  after(async () => {
    const ids = [staffUserId, staff2UserId, customerUserId].filter(Boolean);
    if (ids.length) {
      await prisma.auditLog.deleteMany({ where: { userId: { in: ids } } });
      await prisma.session.deleteMany({ where: { userId: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.$disconnect();
  });

  it("prunes expired, idle-timed-out, and suspended sessions while keeping active ones", async () => {
    const now = Date.now();
    const keepToken = randomBytes(32).toString("base64url");
    const absExpiredToken = randomBytes(32).toString("base64url");
    const staffIdleToken = randomBytes(32).toString("base64url");
    const custIdleToken = randomBytes(32).toString("base64url");

    await prisma.session.createMany({
      data: [
        {
          tokenHash: hashSessionToken(keepToken),
          userId: staffUserId,
          scope: "admin",
          createdAt: new Date(now - 60_000),
          lastSeenAt: new Date(now - 30_000),
          expiresAt: new Date(now + 3_600_000),
        },
        {
          tokenHash: hashSessionToken(absExpiredToken),
          userId: staffUserId,
          scope: "admin",
          createdAt: new Date(now - 7_200_000),
          lastSeenAt: new Date(now - 60_000),
          expiresAt: new Date(now - 1_000),
        },
        {
          tokenHash: hashSessionToken(staffIdleToken),
          userId: staffUserId,
          scope: "admin",
          createdAt: new Date(now - getStaffIdleMs() - 60_000),
          lastSeenAt: new Date(now - getStaffIdleMs() - 10_000),
          expiresAt: new Date(now + 3_600_000),
        },
        {
          tokenHash: hashSessionToken(custIdleToken),
          userId: customerUserId,
          scope: "customer",
          createdAt: new Date(now - getCustomerIdleMs() - 60_000),
          lastSeenAt: new Date(now - getCustomerIdleMs() - 10_000),
          expiresAt: new Date(now + 86_400_000),
        },
      ],
    });

    const pruned = await pruneExpiredSessions(new Date(now));
    assert.ok(pruned >= 3, `Expected at least 3 stale sessions pruned, got ${pruned}`);

    const remaining = await prisma.session.findMany({
      where: { userId: { in: [staffUserId, customerUserId] } },
    });
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].tokenHash, hashSessionToken(keepToken));

    await prisma.session.deleteMany({ where: { userId: { in: [staffUserId, customerUserId] } } });
  });

  async function loginHttp(identifier: string, password: string, scope: "admin" | "customer", extraHeaders: Record<string, string> = {}) {
    const res = await fetch(`${APP}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: APP,
        ...extraHeaders,
      },
      body: JSON.stringify({ identifier, password, scope }),
    });
    const cookie = parseSessionSetCookie(res);
    return { res, cookie };
  }

  it("sets hardened HttpOnly/SameSite/Path/Max-Age/Secure cookie attributes & no-store headers on login", async (t) => {
    if (!serverAvailable) return t.skip(`Server not reachable at ${APP}`);

    // 1. Staff login over HTTP localhost
    const { res: staffRes, cookie: staffCookie } = await loginHttp(staffEmail, initialPassword, "admin", {
      "X-Forwarded-For": "10.0.1.1",
    });
    assert.equal(staffRes.status, 200);
    assert.ok(staffCookie, "Expected pamarcy_session Set-Cookie on staff login");
    assert.equal(isValidSessionTokenFormat(staffCookie.value), true);
    assert.equal(staffCookie.attrs.get("httponly"), true, "Session cookie must be HttpOnly");
    assert.equal(staffCookie.attrs.get("path"), "/", "Session cookie must be Path=/");
    assert.equal(String(staffCookie.attrs.get("samesite") ?? "").toLowerCase(), "lax");
    assert.equal(staffCookie.attrs.has("domain"), false, "Session cookie must be host-only (no Domain)");
    assert.ok(staffCookie.attrs.has("expires"), "Session cookie must include Expires");
    const staffMaxAge = Number(staffCookie.attrs.get("max-age"));
    assert.ok(staffMaxAge >= 11 * 3600 && staffMaxAge <= 12 * 3600 + 60, `Expected ~12h Max-Age for staff, got ${staffMaxAge}`);

    const cc = staffRes.headers.get("cache-control") ?? "";
    assert.match(cc, /no-store/i, "Auth response must set Cache-Control: no-store");
    assert.match(staffRes.headers.get("vary") ?? "", /cookie/i, "Auth response must vary on Cookie");

    // Verify /api/auth/me sets private, no-store and Vary: Cookie
    const meCheck = await fetch(`${APP}/api/auth/me`, { headers: { Cookie: `${SESSION_COOKIE}=${staffCookie.value}` } });
    assert.equal(meCheck.status, 200);
    assert.match(meCheck.headers.get("cache-control") ?? "", /private/i);
    assert.match(meCheck.headers.get("cache-control") ?? "", /no-store/i);
    assert.match(meCheck.headers.get("vary") ?? "", /cookie/i);

    // Verify DB stores ONLY HMAC-SHA256 hash, never raw token
    const dbRow = await prisma.session.findUnique({ where: { tokenHash: hashSessionToken(staffCookie.value) } });
    assert.ok(dbRow, "Session row must exist keyed by HMAC-SHA256 tokenHash");
    assert.equal(dbRow.scope, "admin");
    assert.notEqual(dbRow.tokenHash, staffCookie.value);

    // 2. Staff login behind HTTPS reverse proxy -> Secure attribute MUST be set
    const { res: httpsRes, cookie: httpsCookie } = await loginHttp(staffEmail, initialPassword, "admin", {
      "X-Forwarded-Proto": "https",
      "X-Forwarded-For": "10.0.1.2",
    });
    assert.equal(httpsRes.status, 200);
    assert.ok(httpsCookie);
    assert.equal(httpsCookie.attrs.get("secure"), true, "HTTPS request must set Secure attribute on session cookie");
    assert.equal(httpsCookie.attrs.get("httponly"), true);

    // 3. Customer login -> ~30 day TTL & customer scope
    const { res: custRes, cookie: custCookie } = await loginHttp(customerEmail, initialPassword, "customer", {
      "X-Forwarded-For": "10.0.1.3",
    });
    assert.equal(custRes.status, 200);
    assert.ok(custCookie);
    assert.equal(custCookie.attrs.get("httponly"), true);
    assert.equal(String(custCookie.attrs.get("samesite") ?? "").toLowerCase(), "lax");
    const custMaxAge = Number(custCookie.attrs.get("max-age"));
    assert.ok(custMaxAge >= 29 * 86400 && custMaxAge <= 30 * 86400 + 60, `Expected ~30d Max-Age for customer, got ${custMaxAge}`);

    await prisma.session.deleteMany({ where: { userId: { in: [staffUserId, customerUserId] } } });
  });

  it("prevents session fixation by invalidating pre-existing cookies on login and rotating to a new token", async (t) => {
    if (!serverAvailable) return t.skip(`Server not reachable at ${APP}`);

    const { res: r1, cookie: c1 } = await loginHttp(staffEmail, initialPassword, "admin", { "X-Forwarded-For": "10.0.2.1" });
    assert.equal(r1.status, 200);
    assert.ok(c1);

    // Send pre-existing session cookie on a new login request
    const { res: r2, cookie: c2 } = await loginHttp(staffEmail, initialPassword, "admin", {
      "X-Forwarded-For": "10.0.2.2",
      Cookie: `${SESSION_COOKIE}=${c1.value}`,
    });
    assert.equal(r2.status, 200);
    assert.ok(c2);
    assert.notEqual(c2.value, c1.value, "Login must rotate to a brand-new session token");

    // Old token must be deleted from DB and rejected immediately
    const oldRow = await prisma.session.findUnique({ where: { tokenHash: hashSessionToken(c1.value) } });
    assert.equal(oldRow, null, "Pre-login session must be removed from DB");
    const replayOld = await fetch(`${APP}/api/admin/pos/methods`, { headers: { Cookie: `${SESSION_COOKIE}=${c1.value}` } });
    assert.equal(replayOld.status, 401);

    // New token must succeed
    const useNew = await fetch(`${APP}/api/admin/pos/methods`, { headers: { Cookie: `${SESSION_COOKIE}=${c2.value}` } });
    assert.equal(useNew.status, 200);

    await prisma.session.deleteMany({ where: { userId: staffUserId } });
  });

  it("rotates aged sessions automatically while preserving absolute expiresAt and invalidating old tokens", async (t) => {
    if (!serverAvailable) return t.skip(`Server not reachable at ${APP}`);

    const { res: loginRes, cookie: initialCookie } = await loginHttp(staffEmail, initialPassword, "admin", {
      "X-Forwarded-For": "10.0.3.1",
    });
    assert.equal(loginRes.status, 200);
    assert.ok(initialCookie);

    const oldHash = hashSessionToken(initialCookie.value);
    const beforeRow = await prisma.session.findUniqueOrThrow({ where: { tokenHash: oldHash } });
    const originalExpiresAt = beforeRow.expiresAt.getTime();

    // Age createdAt past staff rotation window (60m), keep lastSeenAt fresh
    await prisma.session.update({
      where: { id: beforeRow.id },
      data: { createdAt: new Date(Date.now() - getStaffRotateMs() - 60_000), lastSeenAt: new Date() },
    });

    const meRes = await fetch(`${APP}/api/auth/me`, {
      headers: { Cookie: `${SESSION_COOKIE}=${initialCookie.value}` },
    });
    assert.equal(meRes.status, 200);
    const meJson = (await meRes.json()) as { user: { id: string } | null };
    assert.equal(meJson.user?.id, staffUserId);

    const rotatedCookie = parseSessionSetCookie(meRes);
    assert.ok(rotatedCookie, "Expected periodic session rotation to issue a new Set-Cookie");
    assert.notEqual(rotatedCookie.value, initialCookie.value);
    assert.equal(rotatedCookie.attrs.get("httponly"), true);
    assert.equal(rotatedCookie.attrs.get("path"), "/");
    assert.equal(String(rotatedCookie.attrs.get("samesite") ?? "").toLowerCase(), "lax");

    // Verify original absolute expiresAt is preserved (not extended!)
    const afterRow = await prisma.session.findUniqueOrThrow({ where: { tokenHash: hashSessionToken(rotatedCookie.value) } });
    assert.equal(afterRow.expiresAt.getTime(), originalExpiresAt, "Rotation must preserve original absolute expiresAt");

    // Old token must be immediately invalidated in DB and rejected on replay
    const oldStillThere = await prisma.session.findUnique({ where: { tokenHash: oldHash } });
    assert.equal(oldStillThere, null);
    const replayOld = await fetch(`${APP}/api/admin/pos/methods`, {
      headers: { Cookie: `${SESSION_COOKIE}=${initialCookie.value}` },
    });
    assert.equal(replayOld.status, 401);

    // New rotated token must work
    const useRotated = await fetch(`${APP}/api/admin/pos/methods`, {
      headers: { Cookie: `${SESSION_COOKIE}=${rotatedCookie.value}` },
    });
    assert.equal(useRotated.status, 200);

    await prisma.session.deleteMany({ where: { userId: staffUserId } });
  });

  it("enforces absolute expiration, idle timeout, scope integrity, suspension, malformed cookie rejection, and edge redirects", async (t) => {
    if (!serverAvailable) return t.skip(`Server not reachable at ${APP}`);

    // 1. Malformed cookie -> rejected & cleared by API + Edge middleware
    const badApi = await fetch(`${APP}/api/admin/pos/methods`, {
      headers: { Cookie: `${SESSION_COOKIE}=bad!malformed` },
    });
    assert.equal(badApi.status, 401);
    assertClearCookie(parseSessionSetCookie(badApi));

    const edgeAdmin = await fetch(`${APP}/admin/orders?foo=bar`, {
      redirect: "manual",
      headers: { Cookie: `${SESSION_COOKIE}=invalid` },
    });
    assert.equal(edgeAdmin.status, 307);
    assert.equal(new URL(edgeAdmin.headers.get("location")!, APP).pathname, "/admin/login");
    assert.equal(new URL(edgeAdmin.headers.get("location")!, APP).searchParams.get("next"), "/admin/orders");
    assert.equal(new URL(edgeAdmin.headers.get("location")!, APP).searchParams.get("foo"), null);
    assertClearCookie(parseSessionSetCookie(edgeAdmin));
    assert.equal(edgeAdmin.headers.get("x-frame-options"), "DENY");
    assert.equal(edgeAdmin.headers.get("x-content-type-options"), "nosniff");
    assert.match(edgeAdmin.headers.get("cache-control") ?? "", /no-store/i);

    const edgeAccount = await fetch(`${APP}/account`, { redirect: "manual" });
    assert.equal(edgeAccount.status, 307);
    assert.equal(new URL(edgeAccount.headers.get("location")!, APP).pathname, "/login");

    // 2. Absolute expiration
    const { cookie: absCookie } = await loginHttp(staff2Email, initialPassword, "admin", { "X-Forwarded-For": "10.0.4.1" });
    assert.ok(absCookie);
    const absHash = hashSessionToken(absCookie.value);
    await prisma.session.update({ where: { tokenHash: absHash }, data: { expiresAt: new Date(Date.now() - 10_000) } });

    const absRes = await fetch(`${APP}/api/admin/pos/methods`, { headers: { Cookie: `${SESSION_COOKIE}=${absCookie.value}` } });
    assert.equal(absRes.status, 401);
    assertClearCookie(parseSessionSetCookie(absRes));
    assert.equal(await prisma.session.findUnique({ where: { tokenHash: absHash } }), null, "Expired session row must be deleted");

    // 3. Idle timeout (expiresAt still valid in the future, lastSeenAt beyond staff idle timeout)
    const { cookie: idleCookie } = await loginHttp(staff2Email, initialPassword, "admin", { "X-Forwarded-For": "10.0.4.2" });
    assert.ok(idleCookie);
    const idleHash = hashSessionToken(idleCookie.value);
    await prisma.session.update({
      where: { tokenHash: idleHash },
      data: { lastSeenAt: new Date(Date.now() - getStaffIdleMs() - 60_000) },
    });

    const idleRes = await fetch(`${APP}/api/admin/pos/methods`, { headers: { Cookie: `${SESSION_COOKIE}=${idleCookie.value}` } });
    assert.equal(idleRes.status, 401);
    assertClearCookie(parseSessionSetCookie(idleRes));
    assert.equal(await prisma.session.findUnique({ where: { tokenHash: idleHash } }), null, "Idle session row must be deleted");

    // 4. Scope mismatch (tampered DB scope)
    const { cookie: scopeCookie } = await loginHttp(customerEmail, initialPassword, "customer", { "X-Forwarded-For": "10.0.4.3" });
    assert.ok(scopeCookie);
    const scopeHash = hashSessionToken(scopeCookie.value);
    await prisma.session.update({ where: { tokenHash: scopeHash }, data: { scope: "admin" } });
    const scopeRes = await fetch(`${APP}/api/auth/me`, { headers: { Cookie: `${SESSION_COOKIE}=${scopeCookie.value}` } });
    assert.equal(scopeRes.status, 200);
    assert.equal(((await scopeRes.json()) as { user: unknown }).user, null);
    assertClearCookie(parseSessionSetCookie(scopeRes));
    assert.equal(await prisma.session.findUnique({ where: { tokenHash: scopeHash } }), null);

    // 5. Account suspension immediately invalidates existing session
    const { cookie: suspCookie } = await loginHttp(staff2Email, initialPassword, "admin", { "X-Forwarded-For": "10.0.4.4" });
    assert.ok(suspCookie);
    await prisma.user.update({ where: { id: staff2UserId }, data: { status: "SUSPENDED" } });
    try {
      const suspRes = await fetch(`${APP}/api/admin/pos/methods`, { headers: { Cookie: `${SESSION_COOKIE}=${suspCookie.value}` } });
      assert.equal(suspRes.status, 401);
      assertClearCookie(parseSessionSetCookie(suspRes));
    } finally {
      await prisma.user.update({ where: { id: staff2UserId }, data: { status: "ACTIVE" } });
    }
  });

  it("rotates current session and revokes all other device sessions on password change", async (t) => {
    if (!serverAvailable) return t.skip(`Server not reachable at ${APP}`);

    const { cookie: devA } = await loginHttp(customerEmail, initialPassword, "customer", { "X-Forwarded-For": "10.0.5.1" });
    const { cookie: devB } = await loginHttp(customerEmail, initialPassword, "customer", { "X-Forwarded-For": "10.0.5.2" });
    assert.ok(devA && devB);

    const pwRes = await fetch(`${APP}/api/account/password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: APP,
        Cookie: `${SESSION_COOKIE}=${devA.value}`,
        "X-Forwarded-For": "10.0.5.3",
      },
      body: JSON.stringify({ currentPassword: initialPassword, newPassword: rotatedPassword }),
    });
    assert.equal(pwRes.status, 200);
    const rotatedA = parseSessionSetCookie(pwRes);
    assert.ok(rotatedA, "Password change must issue a new rotated session cookie");
    assert.notEqual(rotatedA.value, devA.value);
    assert.equal(rotatedA.attrs.get("httponly"), true);

    // Old Device A token and Device B token must both be revoked
    const replayOldA = await fetch(`${APP}/api/account/profile`, { headers: { Cookie: `${SESSION_COOKIE}=${devA.value}` } });
    assert.equal(replayOldA.status, 401);
    const replayB = await fetch(`${APP}/api/account/profile`, { headers: { Cookie: `${SESSION_COOKIE}=${devB.value}` } });
    assert.equal(replayB.status, 401);

    // New rotated token on Device A must succeed
    const useNewA = await fetch(`${APP}/api/account/profile`, { headers: { Cookie: `${SESSION_COOKIE}=${rotatedA.value}` } });
    assert.equal(useNewA.status, 200);

    await prisma.session.deleteMany({ where: { userId: customerUserId } });
  });

  it("enforces CSRF protection on logout, invalidates single and all sessions, and caps concurrent sessions", async (t) => {
    if (!serverAvailable) return t.skip(`Server not reachable at ${APP}`);

    const { cookie: s1 } = await loginHttp(customerEmail, rotatedPassword, "customer", { "X-Forwarded-For": "10.0.6.1" });
    const { cookie: s2 } = await loginHttp(customerEmail, rotatedPassword, "customer", { "X-Forwarded-For": "10.0.6.2" });
    assert.ok(s1 && s2);

    // Cross-origin CSRF attempts must be rejected (403) without destroying the session
    const csrfVectors: Record<string, string>[] = [
      { Origin: "https://evil.example.com" },
      { Origin: "null" },
      { "Sec-Fetch-Site": "cross-site" },
      { Referer: "https://evil.example.com/phish" },
    ];
    for (const vec of csrfVectors) {
      const blocked = await fetch(`${APP}/api/auth/logout`, {
        method: "POST",
        headers: { Cookie: `${SESSION_COOKIE}=${s1.value}`, ...vec },
      });
      assert.equal(blocked.status, 403, `Expected 403 CSRF block for ${JSON.stringify(vec)}`);
    }

    // s1 must still be valid after blocked CSRF attempts
    const stillOk = await fetch(`${APP}/api/account/profile`, { headers: { Cookie: `${SESSION_COOKIE}=${s1.value}` } });
    assert.equal(stillOk.status, 200);

    // Single-session logout destroys s1 only and leaves s2 active
    const out1 = await fetch(`${APP}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=${s1.value}`, Origin: APP },
    });
    assert.equal(out1.status, 200);
    assertClearCookie(parseSessionSetCookie(out1));
    assert.equal(await prisma.session.findUnique({ where: { tokenHash: hashSessionToken(s1.value) } }), null);

    const replayS1 = await fetch(`${APP}/api/account/profile`, { headers: { Cookie: `${SESSION_COOKIE}=${s1.value}` } });
    assert.equal(replayS1.status, 401);

    const s2StillOk = await fetch(`${APP}/api/account/profile`, { headers: { Cookie: `${SESSION_COOKIE}=${s2.value}` } });
    assert.equal(s2StillOk.status, 200);

    // Logout with { all: true } invalidates ALL sessions across devices
    const { cookie: s3 } = await loginHttp(customerEmail, rotatedPassword, "customer", { "X-Forwarded-For": "10.0.6.3" });
    assert.ok(s3);

    const outAll = await fetch(`${APP}/api/auth/logout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=${s2.value}`,
        Origin: APP,
      },
      body: JSON.stringify({ all: true }),
    });
    assert.equal(outAll.status, 200);
    assertClearCookie(parseSessionSetCookie(outAll));

    const remainingCust = await prisma.session.count({ where: { userId: customerUserId } });
    assert.equal(remainingCust, 0, "Logout with all=true must revoke every session for the user");
    assert.equal((await fetch(`${APP}/api/account/profile`, { headers: { Cookie: `${SESSION_COOKIE}=${s3.value}` } })).status, 401);

    // Idempotent logout with no cookie still clears cleanly (including Secure over HTTPS)
    const idem = await fetch(`${APP}/api/auth/logout`, {
      method: "POST",
      headers: { Origin: APP, "X-Forwarded-Proto": "https" },
    });
    assert.equal(idem.status, 200);
    assertClearCookie(parseSessionSetCookie(idem), { expectSecure: true });

    // Concurrent session cap for staff (max 5): seed 5 active sessions + login -> capped at 5
    const now = Date.now();
    await prisma.session.createMany({
      data: Array.from({ length: 5 }, (_, idx) => ({
        tokenHash: hashSessionToken(randomBytes(32).toString("base64url")),
        userId: staff2UserId,
        scope: "admin",
        createdAt: new Date(now - (5 - idx) * 60_000),
        lastSeenAt: new Date(now - (5 - idx) * 60_000),
        expiresAt: new Date(now + 3_600_000),
      })),
    });
    const { res: capRes } = await loginHttp(staff2Email, initialPassword, "admin", { "X-Forwarded-For": "10.0.6.4" });
    assert.equal(capRes.status, 200);
    const staffCount = await prisma.session.count({ where: { userId: staff2UserId } });
    assert.equal(staffCount, 5, "Staff concurrent sessions must be capped at 5");
  });
});
