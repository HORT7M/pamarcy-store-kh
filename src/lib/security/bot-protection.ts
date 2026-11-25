import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { clientIp } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getAuthSecret, serverEnv } from "@/lib/env";
import { botBlocked, captchaInvalid, captchaRequired } from "@/lib/errors";
import {
  generateAccessibleCaptcha,
  generateVisualCaptcha,
  normalizeCaptchaAnswer,
} from "./captcha-svg";

export type BotAction =
  | "login"
  | "admin_login"
  | "register"
  | "checkout"
  | "prescription_upload"
  | "promo_code"
  | "review"
  | "password_reset"
  | "password_reset_confirm";

export type BotProvider = "builtin" | "turnstile" | "hcaptcha";
export type ChallengeMode = "silent" | "interactive" | "accessible";
export type RiskRequirement = "none" | "silent" | "interactive";

export const BOT_ACTIONS = new Set<BotAction>([
  "login",
  "admin_login",
  "register",
  "checkout",
  "prescription_upload",
  "promo_code",
  "review",
  "password_reset",
  "password_reset_confirm",
]);

export function isBotAction(v: string): v is BotAction {
  return BOT_ACTIONS.has(v as BotAction);
}

export const botVerificationSchema = z
  .object({
    provider: z.enum(["builtin", "turnstile", "hcaptcha"]).optional(),
    token: z.string().max(4096).optional(),
    nonce: z.string().max(64).optional(),
    answer: z.string().max(32).optional(),
    hp: z.string().max(200).optional(),
  })
  .strict()
  .optional();

export type BotVerificationPayload = NonNullable<z.infer<typeof botVerificationSchema>>;

export type IssuedChallenge =
  | {
      provider: "turnstile" | "hcaptcha";
      siteKey: string;
      action: BotAction;
      mode: "managed";
      required: boolean;
      allowFallback: boolean;
    }
  | {
      provider: "builtin";
      action: BotAction;
      mode: ChallengeMode;
      required: boolean;
      token?: string;
      difficulty?: number;
      salt?: string;
      expiresAt?: number;
      imageDataUri?: string;
      prompt?: string;
    };

type BuiltinChallengeTokenPayload = {
  v: 1;
  id: string;
  act: BotAction;
  mode: ChallengeMode;
  iat: number;
  exp: number;
  ip: string;
  diff: number;
  salt: string;
  ansHash?: string;
};

type BotGlobalState = {
  /** Consumed single-use challenge IDs / external token hashes -> expiry epoch ms */
  consumed: Map<string, number>;
  /** Sliding-window timestamps of risk events -> timestamps[] */
  events: Map<string, number[]>;
  /** Audit log throttle keys -> last logged epoch ms */
  auditThrottle: Map<string, number>;
  lastSweepAt: number;
};

const MAX_STATE_ENTRIES = 50_000;
const SWEEP_INTERVAL_MS = 60_000;
const SILENT_CHALLENGE_TTL_MS = 15 * 60_000;
const INTERACTIVE_CHALLENGE_TTL_MS = 10 * 60_000;
const EXTERNAL_TOKEN_REPLAY_TTL_MS = 10 * 60_000;
const INTERACTIVE_MIN_SOLVE_MS = 250;

const AUTOMATED_UA_RE =
  /\b(curl|wget|python-requests|python-urllib|httpx|aiohttp|go-http-client|scrapy|headlesschrome|phantomjs|selenium|playwright|puppeteer|mechanize|libwww-perl|nikto|sqlmap|masscan|zgrab|apachebench|wrk)\b/i;

const globalForBot = globalThis as unknown as { __pamarcyBotState?: BotGlobalState };

function getState(): BotGlobalState {
  if (!globalForBot.__pamarcyBotState) {
    globalForBot.__pamarcyBotState = {
      consumed: new Map(),
      events: new Map(),
      auditThrottle: new Map(),
      lastSweepAt: Date.now(),
    };
  }
  return globalForBot.__pamarcyBotState;
}

