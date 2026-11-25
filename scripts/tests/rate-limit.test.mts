import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}

import { prisma } from "../../src/lib/db.ts";
import { hashPassword } from "../../src/lib/auth/password.ts";
import { hashPasswordResetToken } from "../../src/lib/auth/password-reset.ts";
import { solvePowSync } from "../../src/lib/security/bot-protection.ts";
import {
  checkCooldown,
  clearFailures,
  rateLimit,
  rateLimitMulti,
  recordFailure,
  resetRateLimits,
  setFixedCooldown,
  throttleDelay,
  type CooldownPolicy,
} from "../../src/lib/rate-limit.ts";
import {
  enforceLoginIpLimit,
  handleLoginFailure,
  handleLoginSuccess,
  normalizeAuthIdentifier,
} from "../../src/lib/auth/rate-limits.ts";

const APP = process.env.APP_URL || "http://localhost:3000";

// Generate unique synthetic client IPs per test run so isolated tests never collide
const RUN_OCTET = (Math.floor(Date.now() / 1000) % 200) + 20;
let ipCounter = 1;
function nextTestIp(): string {
  const n = ipCounter++;
  const b = Math.floor(n / 250) + 1;
  const c = (n % 250) + 1;
  return `198.51.${(RUN_OCTET + b) % 250}.${c}`;
}

function uniqueSuffix() {
  return `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

const EN_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18,
};

function solveAccessiblePrompt(prompt: string): string {
  const m = prompt.match(/What is ([a-z0-9]+) (plus|minus) ([a-z0-9]+)\?/i);
  if (!m) throw new Error(`Unexpected accessible CAPTCHA prompt: ${prompt}`);
  const a = EN_WORDS[m[1]!.toLowerCase()] ?? Number(m[1]);
  const b = EN_WORDS[m[3]!.toLowerCase()] ?? Number(m[3]);
  return String(m[2]!.toLowerCase() === "plus" ? a + b : a - b);
}

/**
 * Obtains and legitimately solves a built-in accessible bot-protection challenge so HTTP
 * rate-limit tests prove that rate limits & temporary cooldowns still stop attackers even
 * when human verification challenges are solved.
 */
async function solveBotChallenge(action: "login" | "admin_login" | "register", ip: string) {
  const res = await fetch(`${APP}/api/bot-protection/challenge?action=${action}&mode=accessible`, {
    method: "GET",
    headers: {
      "X-Forwarded-For": ip,
      Cookie: "locale=en",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36",
    },
  });
  assert.equal(res.status, 200, `Challenge endpoint returned ${res.status}`);
  const ch = (await res.json()) as { token: string; salt: string; difficulty: number; prompt: string };
  const receivedAt = Date.now();
  const answer = solveAccessiblePrompt(ch.prompt);
  const nonce = solvePowSync(ch.salt, ch.difficulty);
  const waitMs = 420 - (Date.now() - receivedAt);
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  return { provider: "builtin" as const, token: ch.token, nonce, answer };
}

async function apiPost(path: string, body: unknown, opts: { ip: string; cookie?: string; headers?: Record<string, string> }) {
  return fetch(`${APP}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: APP,
      "X-Forwarded-For": opts.ip,
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36",
      ...(opts.cookie ? { Cookie: opts.cookie } : {}),
      ...(opts.headers ?? {}),
    },
    body: JSON.stringify(body),
  });
}

async function apiGet(path: string, opts: { ip: string; cookie?: string; headers?: Record<string, string> }) {
  return fetch(`${APP}${path}`, {
    method: "GET",
    headers: {
      "X-Forwarded-For": opts.ip,
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36",
      ...(opts.cookie ? { Cookie: opts.cookie } : {}),
      ...(opts.headers ?? {}),
    },
  });
}

const createdUserIds: string[] = [];

async function createTestCustomer(opts?: { phoneSuffix?: string }) {
  const s = uniqueSuffix();
  const email = `rl-test-${s}@example.com`;
  const digits = opts?.phoneSuffix ?? String(Math.floor(1000000 + Math.random() * 8999999));
  const phone = `+85512${digits}`;
  const rawPassword = `TestPass_${randomBytes(4).toString("hex")}9`;
  const role = await prisma.role.findUniqueOrThrow({ where: { key: "CUSTOMER" } });
  const user = await prisma.user.create({
    data: {
      name: `RL Test ${s}`,
      email,
      phone,
      passwordHash: await hashPassword(rawPassword),
      roleId: role.id,
      customer: { create: {} },
    },
  });
  createdUserIds.push(user.id);
  return { user, email, phone, rawPassword };
}

