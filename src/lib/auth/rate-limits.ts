import "server-only";
import { tooManyRequests } from "@/lib/errors";
import { normalizeKhPhone } from "@/lib/phone";
import {
  checkCooldown,
  clearFailures,
  rateLimit,
  rateLimitMulti,
  recordFailure,
  recordFailures,
  setFixedCooldown,
  throttleDelay,
  type CooldownPolicy,
  type RateLimitResult,
} from "@/lib/rate-limit";

/**
 * Normalize an email or Cambodian phone number into a canonical rate-limit identifier
 * so formatting variations ("012 345 678", "+85512345678", "USER@Mail.com") share the same bucket.
 */
export function normalizeAuthIdentifier(identifier: string): string {
  const trimmed = identifier.trim();
  return normalizeKhPhone(trimmed) ?? trimmed.toLowerCase();
}

export function formatWaitDuration(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const mins = Math.ceil(s / 60);
  return `${mins} minute${mins === 1 ? "" : "s"}`;
}

export const AUTH_POLICIES = {
  login: {
    ipBurst: { limit: 10, windowMs: 60_000 },
    ipSustained: { limit: 30, windowMs: 15 * 60_000 },
    customerIpIdCooldown: {
      maxAttempts: 5,
      failureWindowMs: 15 * 60_000,
      cooldownScheduleMs: [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000],
      softDelayBaseMs: 150,
      maxSoftDelayMs: 450,
    } satisfies CooldownPolicy,
    adminIpIdCooldown: {
      maxAttempts: 4,
      failureWindowMs: 15 * 60_000,
      cooldownScheduleMs: [2 * 60_000, 10 * 60_000, 30 * 60_000],
      softDelayBaseMs: 200,
      maxSoftDelayMs: 600,
    } satisfies CooldownPolicy,
    identifierCooldown: {
      maxAttempts: 10,
      failureWindowMs: 15 * 60_000,
      cooldownScheduleMs: [2 * 60_000, 5 * 60_000, 15 * 60_000],
    } satisfies CooldownPolicy,
    userCooldown: {
      maxAttempts: 8,
      failureWindowMs: 15 * 60_000,
      cooldownScheduleMs: [2 * 60_000, 10 * 60_000, 30 * 60_000],
    } satisfies CooldownPolicy,
    ipSprayCooldown: {
      maxAttempts: 12,
      failureWindowMs: 15 * 60_000,
      cooldownScheduleMs: [2 * 60_000, 10 * 60_000, 30 * 60_000],
    } satisfies CooldownPolicy,
  },

  register: {
    ipBurst: { limit: 5, windowMs: 60_000 },
    ip15m: { limit: 8, windowMs: 15 * 60_000 },
    ip1h: { limit: 15, windowMs: 60 * 60_000 },
    identifier15m: { limit: 3, windowMs: 15 * 60_000 },
    ipFailureCooldown: {
      maxAttempts: 5,
      failureWindowMs: 15 * 60_000,
      cooldownScheduleMs: [2 * 60_000, 10 * 60_000, 30 * 60_000],
      softDelayBaseMs: 150,
      maxSoftDelayMs: 450,
    } satisfies CooldownPolicy,
  },

  passwordResetRequest: {
    ipBurst: { limit: 5, windowMs: 60_000 },
    ip15m: { limit: 10, windowMs: 15 * 60_000 },
    ip1h: { limit: 20, windowMs: 60 * 60_000 },
    identifierResendCooldownMs: 60_000,
    identifier15m: { limit: 3, windowMs: 15 * 60_000 },
    identifier1h: { limit: 5, windowMs: 60 * 60_000 },
  },

  passwordResetConfirm: {
    ipBurst: { limit: 5, windowMs: 60_000 },
    ip15m: { limit: 15, windowMs: 15 * 60_000 },
    ipFailureCooldown: {
      maxAttempts: 5,
      failureWindowMs: 15 * 60_000,
      cooldownScheduleMs: [2 * 60_000, 10 * 60_000, 30 * 60_000],
      softDelayBaseMs: 200,
      maxSoftDelayMs: 600,
    } satisfies CooldownPolicy,
  },

  passwordChange: {
    ipBurst: { limit: 6, windowMs: 60_000 },
    user15m: { limit: 8, windowMs: 15 * 60_000 },
    failureCooldown: {
      maxAttempts: 5,
      failureWindowMs: 15 * 60_000,
      cooldownScheduleMs: [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000],
      softDelayBaseMs: 150,
      maxSoftDelayMs: 450,
    } satisfies CooldownPolicy,
  },

  sessionMe: {
    ipPerMin: { limit: 60, windowMs: 60_000 },
    badCookieCooldown: {
      maxAttempts: 15,
      failureWindowMs: 5 * 60_000,
      cooldownScheduleMs: [60_000, 5 * 60_000, 15 * 60_000],
    } satisfies CooldownPolicy,
  },

  logout: {
    ipPerMin: { limit: 15, windowMs: 60_000 },
  },

  cron: {
    ipPerMin: { limit: 10, windowMs: 60_000 },
    badSecretCooldown: {
      maxAttempts: 5,
      failureWindowMs: 15 * 60_000,
      cooldownScheduleMs: [5 * 60_000, 15 * 60_000, 60 * 60_000],
    } satisfies CooldownPolicy,
  },
} as const;

