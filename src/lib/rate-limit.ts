/**
 * Rate limiting, safe progressive throttling, and temporary brute-force cooldowns.
 *
 * - Exact sliding-window log for tight security limits (limit <= 64, e.g. auth endpoints)
 *   eliminating fixed-window boundary bursts with millisecond accuracy.
 * - O(1) weighted sliding-window counter for high-throughput read endpoints (limit > 64).
 * - Atomic multi-window checks (`rateLimitMulti`) so rejected requests never burn quota
 *   in wider windows or extend active blocks.
 * - Progressive temporary cooldowns (`recordFailure` / `checkCooldown`) with capped
 *   escalation schedules, strike decay, and bounded soft-throttling delays.
 */

export type RateLimitResult = {
  ok: boolean;
  limit: number;
  remaining: number;
  /** Seconds until another request is allowed (0 when ok === true) */
  retryAfter: number;
  /** Epoch timestamp (ms) when the current window resets or block lifts */
  resetAt: number;
};

export type RateLimitRule = {
  key: string;
  limit: number;
  windowMs: number;
};

export type CooldownPolicy = {
  /** Failed attempts within failureWindowMs before activating temporary cooldown */
  maxAttempts: number;
  /** Sliding window (ms) over which failures are counted */
  failureWindowMs: number;
  /** Escalating temporary cooldown durations (ms) per consecutive strike (capped at last entry) */
  cooldownScheduleMs: readonly number[];
  /** Quiet period (ms) after which strike escalation resets (default: 2 hours) */
  strikeResetMs?: number;
  /** Optional progressive soft-throttle delay per failure before hard cooldown (ms) */
  softDelayBaseMs?: number;
  /** Upper bound for soft-throttle delay (default: 600ms) */
  maxSoftDelayMs?: number;
};

export type CooldownCheckResult =
  | { ok: true; retryAfter: 0; resetAt: 0; key: null; strikes: 0 }
  | { ok: false; retryAfter: number; resetAt: number; key: string; strikes: number };

export type FailureRecordResult = {
  coolingDown: boolean;
  retryAfter: number;
  resetAt: number;
  attempts: number;
  remainingAttempts: number;
  strikes: number;
  softDelayMs: number;
};

type ExactBucket = { kind: "exact"; windowMs: number; hits: number[] };
type CounterBucket = { kind: "counter"; windowMs: number; windowStart: number; prevCount: number; currCount: number };
type WindowBucket = ExactBucket | CounterBucket;

type FailureBucket = {
  failures: number[];
  cooldownUntil: number;
  strikes: number;
  lastFailureAt: number;
  expiresAt: number;
};

type RateLimitGlobalStore = {
  windows: Map<string, WindowBucket>;
  cooldowns: Map<string, FailureBucket>;
  lastSweepAt: number;
};

const MAX_EXACT_LIMIT = 64;
const MAX_STORE_ENTRIES = 50_000;
const SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_STRIKE_RESET_MS = 2 * 60 * 60_000;

const globalForRateLimit = globalThis as unknown as { __pamarcyRateLimit?: RateLimitGlobalStore };

function getStore(): RateLimitGlobalStore {
  if (!globalForRateLimit.__pamarcyRateLimit) {
    globalForRateLimit.__pamarcyRateLimit = {
      windows: new Map(),
      cooldowns: new Map(),
      lastSweepAt: Date.now(),
    };
  }
  return globalForRateLimit.__pamarcyRateLimit;
}

function maybeSweep(store: RateLimitGlobalStore, now: number) {
  const total = store.windows.size + store.cooldowns.size;
  if (total <= MAX_STORE_ENTRIES && now - store.lastSweepAt < SWEEP_INTERVAL_MS) return;
  store.lastSweepAt = now;

  for (const [k, b] of store.windows) {
    if (b.kind === "exact") {
      while (b.hits.length > 0 && b.hits[0]! <= now - b.windowMs) b.hits.shift();
      if (b.hits.length === 0) store.windows.delete(k);
    } else if (now - b.windowStart >= 2 * b.windowMs) {
      store.windows.delete(k);
    }
  }
  for (const [k, c] of store.cooldowns) {
    if (c.cooldownUntil <= now && c.expiresAt <= now) store.cooldowns.delete(k);
  }
  // Hard cap eviction (oldest inserted entries first) if under extreme key-cardinality attack
  if (store.windows.size > MAX_STORE_ENTRIES) {
    const excess = store.windows.size - MAX_STORE_ENTRIES;
    let i = 0;
    for (const k of store.windows.keys()) {
      store.windows.delete(k);
      if (++i >= excess) break;
    }
  }
  if (store.cooldowns.size > MAX_STORE_ENTRIES) {
    const excess = store.cooldowns.size - MAX_STORE_ENTRIES;
    let i = 0;
    for (const k of store.cooldowns.keys()) {
      store.cooldowns.delete(k);
      if (++i >= excess) break;
    }
  }
}

