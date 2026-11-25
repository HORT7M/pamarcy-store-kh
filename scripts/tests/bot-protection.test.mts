import { existsSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}

import { prisma } from "../../src/lib/db.ts";
import { hashPassword } from "../../src/lib/auth/password.ts";
import { cancelOrder } from "../../src/lib/services/orders.ts";
import { ApiError } from "../../src/lib/errors.ts";
import {
  generateAccessibleCaptcha,
  generateVisualCaptcha,
  normalizeCaptchaAnswer,
} from "../../src/lib/security/captcha-svg.ts";
import {
  assessBotRequirement,
  clearLoginFailureSignal,
  issueBotChallenge,
  recordGuestCheckoutSignal,
  recordGuestUploadSignal,
  recordLoginFailureSignal,
  recordPasswordResetRequestSignal,
  recordPromoFailureSignal,
  recordRegistrationSuccessSignal,
  recordReviewSignal,
  resetBotProtectionState,
  solvePowSync,
  verifyBotProtection,
  verifyPowNonce,
} from "../../src/lib/security/bot-protection.ts";

const APP = process.env.APP_URL || "http://localhost:3000";

const RUN_OCTET = (Math.floor(Date.now() / 1000) % 180) + 40;
let ipSeq = 1;
function nextTestIp(): string {
  const n = ipSeq++;
  const b = Math.floor(n / 240) + 1;
  const c = (n % 240) + 1;
  return `203.0.113.${((RUN_OCTET + b + c) % 240) + 1}`;
}
function uniqueIp(seed: number): string {
  return `198.51.${(seed % 200) + 10}.${((seed * 7 + ipSeq++) % 240) + 1}`;
}

const EN_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18,
};

function solveEnAccessiblePrompt(prompt: string): string {
  const m = prompt.match(/What is ([a-z0-9]+) (plus|minus) ([a-z0-9]+)\?/i);
  if (!m) throw new Error(`Unexpected accessible prompt: ${prompt}`);
  const a = EN_WORDS[m[1]!.toLowerCase()] ?? Number(m[1]);
  const b = EN_WORDS[m[3]!.toLowerCase()] ?? Number(m[3]);
  return String(m[2]!.toLowerCase() === "plus" ? a + b : a - b);
}

function toKhmerDigits(ascii: string): string {
  return ascii.replace(/[0-9]/g, (d) => String.fromCharCode(0x17e0 + Number(d)));
}

function makeBrowserReq(ip: string, ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36") {
  return new Request("http://localhost:3000/api/test", {
    method: "POST",
    headers: {
      "x-forwarded-for": ip,
      "user-agent": ua,
      "accept-language": "km,en;q=0.9",
      origin: "http://localhost:3000",
    },
  });
}

function loadValidJpeg(): Uint8Array {
  return readFileSync("public/images/products/paracetamol-500.jpg");
}

// ───────────────────── Unit Tests ─────────────────────