// ─────────────────────── Login Guard ───────────────────────

export const loginKeys = (ip: string, normalizedId: string, userId?: string) => ({
  ipSpray: `auth:login:fail:ip:${ip}`,
  ipId: `auth:login:fail:ip_id:${ip}:${normalizedId}`,
  id: `auth:login:fail:id:${normalizedId}`,
  ...(userId ? { uid: `auth:login:fail:uid:${userId}` } : {}),
});

export function enforceLoginIpLimit(ip: string): RateLimitResult {
  const cd = checkCooldown(`auth:login:fail:ip:${ip}`);
  if (!cd.ok) {
    throw tooManyRequests(
      `Too many failed login attempts from this network. Please wait ${formatWaitDuration(cd.retryAfter)} before trying again.`,
      cd.retryAfter,
      { resetAt: cd.resetAt, reason: "cooldown" },
    );
  }
  const rl = rateLimitMulti([
    { key: `auth:login:ip:1m:${ip}`, ...AUTH_POLICIES.login.ipBurst },
    { key: `auth:login:ip:15m:${ip}`, ...AUTH_POLICIES.login.ipSustained },
  ]);
  if (!rl.ok) {
    throw tooManyRequests(
      `Too many login requests. Please wait ${formatWaitDuration(rl.retryAfter)} before trying again.`,
      rl.retryAfter,
      { limit: rl.limit, resetAt: rl.resetAt, reason: "rate_limit" },
    );
  }
  return rl;
}

export function enforceLoginIdentifierCooldown(ip: string, normalizedId: string) {
  const keys = loginKeys(ip, normalizedId);
  const cd = checkCooldown([keys.ipId, keys.id]);
  if (!cd.ok) {
    throw tooManyRequests(
      `Too many login attempts. Please wait ${formatWaitDuration(cd.retryAfter)} before trying again.`,
      cd.retryAfter,
      { resetAt: cd.resetAt, reason: "cooldown" },
    );
  }
}

export function enforceLoginUserCooldown(userId: string) {
  const cd = checkCooldown(`auth:login:fail:uid:${userId}`);
  if (!cd.ok) {
    throw tooManyRequests(
      `Too many login attempts. Please wait ${formatWaitDuration(cd.retryAfter)} before trying again.`,
      cd.retryAfter,
      { resetAt: cd.resetAt, reason: "cooldown" },
    );
  }
}