// ─────────────────────── Unit Tests: Sliding Window & Cooldowns ───────────────────────

describe("Rate limiter engine (unit tests)", () => {
  it("prevents fixed-window boundary bursts with exact sliding windows (limit <= 64)", () => {
    resetRateLimits("unit:sliding:");
    const key = "unit:sliding:exact";
    const t0 = 1_700_000_000_000;

    // 3 hits near the end of minute 1
    assert.equal(rateLimit(key, 3, 60_000, t0 + 55_000).ok, true);
    assert.equal(rateLimit(key, 3, 60_000, t0 + 56_000).ok, true);
    assert.equal(rateLimit(key, 3, 60_000, t0 + 57_000).ok, true);

    // 5 seconds later (across the 60s boundary!), a fixed window would allow 3 more,
    // but an exact sliding window must STILL block until t0 + 55_000 + 60_000
    const blocked = rateLimit(key, 3, 60_000, t0 + 62_000);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.remaining, 0);
    assert.equal(blocked.retryAfter, 53);

    // Exactly when the first hit expires (t0 + 115_000), 1 slot opens
    const reopened = rateLimit(key, 3, 60_000, t0 + 115_000);
    assert.equal(reopened.ok, true);
    assert.equal(reopened.remaining, 0);
  });

  it("enforces high-limit weighted sliding-window counters (limit > 64)", () => {
    resetRateLimits("unit:counter:");
    const key = "unit:counter:high";
    const t0 = 1_700_000_000_000;

    for (let i = 0; i < 100; i++) {
      const r = rateLimit(key, 100, 60_000, t0 + i * 10);
      assert.equal(r.ok, true);
    }
    const denied = rateLimit(key, 100, 60_000, t0 + 2_000);
    assert.equal(denied.ok, false);
    assert.ok(denied.retryAfter >= 1);

    // Halfway through next window: previous weight = 0.5 -> effective 50 -> allows 50 more
    for (let i = 0; i < 50; i++) {
      assert.equal(rateLimit(key, 100, 60_000, t0 + 90_000).ok, true);
    }
    assert.equal(rateLimit(key, 100, 60_000, t0 + 90_000).ok, false);
  });

  it("checks multi-window limits atomically without burning wider quota on rejection", () => {
    resetRateLimits("unit:multi:");
    const t0 = 1_700_000_000_000;
    const rules = [
      { key: "unit:multi:1m", limit: 2, windowMs: 60_000 },
      { key: "unit:multi:15m", limit: 4, windowMs: 15 * 60_000 },
    ];

    assert.equal(rateLimitMulti(rules, t0).ok, true);
    assert.equal(rateLimitMulti(rules, t0 + 1000).ok, true);
    // 3rd attempt hits 1m burst limit and must NOT burn 15m quota
    const blocked = rateLimitMulti(rules, t0 + 2000);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.blockedKey, "unit:multi:1m");

    // Repeated rejected hits during the 1m window still must not exhaust the 15m quota
    for (let i = 0; i < 5; i++) {
      assert.equal(rateLimitMulti(rules, t0 + 3000 + i * 100).ok, false);
    }

    // After 1m passes, the remaining 2 slots in the 15m window must still be available!
    assert.equal(rateLimitMulti(rules, t0 + 62_000).ok, true);
    assert.equal(rateLimitMulti(rules, t0 + 63_000).ok, true);
    // Now 15m limit (4 total) is exhausted
    const blocked15m = rateLimitMulti(rules, t0 + 64_000);
    assert.equal(blocked15m.ok, false);
    assert.equal(blocked15m.blockedKey, "unit:multi:15m");
  });

  it("applies progressive soft delays, temporary escalating cooldowns, strike caps, and decay", () => {
    resetRateLimits("unit:cd:");
    const key = "unit:cd:login";
    const policy: CooldownPolicy = {
      maxAttempts: 3,
      failureWindowMs: 5 * 60_000,
      cooldownScheduleMs: [60_000, 300_000, 900_000],
      strikeResetMs: 60 * 60_000,
      softDelayBaseMs: 150,
      maxSoftDelayMs: 400,
    };
    const t0 = 1_700_000_000_000;

    // Attempt 1: no soft delay, not cooling down
    const r1 = recordFailure(key, policy, t0);
    assert.equal(r1.coolingDown, false);
    assert.equal(r1.softDelayMs, 0);
    assert.equal(r1.remainingAttempts, 2);

    // Attempt 2: soft throttle delay kicks in (150ms)
    const r2 = recordFailure(key, policy, t0 + 1_000);
    assert.equal(r2.coolingDown, false);
    assert.equal(r2.softDelayMs, 150);
    assert.equal(r2.remainingAttempts, 1);

    // Attempt 3: triggers Strike 1 temporary cooldown (60s)
    const r3 = recordFailure(key, policy, t0 + 2_000);
    assert.equal(r3.coolingDown, true);
    assert.equal(r3.strikes, 1);
    assert.equal(r3.retryAfter, 60);

    // Active cooldown check blocks immediately and does not double-escalate if called mid-cooldown
    const chk = checkCooldown(key, t0 + 12_000);
    assert.equal(chk.ok, false);
    if (!chk.ok) assert.equal(chk.retryAfter, 50);
    const midFail = recordFailure(key, policy, t0 + 12_000);
    assert.equal(midFail.strikes, 1);

    // Cooldown expires after 60s
    assert.equal(checkCooldown(key, t0 + 63_000).ok, true);

    // 3 more failures escalate to Strike 2 (300s)
    recordFailure(key, policy, t0 + 64_000);
    recordFailure(key, policy, t0 + 65_000);
    const strike2 = recordFailure(key, policy, t0 + 66_000);
    assert.equal(strike2.coolingDown, true);
    assert.equal(strike2.strikes, 2);
    assert.equal(strike2.retryAfter, 300);

    // 3 more after Strike 2 escalate to Strike 3 (900s), and Strike 4 caps at 900s
    const tS3 = t0 + 400_000;
    recordFailure(key, policy, tS3);
    recordFailure(key, policy, tS3 + 1000);
    const strike3 = recordFailure(key, policy, tS3 + 2000);
    assert.equal(strike3.strikes, 3);
    assert.equal(strike3.retryAfter, 900);

    const tS4 = tS3 + 910_000;
    recordFailure(key, policy, tS4);
    recordFailure(key, policy, tS4 + 1000);
    const strike4 = recordFailure(key, policy, tS4 + 2000);
    assert.equal(strike4.strikes, 4);
    assert.equal(strike4.retryAfter, 900); // capped at schedule max

    // After quiet period (> strikeResetMs past cooldown), strikes decay back to 0 -> next cooldown is 60s again
    const tDecayed = tS4 + 902_000 + 61 * 60_000;
    recordFailure(key, policy, tDecayed);
    recordFailure(key, policy, tDecayed + 1000);
    const resetStrike = recordFailure(key, policy, tDecayed + 2000);
    assert.equal(resetStrike.strikes, 1);
    assert.equal(resetStrike.retryAfter, 60);
  });

  it("normalizes email and Cambodian phone identifiers and preserves IP spray tracking across valid logins", async () => {
    assert.equal(normalizeAuthIdentifier("  User@Example.COM "), "user@example.com");
    assert.equal(normalizeAuthIdentifier("012 345 678"), "+85512345678");
    assert.equal(normalizeAuthIdentifier("+855 12 345 678"), "+85512345678");
    assert.equal(normalizeAuthIdentifier("85512345678"), "+85512345678");

    resetRateLimits("auth:login:");
    const ip = "203.0.113.50";
    // Record 11 failures across distinct accounts (just below ipSprayCooldown=12)
    process.env.DISABLE_THROTTLE_DELAY = "1";
    try {
      for (let i = 0; i < 11; i++) {
        await handleLoginFailure({ ip, normalizedId: `victim${i}@example.com`, scope: "customer" });
      }
      // Attacker logs into their own account successfully -> must NOT clear ipSpray counter!
      handleLoginSuccess(ip, "attacker@example.com", "attacker-uid");
      // 12th failure from same IP must STILL trigger ipSprayCooldown!
      await assert.rejects(
        () => handleLoginFailure({ ip, normalizedId: "victim12@example.com", scope: "customer" }),
        (err: unknown) => (err as { status?: number; code?: string }).status === 429 && (err as { code?: string }).code === "RATE_LIMITED",
      );
      assert.throws(() => enforceLoginIpLimit(ip), (err: unknown) => (err as { status?: number }).status === 429);
    } finally {
      delete process.env.DISABLE_THROTTLE_DELAY;
      resetRateLimits("auth:login:");
    }

    // Fixed cooldown and clearFailures work properly
    const fk = "unit:fixed:resend";
    setFixedCooldown(fk, 30_000, 1_700_000_000_000);
    assert.equal(checkCooldown(fk, 1_700_000_010_000).ok, false);
    clearFailures(fk);
    assert.equal(checkCooldown(fk, 1_700_000_010_000).ok, true);

    // Safe bounded throttleDelay
    const start = Date.now();
    await throttleDelay(25);
    assert.ok(Date.now() - start >= 15);
  });
});