describe("Bot protection & CAPTCHA core engine (unit)", () => {
  it("renders vector-path SVG CAPTCHA with zero <text> nodes and normalizes ASCII, Khmer & full-width digits", () => {
    for (let i = 0; i < 10; i++) {
      const { imageDataUri, answer } = generateVisualCaptcha();
      assert.ok(imageDataUri.startsWith("data:image/svg+xml;base64,"));
      const svg = Buffer.from(imageDataUri.slice("data:image/svg+xml;base64,".length), "base64").toString("utf8");
      assert.ok(svg.includes("<svg"));
      assert.ok(svg.includes("<path "));
      assert.equal(/<text\b/i.test(svg), false, "SVG CAPTCHA must not contain plaintext <text> elements");
      assert.match(answer, /^\d{1,2}$/);
      assert.ok(Number(answer) >= 1 && Number(answer) <= 30);
    }

    const enAcc = generateAccessibleCaptcha("en");
    assert.equal(solveEnAccessiblePrompt(enAcc.prompt), enAcc.answer);
    const kmAcc = generateAccessibleCaptcha("km");
    assert.ok(kmAcc.prompt.includes("តើ "));
    assert.match(kmAcc.answer, /^\d{1,2}$/);

    // Digit normalization for Cambodian users with Khmer keyboards
    assert.equal(normalizeCaptchaAnswer(" ១២ "), "12");
    assert.equal(normalizeCaptchaAnswer("០៧"), "07");
    assert.equal(normalizeCaptchaAnswer("１５"), "15");
    assert.equal(normalizeCaptchaAnswer(" 9 "), "9");
  });

  it("verifies Proof-of-Work nonces strictly and rejects invalid/malformed nonces", () => {
    const salt = randomBytes(12).toString("hex");
    const nonce = solvePowSync(salt, 10);
    assert.equal(verifyPowNonce(salt, nonce, 10), true);
    assert.equal(verifyPowNonce(salt, "", 10), false);
    assert.equal(verifyPowNonce(salt, "bad nonce with spaces!", 10), false);
    assert.equal(verifyPowNonce(salt, "a".repeat(65), 10), false);
    assert.equal(verifyPowNonce("different-salt", nonce, 10), false);
  });

  it("enforces adaptive risk thresholds without blocking clean legitimate users", () => {
    resetBotProtectionState();
    const ip = uniqueIp(1);

    // Clean customer login: 0..2 failures -> none; 3rd failure -> interactive
    assert.equal(assessBotRequirement({ action: "login", ip, identifier: "u@example.com" }), "none");
    recordLoginFailureSignal(ip, "u@example.com");
    recordLoginFailureSignal(ip, "u@example.com");
    assert.equal(assessBotRequirement({ action: "login", ip, identifier: "u@example.com" }), "none");
    recordLoginFailureSignal(ip, "u@example.com");
    assert.equal(assessBotRequirement({ action: "login", ip, identifier: "u@example.com" }), "interactive");
    clearLoginFailureSignal(ip, "u@example.com");

    // Clean admin login: 0..1 failures -> none; 2nd failure -> interactive
    const ipAdmin = uniqueIp(2);
    assert.equal(assessBotRequirement({ action: "admin_login", ip: ipAdmin, identifier: "adm@pamarcy.com.kh" }), "none");
    recordLoginFailureSignal(ipAdmin, "adm@pamarcy.com.kh");
    assert.equal(assessBotRequirement({ action: "admin_login", ip: ipAdmin, identifier: "adm@pamarcy.com.kh" }), "none");
    recordLoginFailureSignal(ipAdmin, "adm@pamarcy.com.kh");
    assert.equal(assessBotRequirement({ action: "admin_login", ip: ipAdmin, identifier: "adm@pamarcy.com.kh" }), "interactive");

    // Registration: silent on clean 1st signup, interactive on repeat or automated UA
    const ipReg = uniqueIp(3);
    assert.equal(assessBotRequirement({ action: "register", ip: ipReg }), "silent");
    assert.equal(assessBotRequirement({ action: "register", ip: ipReg, automatedHeaders: true }), "interactive");
    recordRegistrationSuccessSignal(ipReg);
    assert.equal(assessBotRequirement({ action: "register", ip: ipReg }), "interactive");

    // Checkout: authenticated clean = none; guest clean = silent; unpaid pending orders = interactive
    const ipChk = uniqueIp(4);
    assert.equal(assessBotRequirement({ action: "checkout", ip: ipChk, authenticated: true, recentUnpaidOrders: 0 }), "none");
    assert.equal(assessBotRequirement({ action: "checkout", ip: ipChk, authenticated: true, recentUnpaidOrders: 2 }), "interactive");
    assert.equal(assessBotRequirement({ action: "checkout", ip: ipChk, authenticated: false, recentUnpaidOrders: 0 }), "silent");
    assert.equal(assessBotRequirement({ action: "checkout", ip: ipChk, authenticated: false, recentUnpaidOrders: 1 }), "interactive");
    recordGuestCheckoutSignal(ipChk, "+85512345678");
    recordGuestCheckoutSignal(ipChk, "+85512345678");
    assert.equal(assessBotRequirement({ action: "checkout", ip: ipChk, authenticated: false, identifier: "+85512345678" }), "interactive");

    // Guest prescription upload: silent on 1st-3rd, interactive on 4th; authenticated = none
    const ipUp = uniqueIp(5);
    assert.equal(assessBotRequirement({ action: "prescription_upload", ip: ipUp, authenticated: true }), "none");
    assert.equal(assessBotRequirement({ action: "prescription_upload", ip: ipUp, authenticated: false }), "silent");
    recordGuestUploadSignal(ipUp);
    recordGuestUploadSignal(ipUp);
    recordGuestUploadSignal(ipUp);
    assert.equal(assessBotRequirement({ action: "prescription_upload", ip: ipUp, authenticated: false }), "interactive");

    // Promo code guessing: first 5 invalid codes = none, 6th = interactive
    const ipPromo = uniqueIp(6);
    for (let i = 0; i < 5; i++) recordPromoFailureSignal(ipPromo);
    assert.equal(assessBotRequirement({ action: "promo_code", ip: ipPromo }), "none");
    recordPromoFailureSignal(ipPromo);
    assert.equal(assessBotRequirement({ action: "promo_code", ip: ipPromo }), "interactive");

    // Reviews: first 3 in 10m = none, 4th = interactive
    const ipRev = uniqueIp(7);
    for (let i = 0; i < 3; i++) recordReviewSignal(ipRev, "cust_1");
    assert.equal(assessBotRequirement({ action: "review", ip: ipRev, identifier: "cust_1" }), "none");
    recordReviewSignal(ipRev, "cust_1");
    assert.equal(assessBotRequirement({ action: "review", ip: ipRev, identifier: "cust_1" }), "interactive");

    // Password reset: clean browser = none; automated UA or 6+ requests in 15m = interactive
    const ipReset = uniqueIp(8);
    assert.equal(assessBotRequirement({ action: "password_reset", ip: ipReset }), "none");
    assert.equal(assessBotRequirement({ action: "password_reset", ip: ipReset, automatedHeaders: true }), "interactive");
    for (let i = 0; i < 6; i++) recordPasswordResetRequestSignal(ipReset);
    assert.equal(assessBotRequirement({ action: "password_reset", ip: ipReset }), "interactive");
  });

  it("enforces honeypot, signature integrity, action binding, IPv6 /64 tolerance, replay protection, mode downgrade, and Khmer answers", async () => {
    resetBotProtectionState();
    const origProvider = process.env.BOT_PROTECTION_PROVIDER;
    const origMinMs = process.env.BOT_PROTECTION_MIN_SUBMIT_MS;
    process.env.BOT_PROTECTION_PROVIDER = "builtin";
    process.env.BOT_PROTECTION_MIN_SUBMIT_MS = "100";

    try {
      const ip = uniqueIp(10);
      const req = makeBrowserReq(ip);

      // 1. Honeypot trap immediately blocks with 403 BOT_BLOCKED
      await assert.rejects(
        () => verifyBotProtection(req, { action: "login", bot: { hp: "http://spam.example" } }),
        (err: unknown) => err instanceof ApiError && err.status === 403 && err.code === "BOT_BLOCKED",
      );
      // And escalates that IP to interactive CAPTCHA
      assert.equal(assessBotRequirement({ action: "login", ip }), "interactive");

      // 2. Fresh IP: issue silent register challenge, test fast-submit step-up vs valid submit vs replay
      const ip2 = uniqueIp(11);
      const req2 = makeBrowserReq(ip2);
      const silent = issueBotChallenge(req2, { action: "register", requestedMode: "auto" });
      assert.equal(silent.provider, "builtin");
      assert.equal(silent.mode, "silent");
      assert.ok(silent.token && silent.salt && silent.difficulty);
      const nonce = solvePowSync(silent.salt, silent.difficulty);

      // Tampered signature rejected
      await assert.rejects(
        () =>
          verifyBotProtection(req2, {
            action: "register",
            bot: { provider: "builtin", token: `${silent.token}tampered`, nonce },
          }),
        (err: unknown) => err instanceof ApiError && err.status === 403 && err.code === "CAPTCHA_INVALID",
      );

      // Action mismatch rejected (register token submitted to checkout)
      await assert.rejects(
        () =>
          verifyBotProtection(req2, {
            action: "checkout",
            bot: { provider: "builtin", token: silent.token, nonce },
          }),
        (err: unknown) => err instanceof ApiError && err.status === 403 && err.code === "CAPTCHA_INVALID",
      );

      // IP mismatch rejected
      await assert.rejects(
        () =>
          verifyBotProtection(makeBrowserReq(uniqueIp(12)), {
            action: "register",
            bot: { provider: "builtin", token: silent.token, nonce },
          }),
        (err: unknown) => err instanceof ApiError && err.status === 403 && err.code === "CAPTCHA_INVALID",
      );

      // Wait > 100ms dwell time -> valid silent token succeeds
      await new Promise((r) => setTimeout(r, 120));
      const ok = await verifyBotProtection(req2, {
        action: "register",
        bot: { provider: "builtin", token: silent.token, nonce },
      });
      assert.equal(ok.verified, true);

      // Replay of the exact same token -> rejected!
      await assert.rejects(
        () =>
          verifyBotProtection(req2, {
            action: "register",
            bot: { provider: "builtin", token: silent.token, nonce },
          }),
        (err: unknown) => err instanceof ApiError && err.status === 403 && err.code === "CAPTCHA_INVALID",
      );

      // 3. Mode downgrade protection: silent token rejected when interactive is required
      const ip3 = uniqueIp(13);
      const req3 = makeBrowserReq(ip3);
      const silentForDowngrade = issueBotChallenge(req3, { action: "register", requestedMode: "auto" });
      assert.equal(silentForDowngrade.provider, "builtin");
      const downgradeNonce = solvePowSync(silentForDowngrade.salt!, silentForDowngrade.difficulty!);
      recordRegistrationSuccessSignal(ip3); // now register requires interactive!
      await new Promise((r) => setTimeout(r, 120));
      await assert.rejects(
        () =>
          verifyBotProtection(req3, {
            action: "register",
            bot: { provider: "builtin", token: silentForDowngrade.token, nonce: downgradeNonce },
          }),
        (err: unknown) => err instanceof ApiError && err.status === 403 && err.code === "CAPTCHA_REQUIRED",
      );

      // 4. Interactive / accessible challenge with Khmer numerals + IPv6 /64 privacy rotation tolerance
      const v6Req1 = makeBrowserReq("2001:db8:abcd:1234::1111");
      const v6Req2 = makeBrowserReq("2001:db8:abcd:1234::9999");
      const acc = issueBotChallenge(v6Req1, { action: "register", requestedMode: "accessible", locale: "en" });
      assert.equal(acc.provider, "builtin");
      assert.equal(acc.mode, "accessible");
      assert.ok(acc.prompt && acc.token && acc.salt && acc.difficulty);
      const answer = solveEnAccessiblePrompt(acc.prompt);
      const accNonce = solvePowSync(acc.salt, acc.difficulty);
      await new Promise((r) => setTimeout(r, 380));

      const khmerRes = await verifyBotProtection(v6Req2, {
        action: "register",
        bot: { provider: "builtin", token: acc.token, nonce: accNonce, answer: toKhmerDigits(answer) },
      });
      assert.equal(khmerRes.verified, true);

      // 5. Wrong answer consumes challenge immediately (no brute-force against same token)
      const ip4 = uniqueIp(14);
      const req4 = makeBrowserReq(ip4);
      const acc2 = issueBotChallenge(req4, { action: "register", requestedMode: "accessible", locale: "en" });
      assert.equal(acc2.provider, "builtin");
      const realAns = solveEnAccessiblePrompt(acc2.prompt!);
      const wrongAns = String(Number(realAns) + 1);
      const nonce2 = solvePowSync(acc2.salt!, acc2.difficulty!);
      await new Promise((r) => setTimeout(r, 380));

      await assert.rejects(
        () =>
          verifyBotProtection(req4, {
            action: "register",
            bot: { provider: "builtin", token: acc2.token, nonce: nonce2, answer: wrongAns },
          }),
        (err: unknown) => err instanceof ApiError && err.status === 403 && err.code === "CAPTCHA_INVALID",
      );
      // Even submitting the REAL answer on the same token afterward fails because it was consumed!
      await assert.rejects(
        () =>
          verifyBotProtection(req4, {
            action: "register",
            bot: { provider: "builtin", token: acc2.token, nonce: nonce2, answer: realAns },
          }),
        (err: unknown) => err instanceof ApiError && err.status === 403 && err.code === "CAPTCHA_INVALID",
      );
    } finally {
      if (origProvider === undefined) delete process.env.BOT_PROTECTION_PROVIDER;
      else process.env.BOT_PROTECTION_PROVIDER = origProvider;
      if (origMinMs === undefined) delete process.env.BOT_PROTECTION_MIN_SUBMIT_MS;
      else process.env.BOT_PROTECTION_MIN_SUBMIT_MS = origMinMs;
    }
  });

  it("verifies Cloudflare Turnstile server-side siteverify, action match, replay protection, and interactive fallback", async () => {
    resetBotProtectionState();
    const orig = {
      provider: process.env.BOT_PROTECTION_PROVIDER,
      site: process.env.TURNSTILE_SITE_KEY,
      secret: process.env.TURNSTILE_SECRET_KEY,
      fallback: process.env.BOT_PROTECTION_ALLOW_FALLBACK,
    };
    const origFetch = globalThis.fetch;

    process.env.BOT_PROTECTION_PROVIDER = "turnstile";
    process.env.TURNSTILE_SITE_KEY = "0x4AAAAAAA-test-site-key";
    process.env.TURNSTILE_SECRET_KEY = "0x4AAAAAAA-test-secret-key";
    process.env.BOT_PROTECTION_ALLOW_FALLBACK = "true";

    try {
      const ip = uniqueIp(20);
      const req = makeBrowserReq(ip);

      // Challenge endpoint advertises Turnstile siteKey (never secret!)
      const chal = issueBotChallenge(req, { action: "register" });
      assert.equal(chal.provider, "turnstile");
      assert.equal(chal.siteKey, "0x4AAAAAAA-test-site-key");
      assert.equal(JSON.stringify(chal).includes("0x4AAAAAAA-test-secret-key"), false);

      // Mock Turnstile siteverify
      let lastBody = "";
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        lastBody = String(init?.body ?? "");
        const params = new URLSearchParams(lastBody);
        const resp = params.get("response");
        if (resp === "valid-turnstile-token") {
          return new Response(JSON.stringify({ success: true, action: "register", hostname: "localhost" }), { status: 200 });
        }
        if (resp === "wrong-action-token") {
          return new Response(JSON.stringify({ success: true, action: "login", hostname: "localhost" }), { status: 200 });
        }
        return new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }), { status: 200 });
      }) as typeof fetch;

      // Valid Turnstile token succeeds
      const ok = await verifyBotProtection(req, {
        action: "register",
        bot: { provider: "turnstile", token: "valid-turnstile-token" },
      });
      assert.equal(ok.verified, true);
      assert.ok(lastBody.includes("secret=0x4AAAAAAA-test-secret-key"));
      assert.ok(lastBody.includes(`remoteip=${encodeURIComponent(ip)}`));

      // Replaying same Turnstile token fails immediately
      await assert.rejects(
        () => verifyBotProtection(req, { action: "register", bot: { provider: "turnstile", token: "valid-turnstile-token" } }),
        (err: unknown) => err instanceof ApiError && err.status === 403 && err.code === "CAPTCHA_INVALID",
      );

      // Action mismatch rejected
      await assert.rejects(
        () => verifyBotProtection(req, { action: "register", bot: { provider: "turnstile", token: "wrong-action-token" } }),
        (err: unknown) => err instanceof ApiError && err.status === 403 && err.code === "CAPTCHA_INVALID",
      );

      // Built-in fallback when Turnstile script is blocked MUST require interactive (never silent)
      const fbChal = issueBotChallenge(req, { action: "register", fallbackBuiltin: true, requestedMode: "accessible", locale: "en" });
      assert.equal(fbChal.provider, "builtin");
      assert.equal(fbChal.mode, "accessible");
      const fbNonce = solvePowSync(fbChal.salt!, fbChal.difficulty!);
      const fbAns = solveEnAccessiblePrompt(fbChal.prompt!);
      await new Promise((r) => setTimeout(r, 380));
      const fbOk = await verifyBotProtection(req, {
        action: "register",
        bot: { provider: "builtin", token: fbChal.token, nonce: fbNonce, answer: fbAns },
      });
      assert.equal(fbOk.verified, true);
    } finally {
      globalThis.fetch = origFetch;
      if (orig.provider === undefined) delete process.env.BOT_PROTECTION_PROVIDER;
      else process.env.BOT_PROTECTION_PROVIDER = orig.provider;
      if (orig.site === undefined) delete process.env.TURNSTILE_SITE_KEY;
      else process.env.TURNSTILE_SITE_KEY = orig.site;
      if (orig.secret === undefined) delete process.env.TURNSTILE_SECRET_KEY;
      else process.env.TURNSTILE_SECRET_KEY = orig.secret;
      if (orig.fallback === undefined) delete process.env.BOT_PROTECTION_ALLOW_FALLBACK;
      else process.env.BOT_PROTECTION_ALLOW_FALLBACK = orig.fallback;
    }
  });
});