export async function handleLoginFailure(opts: {
  ip: string;
  normalizedId: string;
  scope: "customer" | "admin";
  userId?: string;
}) {
  const keys = loginKeys(opts.ip, opts.normalizedId, opts.userId);
  const ipIdPolicy =
    opts.scope === "admin" ? AUTH_POLICIES.login.adminIpIdCooldown : AUTH_POLICIES.login.customerIpIdCooldown;

  const targets: Array<{ key: string; policy: CooldownPolicy }> = [
    { key: keys.ipId, policy: ipIdPolicy },
    { key: keys.id, policy: AUTH_POLICIES.login.identifierCooldown },
    { key: keys.ipSpray, policy: AUTH_POLICIES.login.ipSprayCooldown },
  ];
  if (keys.uid) targets.push({ key: keys.uid, policy: AUTH_POLICIES.login.userCooldown });

  const outcome = recordFailures(targets);
  if (outcome.coolingDown) {
    throw tooManyRequests(
      `Too many failed login attempts. Please wait ${formatWaitDuration(outcome.retryAfter)} before trying again.`,
      outcome.retryAfter,
      { resetAt: outcome.resetAt, reason: "cooldown" },
    );
  }
  await throttleDelay(outcome.softDelayMs);
}

/**
 * Clears account-scoped failure counters on successful login, while preserving
 * IP-wide spray counters so attackers cannot reset IP brute-force tracking via a dummy account.
 */
export function handleLoginSuccess(ip: string, normalizedId: string, userId?: string) {
  const keys = [`auth:login:fail:ip_id:${ip}:${normalizedId}`, `auth:login:fail:id:${normalizedId}`];
  if (userId) keys.push(`auth:login:fail:uid:${userId}`);
  clearFailures(keys);
}

// ─────────────────────── Registration Guard ───────────────────────

export function enforceRegisterIpLimit(ip: string): RateLimitResult {
  const cd = checkCooldown(`auth:register:fail:ip:${ip}`);
  if (!cd.ok) {
    throw tooManyRequests(
      `Registration temporarily paused due to repeated failed attempts. Please wait ${formatWaitDuration(cd.retryAfter)}.`,
      cd.retryAfter,
      { resetAt: cd.resetAt, reason: "cooldown" },
    );
  }
  const rl = rateLimitMulti([
    { key: `auth:register:ip:1m:${ip}`, ...AUTH_POLICIES.register.ipBurst },
    { key: `auth:register:ip:15m:${ip}`, ...AUTH_POLICIES.register.ip15m },
    { key: `auth:register:ip:1h:${ip}`, ...AUTH_POLICIES.register.ip1h },
  ]);
  if (!rl.ok) {
    throw tooManyRequests(
      `Too many registration attempts. Please wait ${formatWaitDuration(rl.retryAfter)} before trying again.`,
      rl.retryAfter,
      { limit: rl.limit, resetAt: rl.resetAt, reason: "rate_limit" },
    );
  }
  return rl;
}

export function enforceRegisterTargetLimit(email: string, phone: string) {
  const rl = rateLimitMulti([
    { key: `auth:register:email:15m:${email.toLowerCase()}`, ...AUTH_POLICIES.register.identifier15m },
    { key: `auth:register:phone:15m:${phone}`, ...AUTH_POLICIES.register.identifier15m },
  ]);
  if (!rl.ok) {
    throw tooManyRequests(
      `Too many registration attempts for this account. Please wait ${formatWaitDuration(rl.retryAfter)}.`,
      rl.retryAfter,
      { limit: rl.limit, resetAt: rl.resetAt, reason: "rate_limit" },
    );
  }
}

export async function handleRegisterConflictOrFailure(ip: string) {
  const res = recordFailure(`auth:register:fail:ip:${ip}`, AUTH_POLICIES.register.ipFailureCooldown);
  if (res.coolingDown) {
    throw tooManyRequests(
      `Too many unsuccessful registration attempts. Please wait ${formatWaitDuration(res.retryAfter)} before trying again.`,
      res.retryAfter,
      { resetAt: res.resetAt, reason: "cooldown" },
    );
  }
  await throttleDelay(res.softDelayMs);
}