function evaluateRule(rule: RateLimitRule, commit: boolean, now: number): RateLimitResult {
  const { key, limit, windowMs } = rule;
  if (limit <= 0 || windowMs <= 0) {
    const retryAfter = Math.max(1, Math.ceil(Math.max(windowMs, 1000) / 1000));
    return { ok: false, limit: Math.max(0, limit), remaining: 0, retryAfter, resetAt: now + retryAfter * 1000 };
  }

  const store = getStore();
  maybeSweep(store, now);

  if (limit <= MAX_EXACT_LIMIT) {
    let b = store.windows.get(key);
    if (!b || b.kind !== "exact" || b.windowMs !== windowMs) {
      if (!commit) {
        return { ok: true, limit, remaining: limit - 1, retryAfter: 0, resetAt: now + windowMs };
      }
      b = { kind: "exact", windowMs, hits: [now] };
      store.windows.set(key, b);
      return { ok: true, limit, remaining: limit - 1, retryAfter: 0, resetAt: now + windowMs };
    }

    const cutoff = now - windowMs;
    while (b.hits.length > 0 && b.hits[0]! <= cutoff) b.hits.shift();

    if (b.hits.length >= limit) {
      const oldest = b.hits[0]!;
      const resetAt = oldest + windowMs;
      const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));
      return { ok: false, limit, remaining: 0, retryAfter, resetAt };
    }

    if (commit) {
      b.hits.push(now);
      const resetAt = b.hits[0]! + windowMs;
      return { ok: true, limit, remaining: Math.max(0, limit - b.hits.length), retryAfter: 0, resetAt };
    }

    const nextLen = b.hits.length + 1;
    const resetAt = (b.hits[0] ?? now) + windowMs;
    return { ok: true, limit, remaining: Math.max(0, limit - nextLen), retryAfter: 0, resetAt };
  }

  // O(1) weighted sliding-window counter for high-limit routes (limit > 64)
  const existing = store.windows.get(key);
  let windowStart = now;
  let prevCount = 0;
  let currCount = 0;

  if (existing && existing.kind === "counter" && existing.windowMs === windowMs) {
    const age = now - existing.windowStart;
    if (age < windowMs) {
      windowStart = existing.windowStart;
      prevCount = existing.prevCount;
      currCount = existing.currCount;
    } else if (age < 2 * windowMs) {
      windowStart = existing.windowStart + windowMs;
      prevCount = existing.currCount;
      currCount = 0;
    }
  }

  const elapsed = Math.max(0, now - windowStart);
  const prevWeight = Math.max(0, (windowMs - elapsed) / windowMs);
  const effectiveBefore = prevCount * prevWeight + currCount;

  if (effectiveBefore + 1 > limit) {
    let waitMs: number;
    if (currCount < limit && prevCount > 0) {
      const targetRatio = Math.max(0, (limit - 1 - currCount) / prevCount);
      waitMs = Math.max(1, Math.ceil(windowMs - elapsed - windowMs * targetRatio));
    } else {
      const nextRatio = currCount > 0 ? Math.max(0, (limit - 1) / currCount) : 0;
      waitMs = Math.max(1, Math.ceil(windowMs - elapsed + windowMs * (1 - nextRatio)));
    }
    const retryAfter = Math.max(1, Math.ceil(waitMs / 1000));
    if (commit && existing && existing.kind === "counter" && existing.windowMs === windowMs) {
      existing.windowStart = windowStart;
      existing.prevCount = prevCount;
      existing.currCount = currCount;
    }
    return { ok: false, limit, remaining: 0, retryAfter, resetAt: now + retryAfter * 1000 };
  }

  const nextCurr = currCount + 1;
  if (commit) {
    store.windows.set(key, { kind: "counter", windowMs, windowStart, prevCount, currCount: nextCurr });
  }
  const remaining = Math.max(0, Math.floor(limit - (prevCount * prevWeight + nextCurr)));
  return { ok: true, limit, remaining, retryAfter: 0, resetAt: windowStart + windowMs };
}

/**
 * Sliding-window rate limit check for a single key.
 */
export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitResult {
  return evaluateRule({ key, limit, windowMs }, true, now);
}

/**
 * Inspect rate-limit state without consuming a token.
 */