// ───────────────────── Live HTTP End-to-End Tests ─────────────────────

describe("Live HTTP bot protection & CAPTCHA verification (when server is running)", () => {
  const createdUserIds: string[] = [];
  const createdOrderIds: string[] = [];
  const createdFiles: string[] = [];

  async function isServerReachable(): Promise<boolean> {
    try {
      const r = await fetch(`${APP}/api/categories`, { signal: AbortSignal.timeout(1500) });
      return r.status === 200;
    } catch {
      return false;
    }
  }

  async function fetchSolvedChallenge(action: string, ip: string, mode: "auto" | "accessible" = "accessible") {
    const res = await fetch(`${APP}/api/bot-protection/challenge?action=${action}&mode=${mode}`, {
      headers: {
        "x-forwarded-for": ip,
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
        cookie: "locale=en",
      },
    });
    assert.equal(res.status, 200, `Challenge fetch failed for ${action}`);
    assert.match(res.headers.get("cache-control") ?? "", /no-store/);
    const chal = (await res.json()) as {
      provider: string;
      mode: string;
      required: boolean;
      token?: string;
      salt?: string;
      difficulty?: number;
      prompt?: string;
    };
    assert.equal(chal.provider, "builtin");
    assert.equal(chal.required, true);
    const nonce = solvePowSync(chal.salt!, chal.difficulty!);
    const answer = chal.prompt ? solveEnAccessiblePrompt(chal.prompt) : undefined;
    await new Promise((r) => setTimeout(r, chal.mode === "silent" ? 900 : 420));
    return { provider: "builtin", token: chal.token, nonce, ...(answer ? { answer } : {}) };
  }

  async function createCustomerFixture() {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: "CUSTOMER" } });
    const suf = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const email = `bot-test-${suf}@example.com`;
    const phone = `+85597${String(Math.floor(1000000 + Math.random() * 8999999))}`;
    const rawPassword = `BotSafe_${randomBytes(4).toString("hex")}9`;
    const user = await prisma.user.create({
      data: {
        name: "Bot Audit Tester",
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

  it("enforces adaptive CAPTCHA on /api/auth/login without blocking clean first-time logins", async (t) => {
    if (!(await isServerReachable())) return t.skip(`No live server at ${APP}`);
    const acct = await createCustomerFixture();

    // 1. Clean legitimate first login -> 200 OK with zero CAPTCHA friction
    const cleanIp = nextTestIp();
    const cleanRes = await fetch(`${APP}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: APP, "x-forwarded-for": cleanIp },
      body: JSON.stringify({ identifier: acct.email, password: acct.rawPassword, scope: "customer" }),
    });
    assert.equal(cleanRes.status, 200);

    // 2. Honeypot tripped -> 403 BOT_BLOCKED
    const hpIp = nextTestIp();
    const hpRes = await fetch(`${APP}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: APP, "x-forwarded-for": hpIp },
      body: JSON.stringify({ identifier: acct.email, password: acct.rawPassword, scope: "customer", _bot: { hp: "bot-value" } }),
    });
    assert.equal(hpRes.status, 403);
    assert.equal(((await hpRes.json()) as { error: { code: string } }).error.code, "BOT_BLOCKED");

    // 3. Repeated login failures escalate to 403 CAPTCHA_REQUIRED, then solved CAPTCHA + valid password succeeds!
    const bruteIp = nextTestIp();
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${APP}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP, "x-forwarded-for": bruteIp },
        body: JSON.stringify({ identifier: acct.email, password: "WrongPassword99", scope: "customer" }),
      });
      assert.equal(r.status, 401);
      if (i === 2) {
        const body = (await r.json()) as { error: { details?: { challengeRequired?: boolean } } };
        assert.equal(body.error.details?.challengeRequired, true, "3rd failure should hint challengeRequired for next submit");
      }
    }

    // 4th attempt WITHOUT CAPTCHA is blocked with 403 CAPTCHA_REQUIRED (even with valid password!)
    const blocked = await fetch(`${APP}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: APP, "x-forwarded-for": bruteIp },
      body: JSON.stringify({ identifier: acct.email, password: acct.rawPassword, scope: "customer" }),
    });
    assert.equal(blocked.status, 403);
    assert.equal(((await blocked.json()) as { error: { code: string } }).error.code, "CAPTCHA_REQUIRED");

    // 4th attempt WITH solved CAPTCHA + valid password -> 200 OK!
    const solved = await fetchSolvedChallenge("login", bruteIp, "accessible");
    const recovered = await fetch(`${APP}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: APP, "x-forwarded-for": bruteIp },
      body: JSON.stringify({ identifier: acct.email, password: acct.rawPassword, scope: "customer", _bot: solved }),
    });
    assert.equal(recovered.status, 200);
  });

  it("blocks automated /api/auth/register bots while allowing verified browser signups and escalating repeat signups", async (t) => {
    if (!(await isServerReachable())) return t.skip(`No live server at ${APP}`);
    const ip = nextTestIp();
    const suf = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

    // 1. Raw scripted POST without bot token -> 403 CAPTCHA_REQUIRED
    const raw = await fetch(`${APP}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: APP, "x-forwarded-for": ip },
      body: JSON.stringify({
        name: "Bot Signup",
        email: `bot-reg-raw-${suf}@example.com`,
        phone: `+85595${String(Math.floor(1000000 + Math.random() * 8999999))}`,
        password: "ValidPassword9",
      }),
    });
    assert.equal(raw.status, 403);
    assert.equal(((await raw.json()) as { error: { code: string } }).error.code, "CAPTCHA_REQUIRED");

    // 2. Clean browser signup with silent PoW -> 200 OK
    const silentBot = await fetchSolvedChallenge("register", ip, "auto");
    const email1 = `bot-reg-ok1-${suf}@example.com`;
    const ok1 = await fetch(`${APP}/api/auth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: APP,
        "x-forwarded-for": ip,
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
      },
      body: JSON.stringify({
        name: "Legit Shopper",
        email: email1,
        phone: `+85595${String(Math.floor(1000000 + Math.random() * 8999999))}`,
        password: "ValidPassword9",
        _bot: silentBot,
      }),
    });
    assert.equal(ok1.status, 200);
    const u1 = await prisma.user.findUnique({ where: { email: email1 }, select: { id: true } });
    if (u1) createdUserIds.push(u1.id);

    // 3. Replaying the same token is rejected (403 CAPTCHA_INVALID)
    const replay = await fetch(`${APP}/api/auth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: APP,
        "x-forwarded-for": ip,
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
      },
      body: JSON.stringify({
        name: "Replay Bot",
        email: `bot-reg-replay-${suf}@example.com`,
        phone: `+85595${String(Math.floor(1000000 + Math.random() * 8999999))}`,
        password: "ValidPassword9",
        _bot: silentBot,
      }),
    });
    assert.equal(replay.status, 403);
    assert.equal(((await replay.json()) as { error: { code: string } }).error.code, "CAPTCHA_INVALID");

    // 4. 2nd signup from same IP requires interactive/accessible CAPTCHA
    const chal2Res = await fetch(`${APP}/api/bot-protection/challenge?action=register&mode=auto`, {
      headers: {
        "x-forwarded-for": ip,
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
      },
    });
    const chal2 = (await chal2Res.json()) as { mode: string; imageDataUri?: string };
    assert.equal(chal2.mode, "interactive", "2nd registration from same IP must escalate to interactive SVG CAPTCHA");
    assert.ok(chal2.imageDataUri?.startsWith("data:image/svg+xml;base64,"));
  });

  it("protects guest checkout (/api/orders), guest prescription upload (/api/uploads), promo guessing (/api/cart/quote), and password reset", async (t) => {
    if (!(await isServerReachable())) return t.skip(`No live server at ${APP}`);

    const otcMed = await prisma.medicine.findFirstOrThrow({
      where: {
        requiresPrescription: false,
        deletedAt: null,
        isActive: true,
        inventory: { quantity: { gt: 2 } },
      },
      select: { id: true },
    });

    // 1. Guest checkout without bot token -> 403 CAPTCHA_REQUIRED
    const guestIp = nextTestIp();
    const rawOrder = await fetch(`${APP}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: APP, "x-forwarded-for": guestIp },
      body: JSON.stringify({
        items: [{ medicineId: otcMed.id, quantity: 1 }],
        fullName: "Bot Hoarder",
        phone: "012 999 888",
        province: "Phnom Penh",
        district: "Doun Penh",
      }),
    });
    assert.equal(rawOrder.status, 403);
    assert.equal(((await rawOrder.json()) as { error: { code: string } }).error.code, "CAPTCHA_REQUIRED");

    // 2. Guest checkout with valid solved challenge -> 200 OK
    const guestBot = await fetchSolvedChallenge("checkout", guestIp, "auto");
    const okOrder = await fetch(`${APP}/api/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: APP,
        "x-forwarded-for": guestIp,
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
      },
      body: JSON.stringify({
        items: [{ medicineId: otcMed.id, quantity: 1 }],
        fullName: "Real Guest",
        phone: `+85512${String(Math.floor(100000 + Math.random() * 899999))}`,
        province: "Phnom Penh",
        district: "Doun Penh",
        _bot: guestBot,
      }),
    });
    assert.equal(okOrder.status, 200);
    const created = (await okOrder.json()) as { id: string };
    createdOrderIds.push(created.id);

    // 3. Guest prescription upload without bot token -> 403 CAPTCHA_REQUIRED
    const upIp = nextTestIp();
    const rawFd = new FormData();
    rawFd.append("folder", "prescriptions");
    rawFd.append("file", new File([loadValidJpeg()], "rx.jpg", { type: "image/jpeg" }));
    const rawUp = await fetch(`${APP}/api/uploads`, {
      method: "POST",
      headers: { Origin: APP, "x-forwarded-for": upIp },
      body: rawFd,
    });
    assert.equal(rawUp.status, 403);
    assert.equal(((await rawUp.json()) as { error: { code: string } }).error.code, "CAPTCHA_REQUIRED");

    // 4. Guest prescription upload WITH solved challenge -> 200 OK (or 400 if prod without local uploads)
    const upBot = await fetchSolvedChallenge("prescription_upload", upIp, "auto");
    const okFd = new FormData();
    okFd.append("folder", "prescriptions");
    okFd.append("file", new File([loadValidJpeg()], "rx.jpg", { type: "image/jpeg" }));
    okFd.append("_botProvider", upBot.provider);
    okFd.append("_botToken", upBot.token!);
    okFd.append("_botNonce", upBot.nonce!);
    const okUp = await fetch(`${APP}/api/uploads`, {
      method: "POST",
      headers: {
        Origin: APP,
        "x-forwarded-for": upIp,
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
      },
      body: okFd,
    });
    assert.ok(okUp.status === 200 || okUp.status === 400);
    if (okUp.status === 200) {
      const upJson = (await okUp.json()) as { fileName?: string };
      if (upJson.fileName) createdFiles.push(path.resolve("storage", "prescriptions", upJson.fileName));
    }

    // 5. Promo code brute-forcing on /api/cart/quote escalates after 6 invalid codes while non-discount quotes keep working!
    const promoIp = nextTestIp();
    for (let i = 0; i < 6; i++) {
      const r = await fetch(`${APP}/api/cart/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP, "x-forwarded-for": promoIp },
        body: JSON.stringify({ items: [{ medicineId: otcMed.id, quantity: 1 }], discountCode: `BADCODE${i}` }),
      });
      assert.equal(r.status, 200);
    }
    const seventhPromo = await fetch(`${APP}/api/cart/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: APP, "x-forwarded-for": promoIp },
      body: JSON.stringify({ items: [{ medicineId: otcMed.id, quantity: 1 }], discountCode: "BADCODE7" }),
    });
    assert.equal(seventhPromo.status, 403);
    assert.equal(((await seventhPromo.json()) as { error: { code: string } }).error.code, "CAPTCHA_REQUIRED");

    // Normal cart quote WITHOUT discount code still succeeds (legitimate user is never blocked from shopping!)
    const plainQuote = await fetch(`${APP}/api/cart/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: APP, "x-forwarded-for": promoIp },
      body: JSON.stringify({ items: [{ medicineId: otcMed.id, quantity: 1 }] }),
    });
    assert.equal(plainQuote.status, 200);

    // 6. Password reset request blocks honeypot & automated curl UA without CAPTCHA
    const resetIp = nextTestIp();
    const curlReset = await fetch(`${APP}/api/auth/password-reset/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: APP, "x-forwarded-for": resetIp, "user-agent": "curl/8.5.0" },
      body: JSON.stringify({ identifier: `someone-${Date.now()}@example.com` }),
    });
    assert.equal(curlReset.status, 403);
    assert.equal(((await curlReset.json()) as { error: { code: string } }).error.code, "CAPTCHA_REQUIRED");

    const hpReset = await fetch(`${APP}/api/auth/password-reset/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: APP, "x-forwarded-for": nextTestIp() },
      body: JSON.stringify({ identifier: `someone-${Date.now()}@example.com`, _bot: { hp: "spam" } }),
    });
    assert.equal(hpReset.status, 403);
    assert.equal(((await hpReset.json()) as { error: { code: string } }).error.code, "BOT_BLOCKED");
  });

  after(async () => {
    for (const id of createdOrderIds) {
      await cancelOrder(id, null, "Bot test cleanup", { system: true }).catch(() => {});
      await prisma.order.delete({ where: { id } }).catch(() => {});
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    }
    for (const fp of createdFiles) {
      await unlink(fp).catch(() => {});
    }
    await prisma.$disconnect();
  });
});