function maybeSweep(state: BotGlobalState, now: number) {
  const size = state.consumed.size + state.events.size + state.auditThrottle.size;
  if (size < MAX_STATE_ENTRIES && now - state.lastSweepAt < SWEEP_INTERVAL_MS) return;
  state.lastSweepAt = now;

  for (const [k, exp] of state.consumed) {
    if (exp <= now) state.consumed.delete(k);
  }
  for (const [k, list] of state.events) {
    while (list.length > 0 && list[0]! <= now - 60 * 60_000) list.shift();
    if (list.length === 0) state.events.delete(k);
  }
  for (const [k, ts] of state.auditThrottle) {
    if (now - ts >= 5 * 60_000) state.auditThrottle.delete(k);
  }

  // Hard cap eviction to prevent memory pressure under cardinality attacks
  for (const map of [state.consumed, state.events, state.auditThrottle] as const) {
    if (map.size > MAX_STATE_ENTRIES) {
      const excess = map.size - MAX_STATE_ENTRIES;
      let i = 0;
      for (const k of map.keys()) {
        map.delete(k);
        if (++i >= excess) break;
      }
    }
  }
}

/** Normalize IPv6 to /64 prefix so privacy-extension rotations on mobile never invalidate challenges. */
function ipBindingKey(ip: string): string {
  const norm = ip.trim().toLowerCase();
  if (norm.includes(":")) {
    const groups = norm.split(":").slice(0, 4).join(":");
    return createHash("sha256").update(`v6:${groups}`).digest("base64url").slice(0, 16);
  }
  return createHash("sha256").update(`v4:${norm}`).digest("base64url").slice(0, 16);
}

function signPayload(payloadB64: string): string {
  return createHmac("sha256", getAuthSecret()).update(`bot-chal:v1:${payloadB64}`).digest("base64url");
}