export function peekRateLimit(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitResult {
  return evaluateRule({ key, limit, windowMs }, false, now);
}

/**
 * Atomically check and consume across multiple sliding-window rules.
 * If ANY rule is exceeded, NO rule consumes quota, and the most restrictive failure is returned.
 */
export function rateLimitMulti(rules: readonly RateLimitRule[], now = Date.now()): RateLimitResult & { blockedKey?: string } {
  if (rules.length === 0) return { ok: true, limit: 0, remaining: 0, retryAfter: 0, resetAt: now };

  let blocked: (RateLimitResult & { blockedKey: string }) | null = null;
  for (const rule of rules) {
    const res = evaluateRule(rule, false, now);
    if (!res.ok) {
      if (!blocked || res.retryAfter > blocked.retryAfter) {
        blocked = { ...res, blockedKey: rule.key };
      }
    }
  }
  if (blocked) return blocked;

  let tightest: RateLimitResult | null = null;
  for (const rule of rules) {
    const res = evaluateRule(rule, true, now);
    if (!tightest || res.remaining < tightest.remaining) tightest = res;
  }
  return tightest!;
}

/**
 * Check if any of the given keys is currently serving a temporary brute-force cooldown.
 */
export function checkCooldown(keys: string | readonly string[], now = Date.now()): CooldownCheckResult {
  const list = typeof keys === "string" ? [keys] : keys;
  const store = getStore();
  let worstKey: string | null = null;
  let worstUntil = 0;
  let worstStrikes = 0;

  for (const key of list) {
    const entry = store.cooldowns.get(key);
    if (entry && entry.cooldownUntil > now && entry.cooldownUntil > worstUntil) {
      worstKey = key;
      worstUntil = entry.cooldownUntil;
      worstStrikes = entry.strikes;
    }
  }

  if (!worstKey) return { ok: true, retryAfter: 0, resetAt: 0, key: null, strikes: 0 };
  return {
    ok: false,
    retryAfter: Math.max(1, Math.ceil((worstUntil - now) / 1000)),
    resetAt: worstUntil,
    key: worstKey,
    strikes: worstStrikes,
  };
}

/**
 * Record a failed authentication/verification attempt and apply progressive temporary cooldowns
 * or bounded soft-throttling delays when thresholds are reached.
 */
export function recordFailure(key: string, policy: CooldownPolicy, now = Date.now()): FailureRecordResult {
  const store = getStore();
  maybeSweep(store, now);

  const strikeResetMs = policy.strikeResetMs ?? DEFAULT_STRIKE_RESET_MS;
  let entry = store.cooldowns.get(key);

  if (!entry) {
    entry = { failures: [], cooldownUntil: 0, strikes: 0, lastFailureAt: 0, expiresAt: now + strikeResetMs };
    store.cooldowns.set(key, entry);
  } else if (entry.cooldownUntil <= now && entry.lastFailureAt > 0 && now - entry.lastFailureAt >= strikeResetMs) {
    entry.failures = [];
    entry.strikes = 0;
  }

  // If already in an active cooldown, keep it enforced without double-escalating mid-cooldown
  if (entry.cooldownUntil > now) {
    return {
      coolingDown: true,
      retryAfter: Math.max(1, Math.ceil((entry.cooldownUntil - now) / 1000)),
      resetAt: entry.cooldownUntil,
      attempts: policy.maxAttempts,
      remainingAttempts: 0,
      strikes: entry.strikes,
      softDelayMs: 0,
    };
  }

  const cutoff = now - policy.failureWindowMs;
  while (entry.failures.length > 0 && entry.failures[0]! <= cutoff) entry.failures.shift();

  entry.failures.push(now);
  entry.lastFailureAt = now;
  entry.expiresAt = Math.max(entry.expiresAt, now + Math.max(policy.failureWindowMs, strikeResetMs));

  if (entry.failures.length >= policy.maxAttempts) {
    entry.strikes += 1;
    const schedule = policy.cooldownScheduleMs.length > 0 ? policy.cooldownScheduleMs : [60_000];
    const durationMs = schedule[Math.min(entry.strikes - 1, schedule.length - 1)]!;
    entry.cooldownUntil = now + durationMs;
    entry.expiresAt = Math.max(entry.expiresAt, entry.cooldownUntil + strikeResetMs);
    entry.failures = [];

    return {
      coolingDown: true,
      retryAfter: Math.max(1, Math.ceil(durationMs / 1000)),
      resetAt: entry.cooldownUntil,
      attempts: policy.maxAttempts,
      remainingAttempts: 0,
      strikes: entry.strikes,
      softDelayMs: 0,
    };
  }

  const softDelayMs =
    entry.failures.length >= 2 && policy.softDelayBaseMs
      ? Math.min((entry.failures.length - 1) * policy.softDelayBaseMs, policy.maxSoftDelayMs ?? 600)
      : 0;

  return {
    coolingDown: false,
    retryAfter: 0,
    resetAt: 0,
    attempts: entry.failures.length,
    remainingAttempts: Math.max(0, policy.maxAttempts - entry.failures.length),
    strikes: entry.strikes,
    softDelayMs,
  };
}

/**
 * Record failures across multiple keys (e.g. IP+Identifier, Identifier, IP) and return combined outcome.
 */
export function recordFailures(
  targets: ReadonlyArray<{ key: string; policy: CooldownPolicy }>,
  now = Date.now(),
): { coolingDown: boolean; retryAfter: number; resetAt: number; strikes: number; softDelayMs: number } {
  let coolingDown = false;
  let retryAfter = 0;
  let resetAt = 0;
  let strikes = 0;
  let softDelayMs = 0;

  for (const t of targets) {
    const res = recordFailure(t.key, t.policy, now);
    if (res.coolingDown) {
      coolingDown = true;
      if (res.retryAfter > retryAfter) {
        retryAfter = res.retryAfter;
        resetAt = res.resetAt;
        strikes = res.strikes;
      }
    } else if (res.softDelayMs > softDelayMs) {
      softDelayMs = res.softDelayMs;
    }
  }

  return { coolingDown, retryAfter, resetAt, strikes, softDelayMs: coolingDown ? 0 : softDelayMs };
}

/**
 * Set a fixed temporary cooldown (e.g. minimum 60s interval between password-reset emails).
 */
export function setFixedCooldown(key: string, cooldownMs: number, now = Date.now()): { resetAt: number; retryAfter: number } {
  const store = getStore();
  maybeSweep(store, now);
  const resetAt = now + cooldownMs;
  const existing = store.cooldowns.get(key);
  if (existing) {
    existing.cooldownUntil = Math.max(existing.cooldownUntil, resetAt);
    existing.expiresAt = Math.max(existing.expiresAt, existing.cooldownUntil + 60_000);
  } else {
    store.cooldowns.set(key, {
      failures: [],
      cooldownUntil: resetAt,
      strikes: 1,
      lastFailureAt: now,
      expiresAt: resetAt + 60_000,
    });
  }
  return { resetAt, retryAfter: Math.max(1, Math.ceil(cooldownMs / 1000)) };
}

/**
 * Clear failure counts and active cooldowns for the given keys (e.g. IP+Account on valid login).
 */
export function clearFailures(keys: string | readonly string[]) {
  const list = typeof keys === "string" ? [keys] : keys;
  const store = getStore();
  for (const k of list) store.cooldowns.delete(k);
}

/**
 * Clear stored rate-limit buckets and cooldowns (optionally filtered by key prefix).
 * Intended for deterministic automated tests.
 */
export function resetRateLimits(prefix?: string) {
  const store = getStore();
  if (!prefix) {
    store.windows.clear();
    store.cooldowns.clear();
    return;
  }
  for (const k of store.windows.keys()) if (k.startsWith(prefix)) store.windows.delete(k);
  for (const k of store.cooldowns.keys()) if (k.startsWith(prefix)) store.cooldowns.delete(k);
}

/**
 * Build standard HTTP rate-limiting headers (`Retry-After`, `X-RateLimit-*`).
 */
export function rateLimitHeaders(info: {
  limit?: number;
  remaining?: number;
  resetAt?: number;
  retryAfter?: number;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  if (typeof info.limit === "number" && info.limit > 0) headers["X-RateLimit-Limit"] = String(info.limit);
  if (typeof info.remaining === "number") headers["X-RateLimit-Remaining"] = String(Math.max(0, info.remaining));
  if (typeof info.resetAt === "number" && info.resetAt > 0) headers["X-RateLimit-Reset"] = String(Math.ceil(info.resetAt / 1000));
  if (typeof info.retryAfter === "number" && info.retryAfter > 0) headers["Retry-After"] = String(Math.max(1, Math.ceil(info.retryAfter)));
  return headers;
}

/**
 * Safe bounded progressive delay (capped at 1000ms) to slow down early brute-force attempts
 * prior to hard temporary cooldowns without holding open server resources.
 */
export async function throttleDelay(ms: number): Promise<void> {
  if (ms <= 0 || process.env.DISABLE_THROTTLE_DELAY === "1") return;
  const bounded = Math.min(Math.max(0, Math.round(ms)), 1000);
  await new Promise((resolve) => setTimeout(resolve, bounded));
}