// ─────────────────────── Password Reset Guards ───────────────────────

export function enforcePasswordResetRequestIpLimit(ip: string): RateLimitResult {
  const ipRl = rateLimitMulti([
    { key: `auth:pwreset_req:ip:1m:${ip}`, ...AUTH_POLICIES.passwordResetRequest.ipBurst },
    { key: `auth:pwreset_req:ip:15m:${ip}`, ...AUTH_POLICIES.passwordResetRequest.ip15m },
    { key: `auth:pwreset_req:ip:1h:${ip}`, ...AUTH_POLICIES.passwordResetRequest.ip1h },
  ]);
  if (!ipRl.ok) {
    throw tooManyRequests(
      `Too many password reset requests. Please wait ${formatWaitDuration(ipRl.retryAfter)} before trying again.`,
      ipRl.retryAfter,
      { limit: ipRl.limit, resetAt: ipRl.resetAt, reason: "rate_limit" },
    );
  }
  return ipRl;
}

export function enforcePasswordResetRequestIdentifierLimit(normalizedId: string): RateLimitResult {
  // Check mandatory per-identifier resend cooldown (applied identically regardless of account existence)
  const cooldownKey = `auth:pwreset_req:cooldown:id:${normalizedId}`;
  const cd = checkCooldown(cooldownKey);
  if (!cd.ok) {
    throw tooManyRequests(
      `Please wait ${formatWaitDuration(cd.retryAfter)} before requesting another password reset.`,
      cd.retryAfter,
      { resetAt: cd.resetAt, reason: "cooldown" },
    );
  }

  // Check per-identifier sliding windows (15m and 1h)
  const idRl = rateLimitMulti([
    { key: `auth:pwreset_req:id:15m:${normalizedId}`, ...AUTH_POLICIES.passwordResetRequest.identifier15m },
    { key: `auth:pwreset_req:id:1h:${normalizedId}`, ...AUTH_POLICIES.passwordResetRequest.identifier1h },
  ]);
  if (!idRl.ok) {
    throw tooManyRequests(
      `Too many password reset requests for this account. Please wait ${formatWaitDuration(idRl.retryAfter)}.`,
      idRl.retryAfter,
      { limit: idRl.limit, resetAt: idRl.resetAt, reason: "rate_limit" },
    );
  }

  // Arm the 60s resend cooldown for this identifier
  setFixedCooldown(cooldownKey, AUTH_POLICIES.passwordResetRequest.identifierResendCooldownMs);
  return idRl;
}

export function enforcePasswordResetRequestLimit(ip: string, normalizedId: string): RateLimitResult {
  const ipRl = enforcePasswordResetRequestIpLimit(ip);
  const idRl = enforcePasswordResetRequestIdentifierLimit(normalizedId);
  return ipRl.remaining < idRl.remaining ? ipRl : idRl;
}

export function enforcePasswordResetConfirmLimit(ip: string): RateLimitResult {
  const cd = checkCooldown(`auth:pwreset_confirm:fail:ip:${ip}`);
  if (!cd.ok) {
    throw tooManyRequests(
      `Too many invalid password reset attempts. Please wait ${formatWaitDuration(cd.retryAfter)} before trying again.`,
      cd.retryAfter,
      { resetAt: cd.resetAt, reason: "cooldown" },
    );
  }
  const rl = rateLimitMulti([
    { key: `auth:pwreset_confirm:ip:1m:${ip}`, ...AUTH_POLICIES.passwordResetConfirm.ipBurst },
    { key: `auth:pwreset_confirm:ip:15m:${ip}`, ...AUTH_POLICIES.passwordResetConfirm.ip15m },
  ]);
  if (!rl.ok) {
    throw tooManyRequests(
      `Too many password reset attempts. Please wait ${formatWaitDuration(rl.retryAfter)} before trying again.`,
      rl.retryAfter,
      { limit: rl.limit, resetAt: rl.resetAt, reason: "rate_limit" },
    );
  }
  return rl;
}