// ─────────────────────── Live HTTP Integration Tests ───────────────────────

describe("HTTP rate limiting, throttling & temporary cooldowns", () => {
  it("POST /api/auth/login: throttles customer brute-force, triggers 429 cooldown at 5 failures, and normalizes phone formats", async () => {
    const ip = nextTestIp();
    const acct = await createTestCustomer();

    // 4 failed attempts return 401 (with progressive soft throttling; attempt 4 includes solved CAPTCHA)
    const durations: number[] = [];
    for (let i = 0; i < 4; i++) {
      const identifier = i % 2 === 0 ? acct.phone : acct.phone.replace("+855", "0");
      const _bot = i >= 3 ? await solveBotChallenge("login", ip) : undefined;
      const t0 = Date.now();
      const res = await apiPost(
        "/api/auth/login",
        { identifier, password: "WrongPassword99", scope: "customer", ...(_bot ? { _bot } : {}) },
        { ip },
      );
      durations.push(Date.now() - t0);
      assert.equal(res.status, 401, `Attempt ${i + 1} should return 401`);
    }
    // Attempt 4 includes 450ms soft throttle delay on top of bcrypt
    assert.ok(durations[3]! >= 350, `Expected progressive soft throttle delay on 4th failure (got ${durations[3]}ms)`);

    // 5th failed attempt (even with a valid solved CAPTCHA!) triggers temporary cooldown (429 + Retry-After)
    const bot5 = await solveBotChallenge("login", ip);
    const fifth = await apiPost(
      "/api/auth/login",
      { identifier: acct.phone, password: "WrongPassword99", scope: "customer", _bot: bot5 },
      { ip },
    );
    assert.equal(fifth.status, 429);
    const retryAfter = Number(fifth.headers.get("retry-after"));
    assert.ok(retryAfter >= 50 && retryAfter <= 65, `Expected ~60s Retry-After, got ${retryAfter}`);
    assert.equal(fifth.headers.get("x-ratelimit-remaining"), "0");
    const fifthBody = (await fifth.json()) as { error: { code: string; details?: { retryAfter?: number; reason?: string } } };
    assert.equal(fifthBody.error.code, "RATE_LIMITED");
    assert.equal(fifthBody.error.details?.reason, "cooldown");

    // During cooldown, even the CORRECT password from this IP is rejected immediately with 429 (before CAPTCHA/bcrypt)
    const duringCooldown = await apiPost("/api/auth/login", { identifier: acct.phone, password: acct.rawPassword, scope: "customer" }, { ip });
    assert.equal(duringCooldown.status, 429);
    assert.ok(Number(duringCooldown.headers.get("retry-after")) >= 1);

    // Another clean IP can still sign in with valid credentials (no collateral damage to other users/IPs)
    const cleanIp = nextTestIp();
    const okLogin = await apiPost("/api/auth/login", { identifier: acct.email, password: acct.rawPassword, scope: "customer" }, { ip: cleanIp });
    assert.equal(okLogin.status, 200);
    assert.ok(Number(okLogin.headers.get("x-ratelimit-limit")) > 0);
    assert.ok(okLogin.headers.get("x-ratelimit-remaining") !== null);
  });

  it("POST /api/auth/login: applies stricter 4-attempt, 2-minute cooldown for admin scope", async () => {
    const ip = nextTestIp();
    const id = `admin-probe-${uniqueSuffix()}@pamarcy.com.kh`;

    for (let i = 0; i < 3; i++) {
      const _bot = i >= 2 ? await solveBotChallenge("admin_login", ip) : undefined;
      const res = await apiPost(
        "/api/auth/login",
        { identifier: id, password: "WrongAdminPassword9", scope: "admin", ...(_bot ? { _bot } : {}) },
        { ip },
      );
      assert.equal(res.status, 401, `Admin attempt ${i + 1} should return 401`);
    }

    const bot4 = await solveBotChallenge("admin_login", ip);
    const fourth = await apiPost(
      "/api/auth/login",
      { identifier: id, password: "WrongAdminPassword9", scope: "admin", _bot: bot4 },
      { ip },
    );
    assert.equal(fourth.status, 429);
    const retryAfter = Number(fourth.headers.get("retry-after"));
    assert.ok(retryAfter >= 110 && retryAfter <= 125, `Expected ~120s Retry-After for admin cooldown, got ${retryAfter}`);
  });

  it("POST /api/auth/login: blocks distributed email+phone credential stuffing against the same user account", async () => {
    const acct = await createTestCustomer();

    // 7 failures across distinct IPs alternating email and phone (below per-IP+ID limit of 5)
    for (let i = 0; i < 7; i++) {
      const ip = nextTestIp();
      const identifier = i % 2 === 0 ? acct.email : acct.phone;
      const _bot = i >= 4 ? await solveBotChallenge("login", ip) : undefined;
      const res = await apiPost(
        "/api/auth/login",
        { identifier, password: "WrongPassword88", scope: "customer", ...(_bot ? { _bot } : {}) },
        { ip },
      );
      assert.equal(res.status, 401, `Distributed attempt ${i + 1} should return 401`);
    }

    // 8th failure from yet another fresh IP hits resolved userId cooldown (maxAttempts=8 -> 120s)
    const ip8 = nextTestIp();
    const bot8 = await solveBotChallenge("login", ip8);
    const eighth = await apiPost(
      "/api/auth/login",
      { identifier: acct.phone, password: "WrongPassword88", scope: "customer", _bot: bot8 },
      { ip: ip8 },
    );
    assert.equal(eighth.status, 429);
    assert.ok(Number(eighth.headers.get("retry-after")) >= 110);

    // 9th attempt from another fresh IP targeting email is also immediately cooled down via userId
    const ip9 = nextTestIp();
    const bot9 = await solveBotChallenge("login", ip9);
    const ninth = await apiPost(
      "/api/auth/login",
      { identifier: acct.email, password: acct.rawPassword, scope: "customer", _bot: bot9 },
      { ip: ip9 },
    );
    assert.equal(ninth.status, 429);
  });

  it("POST /api/auth/login: enforces per-IP 1-minute burst limit (10/min)", async () => {
    const ip = nextTestIp();
    for (let i = 0; i < 10; i++) {
      const _bot = i >= 5 ? await solveBotChallenge("login", ip) : undefined;
      const res = await apiPost(
        "/api/auth/login",
        { identifier: `burst-${i}-${uniqueSuffix()}@example.com`, password: "WrongPassword77", scope: "customer", ...(_bot ? { _bot } : {}) },
        { ip },
      );
      assert.equal(res.status, 401, `Burst request ${i + 1} should be allowed through IP limit`);
    }
    const eleventh = await apiPost(
      "/api/auth/login",
      { identifier: `burst-11-${uniqueSuffix()}@example.com`, password: "WrongPassword77", scope: "customer" },
      { ip },
    );
    assert.equal(eleventh.status, 429);
    assert.equal(eleventh.headers.get("x-ratelimit-limit"), "10");
    assert.ok(Number(eleventh.headers.get("retry-after")) >= 1);
  });

  it("POST /api/auth/register: enforces per-identifier, duplicate probing cooldown, and IP burst limits", async () => {
    const existing = await createTestCustomer();

    // 1) Target email limit (3/15m) across distinct IPs
    for (let i = 0; i < 3; i++) {
      const ip = nextTestIp();
      const _bot = await solveBotChallenge("register", ip);
      const res = await apiPost(
        "/api/auth/register",
        { name: "Probe User", email: existing.email, phone: `+85596${1000000 + i}`, password: "ValidPassword9", _bot },
        { ip },
      );
      assert.equal(res.status, 409, `Duplicate attempt ${i + 1} should return 409`);
    }
    const ip4 = nextTestIp();
    const bot4 = await solveBotChallenge("register", ip4);
    const fourthSameEmail = await apiPost(
      "/api/auth/register",
      { name: "Probe User", email: existing.email, phone: "+855961000099", password: "ValidPassword9", _bot: bot4 },
      { ip: ip4 },
    );
    assert.equal(fourthSameEmail.status, 429);
    assert.ok(Number(fourthSameEmail.headers.get("retry-after")) >= 1);

    // 2) IP burst limit (5/min) with distinct valid registrations & clean up
    const ipBurst = nextTestIp();
    const createdEmails: string[] = [];
    for (let i = 0; i < 5; i++) {
      const s = uniqueSuffix();
      const email = `reg-burst-${i}-${s}@example.com`;
      const phone = `+85588${String(Math.floor(1000000 + Math.random() * 8999999))}`;
      const _bot = await solveBotChallenge("register", ipBurst);
      const res = await apiPost(
        "/api/auth/register",
        { name: `Burst Reg ${i}`, email, phone, password: "ValidPassword9", _bot },
        { ip: ipBurst },
      );
      assert.equal(res.status, 200, `Registration ${i + 1} should succeed`);
      createdEmails.push(email);
    }
    const sixth = await apiPost(
      "/api/auth/register",
      { name: "Burst Reg 6", email: `reg-burst-6-${uniqueSuffix()}@example.com`, phone: "+855889998877", password: "ValidPassword9" },
      { ip: ipBurst },
    );
    assert.equal(sixth.status, 429);
    assert.equal(sixth.headers.get("x-ratelimit-limit"), "5");
    assert.ok(Number(sixth.headers.get("retry-after")) >= 1);

    // 3) Enumeration / conflict probing cooldown (5 duplicate conflicts from same IP -> 120s cooldown)
    const probeTargets = [await createTestCustomer(), await createTestCustomer()];
    const ipEnum = nextTestIp();
    for (let i = 0; i < 4; i++) {
      const target = probeTargets[i % 2]!;
      const _bot = await solveBotChallenge("register", ipEnum);
      const res = await apiPost(
        "/api/auth/register",
        { name: "Enum Probe", email: target.email, phone: `+85577${2000000 + i}`, password: "ValidPassword9", _bot },
        { ip: ipEnum },
      );
      assert.equal(res.status, 409, `Enum probe ${i + 1} should return 409`);
    }
    const botEnum5 = await solveBotChallenge("register", ipEnum);
    const fifthConflict = await apiPost(
      "/api/auth/register",
      { name: "Enum Probe", email: probeTargets[0]!.email, phone: "+855772000099", password: "ValidPassword9", _bot: botEnum5 },
      { ip: ipEnum },
    );
    assert.equal(fifthConflict.status, 429);
    const enumRetry = Number(fifthConflict.headers.get("retry-after"));
    assert.ok(enumRetry >= 110 && enumRetry <= 125, `Expected ~120s enumeration cooldown, got ${enumRetry}`);

    // Cleanup newly registered burst users
    const users = await prisma.user.findMany({ where: { email: { in: createdEmails } }, select: { id: true } });
    for (const u of users) createdUserIds.push(u.id);
  });

  it("POST /api/auth/password-reset/request: enforces generic responses, 60s resend cooldown, and 5/min IP burst", async () => {
    const acct = await createTestCustomer();
    const ip1 = nextTestIp();

    // First request for existing account succeeds with generic message
    const r1 = await apiPost("/api/auth/password-reset/request", { identifier: acct.email }, { ip: ip1 });
    assert.equal(r1.status, 200);
    const body1 = (await r1.json()) as { ok: boolean; message: string };
    assert.equal(body1.ok, true);

    // Immediate resend (even uppercase, from a different IP!) hits 60s per-identifier cooldown
    const r2 = await apiPost("/api/auth/password-reset/request", { identifier: acct.email.toUpperCase() }, { ip: nextTestIp() });
    assert.equal(r2.status, 429);
    const retryAfter = Number(r2.headers.get("retry-after"));
    assert.ok(retryAfter >= 50 && retryAfter <= 65, `Expected ~60s resend cooldown, got ${retryAfter}`);

    // Non-existent account returns identical generic message AND same 60s cooldown (anti-enumeration)
    const ghostEmail = `ghost-${uniqueSuffix()}@example.com`;
    const g1 = await apiPost("/api/auth/password-reset/request", { identifier: ghostEmail }, { ip: nextTestIp() });
    assert.equal(g1.status, 200);
    const ghostBody = (await g1.json()) as { ok: boolean; message: string };
    assert.equal(ghostBody.message, body1.message);
    const g2 = await apiPost("/api/auth/password-reset/request", { identifier: ghostEmail }, { ip: nextTestIp() });
    assert.equal(g2.status, 429);

    // Phone normalization shares the resend cooldown bucket
    const p1 = await apiPost("/api/auth/password-reset/request", { identifier: acct.phone }, { ip: nextTestIp() });
    assert.equal(p1.status, 200);
    const p2 = await apiPost("/api/auth/password-reset/request", { identifier: acct.phone.replace("+855", "0") }, { ip: nextTestIp() });
    assert.equal(p2.status, 429);

    // IP burst limit (5/min across 5 distinct identifiers -> 6th returns 429)
    const ipBurst = nextTestIp();
    for (let i = 0; i < 5; i++) {
      const res = await apiPost("/api/auth/password-reset/request", { identifier: `pwburst-${i}-${uniqueSuffix()}@example.com` }, { ip: ipBurst });
      assert.equal(res.status, 200);
    }
    const sixth = await apiPost("/api/auth/password-reset/request", { identifier: `pwburst-6-${uniqueSuffix()}@example.com` }, { ip: ipBurst });
    assert.equal(sixth.status, 429);
    assert.equal(sixth.headers.get("x-ratelimit-limit"), "5");
  });

  it("POST /api/auth/password-reset/confirm: resets password atomically, blocks replay, and cools down invalid token guesses", async () => {
    const acct = await createTestCustomer();

    // Sign in first so we have an active session to verify session revocation upon reset
    const loginRes = await apiPost("/api/auth/login", { identifier: acct.email, password: acct.rawPassword, scope: "customer" }, { ip: nextTestIp() });
    assert.equal(loginRes.status, 200);
    const sessionCookie = loginRes.headers.get("set-cookie")?.split(";")[0] ?? "";
    assert.ok(sessionCookie.startsWith("pamarcy_session="));

    // Create a known valid token in DB for end-to-end confirm testing
    const rawToken = randomBytes(32).toString("base64url");
    await prisma.passwordResetToken.create({
      data: {
        tokenHash: hashPasswordResetToken(rawToken),
        userId: acct.user.id,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      },
    });

    const newPassword = `NewReset_${randomBytes(4).toString("hex")}7`;
    const okConfirm = await apiPost(
      "/api/auth/password-reset/confirm",
      { token: rawToken, newPassword },
      { ip: nextTestIp() },
    );
    assert.equal(okConfirm.status, 200);

    // Old session must now be revoked!
    const meAfter = await apiGet("/api/auth/me", { ip: nextTestIp(), cookie: sessionCookie });
    assert.equal(meAfter.status, 200);
    assert.equal(((await meAfter.json()) as { user: unknown }).user, null);

    // Replaying the same reset token fails with 400
    const replay = await apiPost(
      "/api/auth/password-reset/confirm",
      { token: rawToken, newPassword: "AnotherPassword9" },
      { ip: nextTestIp() },
    );
    assert.equal(replay.status, 400);

    // New password works for login
    const relogin = await apiPost("/api/auth/login", { identifier: acct.email, password: newPassword, scope: "customer" }, { ip: nextTestIp() });
    assert.equal(relogin.status, 200);

    // Brute-force invalid reset tokens from one IP -> 4x 400, 5th triggers 120s cooldown (429)
    const attackerIp = nextTestIp();
    for (let i = 0; i < 4; i++) {
      const badToken = randomBytes(32).toString("base64url");
      const res = await apiPost(
        "/api/auth/password-reset/confirm",
        { token: badToken, newPassword: "AnotherPassword9" },
        { ip: attackerIp },
      );
      assert.equal(res.status, 400, `Invalid token attempt ${i + 1} should return 400`);
    }
    const fifthBad = await apiPost(
      "/api/auth/password-reset/confirm",
      { token: randomBytes(32).toString("base64url"), newPassword: "AnotherPassword9" },
      { ip: attackerIp },
    );
    assert.equal(fifthBad.status, 429);
    const retryAfter = Number(fifthBad.headers.get("retry-after"));
    assert.ok(retryAfter >= 110 && retryAfter <= 125, `Expected ~120s cooldown for reset token brute force, got ${retryAfter}`);
  });

  it("POST /api/account/password: cools down wrong current-password brute-force attempts", async () => {
    const acct = await createTestCustomer();
    const ip = nextTestIp();

    const login = await apiPost("/api/auth/login", { identifier: acct.email, password: acct.rawPassword, scope: "customer" }, { ip });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

    // 4 wrong current passwords -> 400
    for (let i = 0; i < 4; i++) {
      const res = await apiPost(
        "/api/account/password",
        { currentPassword: "WrongCurrentPass9", newPassword: "UpdatedPassword9" },
        { ip, cookie },
      );
      assert.equal(res.status, 400, `Wrong current password attempt ${i + 1} should return 400`);
    }

    // 5th wrong current password -> triggers temporary cooldown (429 + Retry-After)
    const fifth = await apiPost(
      "/api/account/password",
      { currentPassword: "WrongCurrentPass9", newPassword: "UpdatedPassword9" },
      { ip, cookie },
    );
    assert.equal(fifth.status, 429);
    assert.ok(Number(fifth.headers.get("retry-after")) >= 50);

    // Even from a different IP, the same user is still protected by user cooldown
    const otherIpAttempt = await apiPost(
      "/api/account/password",
      { currentPassword: acct.rawPassword, newPassword: "UpdatedPassword9" },
      { ip: nextTestIp(), cookie },
    );
    assert.equal(otherIpAttempt.status, 429);
  });

  it("GET /api/auth/me, POST /api/auth/logout & /api/cron/maintenance: enforce endpoint limits and bad-credential cooldowns", async () => {
    // 1) /api/auth/me: forged session cookie probing triggers temporary cooldown at 15 invalid cookies
    const probeIp = nextTestIp();
    for (let i = 0; i < 14; i++) {
      const fakeToken = randomBytes(32).toString("base64url");
      const res = await apiGet("/api/auth/me", { ip: probeIp, cookie: `pamarcy_session=${fakeToken}` });
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { user: unknown }).user, null);
    }
    const fifteenthBadCookie = await apiGet("/api/auth/me", {
      ip: probeIp,
      cookie: `pamarcy_session=${randomBytes(32).toString("base64url")}`,
    });
    assert.equal(fifteenthBadCookie.status, 429);
    assert.ok(Number(fifteenthBadCookie.headers.get("retry-after")) >= 50);

    // 2) /api/auth/me: anonymous IP limit (60/min -> 61st returns 429)
    const meFloodIp = nextTestIp();
    for (let i = 0; i < 60; i++) {
      const res = await apiGet("/api/auth/me", { ip: meFloodIp });
      assert.equal(res.status, 200);
    }
    const me61 = await apiGet("/api/auth/me", { ip: meFloodIp });
    assert.equal(me61.status, 429);
    assert.equal(me61.headers.get("x-ratelimit-limit"), "60");

    // 3) /api/auth/logout: IP limit (15/min -> 16th returns 429)
    const logoutIp = nextTestIp();
    for (let i = 0; i < 15; i++) {
      const res = await apiPost("/api/auth/logout", {}, { ip: logoutIp });
      assert.equal(res.status, 200);
    }
    const logout16 = await apiPost("/api/auth/logout", {}, { ip: logoutIp });
    assert.equal(logout16.status, 429);
    assert.equal(logout16.headers.get("x-ratelimit-limit"), "15");
    assert.ok(Number(logout16.headers.get("retry-after")) >= 1);

    // 4) /api/cron/maintenance: bad secret brute-force triggers 5-minute cooldown on 5th attempt
    const cronIp = nextTestIp();
    for (let i = 0; i < 4; i++) {
      const res = await apiGet("/api/cron/maintenance", { ip: cronIp, headers: { "x-cron-secret": `wrong-secret-${i}` } });
      assert.equal(res.status, 401);
    }
    const cron5 = await apiGet("/api/cron/maintenance", { ip: cronIp, headers: { "x-cron-secret": "wrong-secret-5" } });
    assert.equal(cron5.status, 429);
    assert.ok(Number(cron5.headers.get("retry-after")) >= 290);
  });
});

after(async () => {
  if (createdUserIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.passwordResetToken.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await prisma.$disconnect();
});