function hashAnswer(challengeId: string, normalizedAnswer: string): string {
  return createHmac("sha256", getAuthSecret()).update(`bot-ans:v1:${challengeId}:${normalizedAnswer}`).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Check whether SHA-256(`${salt}:${nonce}`) has at least `difficulty` leading zero bits. */
export function verifyPowNonce(salt: string, nonce: string, difficulty: number): boolean {
  if (difficulty <= 0) return true;
  if (!nonce || nonce.length > 64 || !/^[A-Za-z0-9_-]+$/.test(nonce)) return false;
  const digest = createHash("sha256").update(`${salt}:${nonce}`).digest();
  const fullBytes = Math.floor(difficulty / 8);
  const remBits = difficulty % 8;
  for (let i = 0; i < fullBytes; i++) {
    if (digest[i] !== 0) return false;
  }
  if (remBits > 0) {
    const mask = (0xff << (8 - remBits)) & 0xff;
    if ((digest[fullBytes]! & mask) !== 0) return false;
  }
  return true;
}

/** Helper used in tests or CLI scripts to solve a PoW challenge. */
export function solvePowSync(salt: string, difficulty: number): string {
  for (let n = 0; n < 50_000_000; n++) {
    const nonce = n.toString(36);
    if (verifyPowNonce(salt, nonce, difficulty)) return nonce;
  }
  throw new Error("Unable to solve PoW within iteration cap");
}

export function resolveConfiguredProvider(): BotProvider {
  const cfg = serverEnv.botProtection;
  if (cfg.provider === "turnstile" && cfg.turnstileConfigured) return "turnstile";
  if (cfg.provider === "hcaptcha" && cfg.hcaptchaConfigured) return "hcaptcha";
  if (cfg.provider === "builtin") return "builtin";
  // auto mode: prefer Turnstile -> hCaptcha -> builtin
  if (cfg.turnstileConfigured) return "turnstile";
  if (cfg.hcaptchaConfigured) return "hcaptcha";
  return "builtin";
}

// ───────────────────── Sliding-Window Risk Signals ─────────────────────

export function recordRiskEvent(key: string, now = Date.now()) {
  const state = getState();
  maybeSweep(state, now);
  let list = state.events.get(key);
  if (!list) {
    list = [];
    state.events.set(key, list);
  }
  list.push(now);
  if (list.length > 500) list.splice(0, list.length - 500);
}

export function countRiskEvents(key: string, windowMs: number, now = Date.now()): number {
  const state = getState();
  const list = state.events.get(key);
  if (!list || list.length === 0) return 0;
  const cutoff = now - windowMs;
  while (list.length > 0 && list[0]! <= cutoff) list.shift();
  if (list.length === 0) state.events.delete(key);
  return list.length;
}

export function clearRiskEvent(key: string) {
  getState().events.delete(key);
}

export function recordLoginFailureSignal(ip: string, normalizedIdentifier: string) {
  recordRiskEvent(`login:fail:ip_id:${ip}:${normalizedIdentifier}`);
  recordRiskEvent(`login:fail:ip:${ip}`);
  recordRiskEvent(`login:fail:id:${normalizedIdentifier}`);
}

export function clearLoginFailureSignal(ip: string, normalizedIdentifier: string) {
  clearRiskEvent(`login:fail:ip_id:${ip}:${normalizedIdentifier}`);
}

export function recordRegistrationSuccessSignal(ip: string) {
  recordRiskEvent(`register:ok:ip:${ip}`);
}

export function recordRegistrationFailureSignal(ip: string) {
  recordRiskEvent(`register:fail:ip:${ip}`);
}

export function recordGuestCheckoutSignal(ip: string, phone?: string | null) {
  recordRiskEvent(`checkout:guest:ip:${ip}`);
  if (phone) recordRiskEvent(`checkout:guest:phone:${phone}`);
}

export function recordGuestUploadSignal(ip: string) {
  recordRiskEvent(`upload:guest:ip:${ip}`);
}

export function recordPromoFailureSignal(ip: string) {
  recordRiskEvent(`promo:fail:ip:${ip}`);
}

export function clearPromoFailureSignal(ip: string) {
  clearRiskEvent(`promo:fail:ip:${ip}`);
}

export function recordPasswordResetRequestSignal(ip: string) {
  recordRiskEvent(`pwreset:req:ip:${ip}`);
}

export function recordReviewSignal(ip: string, customerId: string) {
  recordRiskEvent(`review:cust:${customerId}`);
  recordRiskEvent(`review:ip:${ip}`);
}

export function hasAutomatedClientHeaders(req: NextRequest | Request): boolean {
  const ua = req.headers.get("user-agent")?.trim() ?? "";
  if (!ua || ua.length < 8) return true;
  if (AUTOMATED_UA_RE.test(ua)) return true;
  return false;
}

async function auditBotEvent(
  ip: string,
  action: BotAction,
  event: "bot.honeypot_triggered" | "bot.captcha_failed" | "bot.captcha_required" | "bot.external_error",
  meta: Record<string, string | number | boolean | null>,
  userId?: string | null,
) {
  const state = getState();
  const now = Date.now();
  const throttleKey = `${event}:${action}:${ip}`;
  const last = state.auditThrottle.get(throttleKey) ?? 0;
  if (now - last < 60_000) return;
  state.auditThrottle.set(throttleKey, now);
  try {
    await audit(userId ?? null, event, "BotProtection", action, { ip, ...meta });
  } catch {
    /* never fail request handling on audit logging error */
  }
}

export type RiskContext = {
  action: BotAction;
  ip: string;
  identifier?: string | null;
  authenticated?: boolean;
  recentUnpaidOrders?: number;
  automatedHeaders?: boolean;
};

/**
 * Determine the required level of verification for a request:
 * - "none": completely frictionless (legitimate users see zero CAPTCHA)
 * - "silent": invisible PoW / Turnstile managed widget (zero clicks for real browsers)
 * - "interactive": explicit human CAPTCHA (SVG math / accessible prompt / Turnstile)
 */
export function assessBotRequirement(ctx: RiskContext): RiskRequirement {
  const { action, ip, identifier, authenticated = false, recentUnpaidOrders = 0, automatedHeaders = false } = ctx;
  const recentHoneypot = countRiskEvents(`honeypot:ip:${ip}`, 30 * 60_000);
  const recentCaptchaFails = countRiskEvents(`captcha:fail:ip:${ip}`, 15 * 60_000);

  if (recentHoneypot > 0 || recentCaptchaFails >= 3) {
    return "interactive";
  }

  switch (action) {
    case "admin_login": {
      const ipIdFails = identifier ? countRiskEvents(`login:fail:ip_id:${ip}:${identifier}`, 15 * 60_000) : 0;
      const ipFails = countRiskEvents(`login:fail:ip:${ip}`, 15 * 60_000);
      const idFails = identifier ? countRiskEvents(`login:fail:id:${identifier}`, 15 * 60_000) : 0;
      if (ipIdFails >= 2 || ipFails >= 3 || idFails >= 3) return "interactive";
      return "none";
    }

    case "login": {
      const ipIdFails = identifier ? countRiskEvents(`login:fail:ip_id:${ip}:${identifier}`, 15 * 60_000) : 0;
      const ipFails = countRiskEvents(`login:fail:ip:${ip}`, 15 * 60_000);
      const idFails = identifier ? countRiskEvents(`login:fail:id:${identifier}`, 15 * 60_000) : 0;
      if (ipIdFails >= 3 || ipFails >= 5 || idFails >= 4) return "interactive";
      return "none";
    }

    case "register": {
      const recentSignups = countRiskEvents(`register:ok:ip:${ip}`, 15 * 60_000);
      const recentFails = countRiskEvents(`register:fail:ip:${ip}`, 15 * 60_000);
      if (recentSignups >= 1 || recentFails >= 2 || automatedHeaders) return "interactive";
      return "silent";
    }

    case "checkout": {
      if (authenticated) {
        if (recentUnpaidOrders >= 2) return "interactive";
        return "none";
      }
      const recentGuestOrders = countRiskEvents(`checkout:guest:ip:${ip}`, 30 * 60_000);
      const recentPhoneOrders = identifier ? countRiskEvents(`checkout:guest:phone:${identifier}`, 30 * 60_000) : 0;
      if (recentUnpaidOrders >= 1 || recentGuestOrders >= 2 || recentPhoneOrders >= 2 || automatedHeaders) {
        return "interactive";
      }
      return "silent";
    }

    case "prescription_upload": {
      if (authenticated) {
        return "none";
      }
      const recentUploads = countRiskEvents(`upload:guest:ip:${ip}`, 15 * 60_000);
      if (recentUploads >= 3 || automatedHeaders) return "interactive";
      return "silent";
    }

    case "promo_code": {
      const promoFails = countRiskEvents(`promo:fail:ip:${ip}`, 15 * 60_000);
      if (promoFails >= 6) return "interactive";
      return "none";
    }

    case "password_reset": {
      const recentResets = countRiskEvents(`pwreset:req:ip:${ip}`, 15 * 60_000);
      if (recentResets >= 6 || automatedHeaders) return "interactive";
      return "none";
    }

    case "password_reset_confirm": {
      if (automatedHeaders) return "interactive";
      return "none";
    }

    case "review": {
      const custReviews = identifier ? countRiskEvents(`review:cust:${identifier}`, 10 * 60_000) : 0;
      const ipReviews = countRiskEvents(`review:ip:${ip}`, 10 * 60_000);
      if (custReviews >= 4 || ipReviews >= 6) return "interactive";
      return "none";
    }
  }
}

// ───────────────────── Challenge Issuance ─────────────────────

export function issueBotChallenge(
  req: NextRequest | Request,
  opts: {
    action: BotAction;
    requestedMode?: "auto" | "interactive" | "accessible";
    fallbackBuiltin?: boolean;
    locale?: "km" | "en";
    identifier?: string | null;
    authenticated?: boolean;
    recentUnpaidOrders?: number;
  },
): IssuedChallenge {
  const ip = clientIp(req);
  const automatedHeaders = hasAutomatedClientHeaders(req);
  const requirement = assessBotRequirement({
    action: opts.action,
    ip,
    identifier: opts.identifier,
    authenticated: opts.authenticated,
    recentUnpaidOrders: opts.recentUnpaidOrders,
    automatedHeaders,
  });

  const configured = resolveConfiguredProvider();
  const useBuiltin =
    configured === "builtin" ||
    opts.requestedMode === "accessible" ||
    Boolean(opts.fallbackBuiltin && serverEnv.botProtection.allowBuiltinFallback);

  if (!useBuiltin && configured === "turnstile") {
    return {
      provider: "turnstile",
      siteKey: serverEnv.botProtection.turnstileSiteKey,
      action: opts.action,
      mode: "managed",
      required: requirement !== "none" || opts.requestedMode === "interactive",
      allowFallback: serverEnv.botProtection.allowBuiltinFallback,
    };
  }

  if (!useBuiltin && configured === "hcaptcha") {
    return {
      provider: "hcaptcha",
      siteKey: serverEnv.botProtection.hcaptchaSiteKey,
      action: opts.action,
      mode: "managed",
      required: requirement !== "none" || opts.requestedMode === "interactive",
      allowFallback: serverEnv.botProtection.allowBuiltinFallback,
    };
  }

  // Built-in self-hosted challenge
  let mode: ChallengeMode;
  if (opts.requestedMode === "accessible") {
    mode = "accessible";
  } else if (opts.requestedMode === "interactive" || opts.fallbackBuiltin || requirement === "interactive") {
    mode = "interactive";
  } else {
    mode = "silent";
  }

  const required = requirement !== "none" || opts.requestedMode === "interactive" || opts.requestedMode === "accessible";
  if (!required) {
    return { provider: "builtin", action: opts.action, mode: "silent", required: false };
  }

  const now = Date.now();
  const id = randomBytes(16).toString("hex");
  const salt = randomBytes(12).toString("hex");
  const baseDiff = serverEnv.botProtection.powDifficulty;
  const difficulty = mode === "silent" ? baseDiff : Math.max(10, baseDiff - 2);
  const ttl = mode === "silent" ? SILENT_CHALLENGE_TTL_MS : INTERACTIVE_CHALLENGE_TTL_MS;

  let ansHash: string | undefined;
  let imageDataUri: string | undefined;
  let prompt: string | undefined;

  if (mode === "interactive") {
    const visual = generateVisualCaptcha();
    imageDataUri = visual.imageDataUri;
    ansHash = hashAnswer(id, visual.answer);
  } else if (mode === "accessible") {
    const acc = generateAccessibleCaptcha(opts.locale === "en" ? "en" : "km");
    prompt = acc.prompt;
    ansHash = hashAnswer(id, acc.answer);
  }

  const payload: BuiltinChallengeTokenPayload = {
    v: 1,
    id,
    act: opts.action,
    mode,
    iat: now,
    exp: now + ttl,
    ip: ipBindingKey(ip),
    diff: difficulty,
    salt,
    ...(ansHash ? { ansHash } : {}),
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const token = `${payloadB64}.${signPayload(payloadB64)}`;

  return {
    provider: "builtin",
    action: opts.action,
    mode,
    required: true,
    token,
    difficulty,
    salt,
    expiresAt: payload.exp,
    ...(imageDataUri ? { imageDataUri } : {}),
    ...(prompt ? { prompt } : {}),
  };
}

// ───────────────────── External Provider Siteverify ─────────────────────

function expectedHostnames(req: NextRequest | Request): string[] {
  const explicit = serverEnv.botProtection.allowedHostnames;
  if (explicit.length > 0) return explicit;
  const out = new Set<string>();
  try {
    const appHost = new URL(serverEnv.appUrl).hostname.toLowerCase();
    if (appHost && appHost !== "localhost" && appHost !== "127.0.0.1") out.add(appHost);
  } catch {
    /* ignore */
  }
  const reqHost = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").split(":")[0]?.trim().toLowerCase();
  if (reqHost && reqHost !== "localhost" && reqHost !== "127.0.0.1") out.add(reqHost);
  return [...out];
}

async function verifyTurnstileToken(
  req: NextRequest | Request,
  token: string,
  action: BotAction,
  ip: string,
): Promise<void> {
  const secret = serverEnv.botProtection.turnstileSecretKey;
  if (!secret) throw captchaInvalid("CAPTCHA provider is not configured on the server.");

  const replayKey = `ext:turnstile:${createHash("sha256").update(token).digest("hex")}`;
  const state = getState();
  const now = Date.now();
  maybeSweep(state, now);
  if (state.consumed.has(replayKey)) {
    throw captchaInvalid("Verification token was already used. Please verify again.", { action, provider: "turnstile" });
  }

  let data: { success?: boolean; action?: string; hostname?: string; "error-codes"?: string[] };
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip !== "local") body.set("remoteip", ip);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Turnstile HTTP ${res.status}`);
    data = (await res.json()) as typeof data;
  } catch (err) {
    console.error("[bot-protection] Turnstile verification error:", err);
    await auditBotEvent(ip, action, "bot.external_error", { provider: "turnstile" });
    throw captchaInvalid("Verification service is temporarily unavailable. Please try again.", {
      action,
      provider: "turnstile",
      allowFallback: serverEnv.botProtection.allowBuiltinFallback,
    });
  }

  if (!data.success) {
    recordRiskEvent(`captcha:fail:ip:${ip}`);
    await auditBotEvent(ip, action, "bot.captcha_failed", {
      provider: "turnstile",
      codes: (data["error-codes"] ?? []).join(","),
    });
    throw captchaInvalid("Human verification failed. Please complete the check again.", { action, provider: "turnstile" });
  }

  if (data.action && data.action !== action) {
    recordRiskEvent(`captcha:fail:ip:${ip}`);
    throw captchaInvalid("Verification token action mismatch. Please try again.", { action, provider: "turnstile" });
  }

  if (serverEnv.isProduction && data.hostname) {
    const allowed = expectedHostnames(req);
    if (allowed.length > 0 && !allowed.includes(data.hostname.toLowerCase())) {
      recordRiskEvent(`captcha:fail:ip:${ip}`);
      throw captchaInvalid("Verification hostname mismatch.", { action, provider: "turnstile" });
    }
  }

  state.consumed.set(replayKey, now + EXTERNAL_TOKEN_REPLAY_TTL_MS);
}

async function verifyHcaptchaToken(
  req: NextRequest | Request,
  token: string,
  action: BotAction,
  ip: string,
): Promise<void> {
  const secret = serverEnv.botProtection.hcaptchaSecretKey;
  const sitekey = serverEnv.botProtection.hcaptchaSiteKey;
  if (!secret || !sitekey) throw captchaInvalid("CAPTCHA provider is not configured on the server.");

  const replayKey = `ext:hcaptcha:${createHash("sha256").update(token).digest("hex")}`;
  const state = getState();
  const now = Date.now();
  maybeSweep(state, now);
  if (state.consumed.has(replayKey)) {
    throw captchaInvalid("Verification token was already used. Please verify again.", { action, provider: "hcaptcha" });
  }

  let data: { success?: boolean; hostname?: string; "error-codes"?: string[] };
  try {
    const body = new URLSearchParams({ secret, response: token, sitekey });
    if (ip !== "local") body.set("remoteip", ip);
    const res = await fetch("https://api.hcaptcha.com/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`hCaptcha HTTP ${res.status}`);
    data = (await res.json()) as typeof data;
  } catch (err) {
    console.error("[bot-protection] hCaptcha verification error:", err);
    await auditBotEvent(ip, action, "bot.external_error", { provider: "hcaptcha" });
    throw captchaInvalid("Verification service is temporarily unavailable. Please try again.", {
      action,
      provider: "hcaptcha",
      allowFallback: serverEnv.botProtection.allowBuiltinFallback,
    });
  }

  if (!data.success) {
    recordRiskEvent(`captcha:fail:ip:${ip}`);
    await auditBotEvent(ip, action, "bot.captcha_failed", {
      provider: "hcaptcha",
      codes: (data["error-codes"] ?? []).join(","),
    });
    throw captchaInvalid("Human verification failed. Please complete the check again.", { action, provider: "hcaptcha" });
  }

  if (serverEnv.isProduction && data.hostname) {
    const allowed = expectedHostnames(req);
    if (allowed.length > 0 && !allowed.includes(data.hostname.toLowerCase())) {
      recordRiskEvent(`captcha:fail:ip:${ip}`);
      throw captchaInvalid("Verification hostname mismatch.", { action, provider: "hcaptcha" });
    }
  }

  state.consumed.set(replayKey, now + EXTERNAL_TOKEN_REPLAY_TTL_MS);
}

// ───────────────────── Built-in Server-Side Verification ─────────────────────

async function verifyBuiltinToken(
  payload: BotVerificationPayload,
  action: BotAction,
  requirement: RiskRequirement,
  ip: string,
  requireInteractiveBecauseFallback: boolean,
  userId?: string | null,
): Promise<void> {
  const token = payload.token?.trim() ?? "";
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) {
    recordRiskEvent(`captcha:fail:ip:${ip}`);
    throw captchaInvalid("Invalid verification token. Please try again.", { action, provider: "builtin", mode: requirement === "interactive" ? "interactive" : "silent" });
  }

  const payloadB64 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  const expectedSig = signPayload(payloadB64);
  if (!safeEqual(providedSig, expectedSig)) {
    recordRiskEvent(`captcha:fail:ip:${ip}`);
    await auditBotEvent(ip, action, "bot.captcha_failed", { reason: "bad_signature" }, userId);
    throw captchaInvalid("Invalid verification token. Please try again.", { action, provider: "builtin", mode: "interactive" });
  }

  let parsed: BuiltinChallengeTokenPayload;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as BuiltinChallengeTokenPayload;
  } catch {
    throw captchaInvalid("Malformed verification token. Please try again.", { action, provider: "builtin", mode: "interactive" });
  }

  const now = Date.now();
  if (parsed.v !== 1 || parsed.act !== action || !parsed.id || !parsed.salt) {
    recordRiskEvent(`captcha:fail:ip:${ip}`);
    throw captchaInvalid("Verification token does not match this action. Please try again.", { action, provider: "builtin", mode: "interactive" });
  }

  if (parsed.exp <= now || parsed.iat > now + 5_000) {
    throw captchaInvalid("Verification expired. Please try again.", {
      action,
      provider: "builtin",
      mode: parsed.mode === "silent" ? (requirement === "interactive" ? "interactive" : "silent") : parsed.mode,
    });
  }

  if (!safeEqual(parsed.ip, ipBindingKey(ip))) {
    throw captchaInvalid("Verification session changed. Please complete verification again.", {
      action,
      provider: "builtin",
      mode: requirement === "interactive" ? "interactive" : parsed.mode,
    });
  }

  const state = getState();
  maybeSweep(state, now);
  const consumeKey = `builtin:${parsed.id}`;
  if (state.consumed.has(consumeKey)) {
    recordRiskEvent(`captcha:fail:ip:${ip}`);
    await auditBotEvent(ip, action, "bot.captcha_failed", { reason: "replay" }, userId);
    throw captchaInvalid("Verification already used. Please verify again.", {
      action,
      provider: "builtin",
      mode: requirement === "interactive" ? "interactive" : parsed.mode,
    });
  }

  // Enforce mode strength: never allow a silent token when interactive CAPTCHA is required
  const mustBeInteractive = requirement === "interactive" || requireInteractiveBecauseFallback;
  if (mustBeInteractive && parsed.mode === "silent") {
    throw captchaRequired("Please solve the quick verification check to continue.", {
      action,
      provider: "builtin",
      mode: "interactive",
    });
  }

  // Dwell-time sanity check:
  // If a silent form was submitted unusually fast (e.g. script or password manager autofill),
  // gracefully step up to interactive CAPTCHA instead of hard-blocking a legitimate user!
  const elapsedMs = now - parsed.iat;
  const minSilentMs = serverEnv.botProtection.minSubmitMs;
  if (parsed.mode === "silent" && elapsedMs < minSilentMs) {
    throw captchaRequired("Please complete the quick verification check to continue.", {
      action,
      provider: "builtin",
      mode: "interactive",
    });
  }
  if ((parsed.mode === "interactive" || parsed.mode === "accessible") && elapsedMs < INTERACTIVE_MIN_SOLVE_MS) {
    state.consumed.set(consumeKey, parsed.exp);
    recordRiskEvent(`captcha:fail:ip:${ip}`);
    throw captchaInvalid("Submission was too fast. Please complete the verification check again.", {
      action,
      provider: "builtin",
      mode: parsed.mode,
    });
  }

  // Verify SHA-256 Proof-of-Work nonce
  if (!verifyPowNonce(parsed.salt, payload.nonce ?? "", parsed.diff)) {
    recordRiskEvent(`captcha:fail:ip:${ip}`);
    await auditBotEvent(ip, action, "bot.captcha_failed", { reason: "bad_pow" }, userId);
    throw captchaInvalid("Browser verification check failed. Please try again.", {
      action,
      provider: "builtin",
      mode: parsed.mode,
    });
  }

  // Verify human math answer for interactive / accessible challenges
  if (parsed.mode === "interactive" || parsed.mode === "accessible") {
    // Always consume on attempt to prevent brute-forcing answers against one signed token
    state.consumed.set(consumeKey, parsed.exp);
    const normalized = normalizeCaptchaAnswer(payload.answer ?? "");
    if (!normalized || !parsed.ansHash || !safeEqual(hashAnswer(parsed.id, normalized), parsed.ansHash)) {
      recordRiskEvent(`captcha:fail:ip:${ip}`);
      await auditBotEvent(ip, action, "bot.captcha_failed", { reason: "wrong_answer" }, userId);
      throw captchaInvalid("Incorrect verification answer. Please try the new puzzle.", {
        action,
        provider: "builtin",
        mode: parsed.mode,
      });
    }
    return;
  }

  // Consume silent token after full verification
  state.consumed.set(consumeKey, parsed.exp);
}

// ───────────────────── Unified Entrypoint ─────────────────────

/** Extract bot payload from JSON body `_bot` (or headers / FormData). */
export function extractBotPayload(
  req: NextRequest | Request,
  bodyBot?: BotVerificationPayload | null,
  formData?: FormData,
): BotVerificationPayload {
  const fromForm = (k: string) => {
    const v = formData?.get(k);
    return typeof v === "string" ? v : undefined;
  };
  const fromHeader = (k: string) => req.headers.get(k) ?? undefined;

  const rawProvider = bodyBot?.provider ?? fromForm("_botProvider") ?? fromHeader("x-bot-provider");
  const provider: BotProvider | undefined =
    rawProvider === "builtin" || rawProvider === "turnstile" || rawProvider === "hcaptcha" ? rawProvider : undefined;

  return {
    provider,
    token: bodyBot?.token ?? fromForm("_botToken") ?? fromHeader("x-bot-token"),
    nonce: bodyBot?.nonce ?? fromForm("_botNonce") ?? fromHeader("x-bot-nonce"),
    answer: bodyBot?.answer ?? fromForm("_botAnswer") ?? fromHeader("x-bot-answer"),
    hp: bodyBot?.hp ?? fromForm("_hp") ?? fromForm("pamarcy_verification_aux") ?? fromHeader("x-bot-hp"),
  };
}

/**
 * Enforce server-side bot protection and adaptive CAPTCHA verification for a public endpoint.
 * Throws ApiError(403, BOT_DETECTED | CAPTCHA_REQUIRED | CAPTCHA_INVALID) on rejection.
 */
export async function verifyBotProtection(
  req: NextRequest | Request,
  opts: {
    action: BotAction;
    bot?: BotVerificationPayload | null;
    formData?: FormData;
    identifier?: string | null;
    authenticated?: boolean;
    userId?: string | null;
    recentUnpaidOrders?: number;
  },
): Promise<{ requirement: RiskRequirement; verified: boolean }> {
  const ip = clientIp(req);
  const payload = extractBotPayload(req, opts.bot, opts.formData);

  // 1. Autofill-safe honeypot trap (always enforced)
  if (typeof payload.hp === "string" && payload.hp.trim().length > 0) {
    recordRiskEvent(`honeypot:ip:${ip}`);
    await auditBotEvent(ip, opts.action, "bot.honeypot_triggered", { authenticated: Boolean(opts.authenticated) }, opts.userId);
    throw botBlocked();
  }

  // 2. Assess dynamic risk requirement for this request
  const requirement = assessBotRequirement({
    action: opts.action,
    ip,
    identifier: opts.identifier,
    authenticated: opts.authenticated,
    recentUnpaidOrders: opts.recentUnpaidOrders,
    automatedHeaders: hasAutomatedClientHeaders(req),
  });

  if (requirement === "none") {
    return { requirement, verified: false };
  }

  const configured = resolveConfiguredProvider();

  // 3. Require token when verification is necessary
  if (!payload.token?.trim()) {
    await auditBotEvent(ip, opts.action, "bot.captcha_required", { requirement, provider: configured }, opts.userId);
    throw captchaRequired(
      requirement === "interactive"
        ? "Please complete the human verification check to continue."
        : "Browser verification is required. Please wait a moment and try again.",
      {
        action: opts.action,
        mode: requirement,
        provider: configured,
      },
    );
  }

  // 4. Verify token server-side according to active provider (with safe interactive fallback)
  const chosenProvider = payload.provider ?? configured;

  if (chosenProvider === "turnstile" && serverEnv.botProtection.turnstileConfigured) {
    await verifyTurnstileToken(req, payload.token.trim(), opts.action, ip);
    return { requirement, verified: true };
  }

  if (chosenProvider === "hcaptcha" && serverEnv.botProtection.hcaptchaConfigured) {
    await verifyHcaptchaToken(req, payload.token.trim(), opts.action, ip);
    return { requirement, verified: true };
  }

  // Built-in verification (either primary provider OR explicit interactive fallback when external script was blocked)
  if (configured !== "builtin" && !serverEnv.botProtection.allowBuiltinFallback) {
    throw captchaInvalid("External verification provider is required.", { action: opts.action, provider: configured });
  }

  const requireInteractiveBecauseFallback = configured !== "builtin";
  await verifyBuiltinToken(payload, opts.action, requirement, ip, requireInteractiveBecauseFallback, opts.userId);
  return { requirement, verified: true };
}

/** Reset in-memory bot protection state (for deterministic automated tests). */
export function resetBotProtectionState() {
  const state = getState();
  state.consumed.clear();
  state.events.clear();
  state.auditThrottle.clear();
}