export async function handlePasswordResetConfirmFailure(ip: string) {
  const res = recordFailure(`auth:pwreset_confirm:fail:ip:${ip}`, AUTH_POLICIES.passwordResetConfirm.ipFailureCooldown);
  if (res.coolingDown) {
    throw tooManyRequests(
      `Too many invalid password reset attempts. Please wait ${formatWaitDuration(res.retryAfter)} before trying again.`,
      res.retryAfter,
      { resetAt: res.resetAt, reason: "cooldown" },
    );
  }
  await throttleDelay(res.softDelayMs);
}

export function handlePasswordResetConfirmSuccess(ip: string, userId?: string) {
  const keys = [`auth:pwreset_confirm:fail:ip:${ip}`];
  if (userId) keys.push(`auth:login:fail:uid:${userId}`);
  clearFailures(keys);
}

// ─────────────────────── Password Change Guard ───────────────────────

export function enforcePasswordChangeIpLimit(ip: string): RateLimitResult {
  const cd = checkCooldown(`auth:pwchange:fail:ip:${ip}`);
  if (!cd.ok) {
    throw tooManyRequests(
      `Too many failed password attempts. Please wait ${formatWaitDuration(cd.retryAfter)} before trying again.`,
      cd.retryAfter,
      { resetAt: cd.resetAt, reason: "cooldown" },
    );
  }
  const rl = rateLimit(
    `auth:pwchange:ip:1m:${ip}`,
    AUTH_POLICIES.passwordChange.ipBurst.limit,
    AUTH_POLICIES.passwordChange.ipBurst.windowMs,
  );
  if (!rl.ok) {
    throw tooManyRequests(
      `Too many password change requests. Please wait ${formatWaitDuration(rl.retryAfter)} before trying again.`,
      rl.retryAfter,
      { limit: rl.limit, resetAt: rl.resetAt, reason: "rate_limit" },
    );
  }
  return rl;
}

export function enforcePasswordChangeUserLimit(userId: string): RateLimitResult {
  const cd = checkCooldown(`auth:pwchange:fail:user:${userId}`);
  if (!cd.ok) {
    throw tooManyRequests(
      `Too many failed password attempts. Please wait ${formatWaitDuration(cd.retryAfter)} before trying again.`,
      cd.retryAfter,
      { resetAt: cd.resetAt, reason: "cooldown" },
    );
  }
  const rl = rateLimit(
    `auth:pwchange:user:15m:${userId}`,
    AUTH_POLICIES.passwordChange.user15m.limit,
    AUTH_POLICIES.passwordChange.user15m.windowMs,
  );
  if (!rl.ok) {
    throw tooManyRequests(
      `Too many password change requests. Please wait ${formatWaitDuration(rl.retryAfter)} before trying again.`,
      rl.retryAfter,
      { limit: rl.limit, resetAt: rl.resetAt, reason: "rate_limit" },
    );
  }
  return rl;
}

export function enforcePasswordChangeLimit(ip: string, userId: string): RateLimitResult {
  const ipRl = enforcePasswordChangeIpLimit(ip);
  const userRl = enforcePasswordChangeUserLimit(userId);
  return ipRl.remaining < userRl.remaining ? ipRl : userRl;
}

export async function handlePasswordChangeFailure(ip: string, userId: string) {
  const outcome = recordFailures([
    { key: `auth:pwchange:fail:user:${userId}`, policy: AUTH_POLICIES.passwordChange.failureCooldown },
    { key: `auth:pwchange:fail:ip:${ip}`, policy: AUTH_POLICIES.passwordChange.failureCooldown },
  ]);
  if (outcome.coolingDown) {
    throw tooManyRequests(
      `Too many incorrect password attempts. Please wait ${formatWaitDuration(outcome.retryAfter)} before trying again.`,
      outcome.retryAfter,
      { resetAt: outcome.resetAt, reason: "cooldown" },
    );
  }
  await throttleDelay(outcome.softDelayMs);
}

export function handlePasswordChangeSuccess(ip: string, userId: string) {
  clearFailures([`auth:pwchange:fail:user:${userId}`, `auth:pwchange:fail:ip:${ip}`]);
}

// ─────────────────────── Session & Auth Endpoint Guards ───────────────────────

export function enforceSessionMeLimit(ip: string): RateLimitResult {
  const cd = checkCooldown(`auth:session_me:bad_cookie:ip:${ip}`);
  if (!cd.ok) {
    throw tooManyRequests(
      `Too many invalid session requests. Please wait ${formatWaitDuration(cd.retryAfter)} before trying again.`,
      cd.retryAfter,
      { resetAt: cd.resetAt, reason: "cooldown" },
    );
  }
  const rl = rateLimit(
    `auth:session_me:ip:1m:${ip}`,
    AUTH_POLICIES.sessionMe.ipPerMin.limit,
    AUTH_POLICIES.sessionMe.ipPerMin.windowMs,
  );
  if (!rl.ok) {
    throw tooManyRequests(
      `Too many authentication checks. Please wait ${formatWaitDuration(rl.retryAfter)}.`,
      rl.retryAfter,
      { limit: rl.limit, resetAt: rl.resetAt, reason: "rate_limit" },
    );
  }
  return rl;
}

export function handleInvalidSessionCookie(ip: string) {
  const res = recordFailure(`auth:session_me:bad_cookie:ip:${ip}`, AUTH_POLICIES.sessionMe.badCookieCooldown);
  if (res.coolingDown) {
    throw tooManyRequests(
      `Too many invalid session requests. Please wait ${formatWaitDuration(res.retryAfter)} before trying again.`,
      res.retryAfter,
      { resetAt: res.resetAt, reason: "cooldown" },
    );
  }
}

export function enforceLogoutLimit(ip: string): RateLimitResult {
  const rl = rateLimit(`auth:logout:ip:1m:${ip}`, AUTH_POLICIES.logout.ipPerMin.limit, AUTH_POLICIES.logout.ipPerMin.windowMs);
  if (!rl.ok) {
    throw tooManyRequests(
      `Too many logout requests. Please wait ${formatWaitDuration(rl.retryAfter)}.`,
      rl.retryAfter,
      { limit: rl.limit, resetAt: rl.resetAt, reason: "rate_limit" },
    );
  }
  return rl;
}

export function enforceCronLimit(ip: string): RateLimitResult {
  const cd = checkCooldown(`auth:cron:fail:ip:${ip}`);
  if (!cd.ok) {
    throw tooManyRequests(
      `Too many unauthorized cron attempts. Please wait ${formatWaitDuration(cd.retryAfter)}.`,
      cd.retryAfter,
      { resetAt: cd.resetAt, reason: "cooldown" },
    );
  }
  const rl = rateLimit(`auth:cron:ip:1m:${ip}`, AUTH_POLICIES.cron.ipPerMin.limit, AUTH_POLICIES.cron.ipPerMin.windowMs);
  if (!rl.ok) {
    throw tooManyRequests(
      `Too many cron requests. Please wait ${formatWaitDuration(rl.retryAfter)}.`,
      rl.retryAfter,
      { limit: rl.limit, resetAt: rl.resetAt, reason: "rate_limit" },
    );
  }
  return rl;
}

export function handleCronAuthFailure(ip: string) {
  const res = recordFailure(`auth:cron:fail:ip:${ip}`, AUTH_POLICIES.cron.badSecretCooldown);
  if (res.coolingDown) {
    throw tooManyRequests(
      `Too many unauthorized cron attempts. Please wait ${formatWaitDuration(res.retryAfter)}.`,
      res.retryAfter,
      { resetAt: res.resetAt, reason: "cooldown" },
    );
  }
}

export function handleCronAuthSuccess(ip: string) {
  clearFailures(`auth:cron:fail:ip:${ip}`);
}
