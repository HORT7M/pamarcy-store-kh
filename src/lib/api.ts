import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError, type ZodType } from "zod";
import { Prisma } from "@prisma/client";
import { ApiError, badRequest, payloadTooLarge, unsupportedMedia } from "./errors";
import { rateLimit, rateLimitHeaders, type RateLimitResult } from "./rate-limit";
import { runWithMutableCookies } from "./auth/session";

type Ctx<P> = { params: Promise<P> };
type Handler<P> = (req: NextRequest, ctx: Ctx<P>) => Promise<Response | unknown>;

export type HandlerOptions = {
  /**
   * Requests per window per IP for this route (default: 240 GET/HEAD, 60 mutating per 60s).
   * Pass `{ limit, windowMs, keyPrefix }` for custom windows or `false` when the handler
   * enforces its own dedicated multi-tier auth rate limits.
   */
  rateLimit?: number | { limit: number; windowMs?: number; keyPrefix?: string } | false;
  /** skip same-origin check (webhooks) */
  skipCsrf?: boolean;
};

export type ParseBodyOptions = {
  /** Max UTF-8 body size in bytes (default 128 KiB). */
  maxBytes?: number;
  /** Allow an empty body (parses as `{}`). */
  allowEmpty?: boolean;
};

const DEFAULT_MAX_JSON_BYTES = 128 * 1024;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 5_000;
const MAX_QUERY_STRING_LEN = 2_048;
const MAX_QUERY_PARAMS = 30;

const SAFE_IP_RE = /^[a-fA-F0-9:.]+$/;
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function sanitizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  if (!ip || ip.length > 64) return null;
  if (ip.toLowerCase().startsWith("::ffff:")) ip = ip.slice(7);
  if (ip === "::1") return "127.0.0.1";
  return SAFE_IP_RE.test(ip) ? ip.toLowerCase() : null;
}

export function clientIp(req: NextRequest | Request): string {
  if (process.env.TRUST_PROXY === "false") return "local";
  const cf = sanitizeIp(req.headers.get("cf-connecting-ip"));
  if (cf) return cf;
  const xff = sanitizeIp(req.headers.get("x-forwarded-for")?.split(",")[0]);
  if (xff) return xff;
  const real = sanitizeIp(req.headers.get("x-real-ip"));
  if (real) return real;
  return "local";
}

function isSensitiveApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/auth") || pathname.startsWith("/api/account") || pathname.startsWith("/api/admin");
}

function withCachePolicy(req: NextRequest, res: Response): Response {
  if (isSensitiveApiPath(req.nextUrl.pathname) || res.headers.has("set-cookie")) {
    if (!res.headers.has("Cache-Control")) {
      res.headers.set("Cache-Control", "private, no-store");
    }
    const vary = res.headers.get("Vary");
    if (!vary) {
      res.headers.set("Vary", "Cookie");
    } else if (!vary.toLowerCase().split(",").map((s) => s.trim()).includes("cookie")) {
      res.headers.set("Vary", `${vary}, Cookie`);
    }
  }
  return res;
}

/**
 * CSRF protection: session cookie is SameSite=Lax/Strict + every state-changing request must
 * originate from our own origin (Sec-Fetch-Site + Origin / Referer headers).
 */
function checkSameOrigin(req: NextRequest) {
  const method = req.method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return;
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw new ApiError(403, "CSRF", "Cross-site request blocked");
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ?? req.headers.get("host");
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== host) throw new ApiError(403, "CSRF", "Cross-origin request blocked");
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(403, "CSRF", "Invalid origin");
    }
    return;
  }
  const referer = req.headers.get("referer");
  if (referer) {
    try {
      if (new URL(referer).host !== host) throw new ApiError(403, "CSRF", "Cross-origin referer blocked");
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(403, "CSRF", "Invalid referer");
    }
  }
}

export function apiHandler<P = Record<string, string>>(fn: Handler<P>, opts: HandlerOptions = {}) {
  return async (req: NextRequest, ctx: Ctx<P>) => {
    let rlResult: RateLimitResult | null = null;
    try {
      if (opts.rateLimit !== false) {
        const mutating = !["GET", "HEAD"].includes(req.method);
        const cfg =
          typeof opts.rateLimit === "object"
            ? {
                limit: opts.rateLimit.limit,
                windowMs: opts.rateLimit.windowMs ?? 60_000,
                key: `${opts.rateLimit.keyPrefix ?? req.nextUrl.pathname}:${req.method}:${clientIp(req)}`,
              }
            : {
                limit: opts.rateLimit ?? (mutating ? 60 : 240),
                windowMs: 60_000,
                key: `${clientIp(req)}:${req.method}:${req.nextUrl.pathname}`,
              };
        rlResult = rateLimit(cfg.key, cfg.limit, cfg.windowMs);
        if (!rlResult.ok) {
          return withCachePolicy(
            req,
            NextResponse.json(
              {
                error: {
                  code: "RATE_LIMITED",
                  message: "Too many requests, please slow down.",
                  details: { retryAfter: rlResult.retryAfter },
                },
              },
              { status: 429, headers: rateLimitHeaders(rlResult) },
            ),
          );
        }
      }
      if (!opts.skipCsrf) checkSameOrigin(req);
      const result = await runWithMutableCookies(() => fn(req, ctx));
      const res = result instanceof Response ? result : NextResponse.json(result ?? { ok: true });
      if (rlResult) {
        const hdrs = rateLimitHeaders(rlResult);
        for (const [k, v] of Object.entries(hdrs)) {
          if (!res.headers.has(k)) res.headers.set(k, v);
        }
      }
      return withCachePolicy(req, res);
    } catch (e) {
      return withCachePolicy(req, errorResponse(e));
    }
  };
}

/** 5xx ApiError codes whose message is safe and useful to show to end users. */
const CLIENT_SAFE_5XX = new Set(["USDT_BUSY"]);

/** Friendly names for unique-constraint columns (never expose raw schema / index names). */
const FIELD_LABELS: Record<string, string> = { email: "email", phone: "phone number", sku: "SKU", barcode: "barcode", slug: "slug", code: "code", number: "number", name: "name" };

export function errorResponse(e: unknown) {
  // Server-side failures (upstream provider errors, misconfiguration, env var names…) are logged, never returned.
  if (e instanceof ApiError && e.status >= 500 && !CLIENT_SAFE_5XX.has(e.code)) {
    console.error("[api]", e.code, e.message);
    const message = e.status === 503 ? "This service is temporarily unavailable. Please try again later." : "Something went wrong. Please try again.";
    return NextResponse.json({ error: { code: e.status === 503 ? "UNAVAILABLE" : "INTERNAL", message } }, { status: e.status, headers: e.headers });
  }
  if (e instanceof ApiError) {
    const headers: Record<string, string> = { ...(e.headers ?? {}) };
    if (e.status === 429 && !headers["Retry-After"]) {
      const retry =
        typeof (e.details as { retryAfter?: unknown } | undefined)?.retryAfter === "number"
          ? Math.max(1, Math.ceil((e.details as { retryAfter: number }).retryAfter))
          : 60;
      headers["Retry-After"] = String(retry);
    }
    return NextResponse.json(
      { error: { code: e.code, message: e.message, details: e.details } },
      { status: e.status, headers },
    );
  }
  if (e instanceof ZodError) {
    const first = e.issues[0];
    const message = first?.message ?? "Invalid input";
    return NextResponse.json(
      { error: { code: "VALIDATION", message, details: e.flatten() } },
      { status: 422 },
    );
  }
  if (e instanceof Prisma.PrismaClientValidationError) {
    return NextResponse.json({ error: { code: "BAD_REQUEST", message: "Invalid request parameters" } }, { status: 400 });
  }
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === "P2002") {
      const raw = e.meta?.target;
      const cols = (Array.isArray(raw) ? raw : []).map((c) => FIELD_LABELS[String(c)]).filter(Boolean);
      return NextResponse.json({ error: { code: "DUPLICATE", message: `Already exists${cols.length ? ` (${cols.join(", ")})` : ""}` } }, { status: 409 });
    }
    if (e.code === "P2025") return NextResponse.json({ error: { code: "NOT_FOUND", message: "Record not found" } }, { status: 404 });
    if (e.code === "P2003") return NextResponse.json({ error: { code: "IN_USE", message: "Record is referenced by other data" } }, { status: 409 });
  }
  console.error("[api]", e);
  return NextResponse.json({ error: { code: "INTERNAL", message: "Something went wrong" } }, { status: 500 });
}

function isJsonContentType(header: string | null): boolean {
  if (!header) return false;
  const mediaType = header.split(";")[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || (mediaType.startsWith("application/") && mediaType.endsWith("+json"));
}

/** Stream-read a request body as UTF-8 text while strictly enforcing a hard byte cap. */
export async function readBodyTextWithLimit(req: Request, maxBytes: number): Promise<string> {
  const cl = req.headers.get("content-length");
  if (cl !== null) {
    const trimmedCl = cl.trim();
    if (!/^\d{1,12}$/.test(trimmedCl)) throw badRequest("Invalid Content-Length header");
    if (Number(trimmedCl) > maxBytes) throw payloadTooLarge(`Request body exceeds ${Math.round(maxBytes / 1024)} KB limit`);
  }

  if (!req.body) {
    const text = await req.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw payloadTooLarge(`Request body exceeds ${Math.round(maxBytes / 1024)} KB limit`);
    }
    return text;
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw payloadTooLarge(`Request body exceeds ${Math.round(maxBytes / 1024)} KB limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

/** Reject prototype-pollution keys, null bytes, excessive nesting depth, or node floods. */
export function assertSafeJsonStructure(root: unknown): void {
  let nodes = 0;
  function walk(val: unknown, depth: number) {
    nodes++;
    if (nodes > MAX_JSON_NODES) throw badRequest("Request body has too many fields");
    if (depth > MAX_JSON_DEPTH) throw badRequest("Request body is too deeply nested");
    if (typeof val === "string") {
      if (val.includes("\0")) throw badRequest("Null bytes are not allowed");
      return;
    }
    if (val === null || typeof val !== "object") return;
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) walk(val[i], depth + 1);
      return;
    }
    for (const key of Object.getOwnPropertyNames(val)) {
      if (FORBIDDEN_KEYS.has(key)) throw badRequest("Unexpected object key");
      if (key.includes("\0")) throw badRequest("Null bytes are not allowed");
      walk((val as Record<string, unknown>)[key], depth + 1);
    }
  }
  walk(root, 0);
}

export async function parseBody<T>(req: Request, schema: ZodType<T>, opts: ParseBodyOptions = {}): Promise<T> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const contentType = req.headers.get("content-type");
  const raw = await readBodyTextWithLimit(req, maxBytes);

  if (raw.trim().length === 0) {
    if (opts.allowEmpty) return schema.parse({});
    throw badRequest("Request body is required");
  }

  if (!isJsonContentType(contentType)) {
    throw unsupportedMedia("Content-Type must be application/json");
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw badRequest("Invalid JSON body");
  }

  assertSafeJsonStructure(json);
  return schema.parse(json);
}

export function parseQuery<T>(req: NextRequest, schema: ZodType<T>): T {
  const rawSearch = req.nextUrl.search;
  if (rawSearch.length > MAX_QUERY_STRING_LEN) {
    throw badRequest("Query string is too long");
  }

  const obj: Record<string, string> = Object.create(null);
  let count = 0;
  for (const [key, value] of req.nextUrl.searchParams.entries()) {
    count++;
    if (count > MAX_QUERY_PARAMS) throw badRequest("Too many query parameters");
    if (FORBIDDEN_KEYS.has(key)) throw badRequest("Invalid query parameter name");
    if (CONTROL_CHARS_RE.test(key) || CONTROL_CHARS_RE.test(value)) {
      throw badRequest("Invalid characters in query parameter");
    }
    if (Object.hasOwn(obj, key)) {
      throw badRequest(`Duplicate query parameter: ${key}`);
    }
    obj[key] = value;
  }

  return schema.parse({ ...obj });
}

export async function parseParams<T>(
  paramsPromise: Promise<Record<string, string>> | Record<string, string>,
  schema: ZodType<T>,
): Promise<T> {
  const raw = await paramsPromise;
  const obj: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (FORBIDDEN_KEYS.has(key)) throw badRequest("Invalid route parameter");
    if (typeof value !== "string" || value.length > 256 || CONTROL_CHARS_RE.test(value)) {
      throw badRequest("Invalid route parameter");
    }
    obj[key] = value;
  }
  return schema.parse(obj);
}

export function paginate(page = 1, pageSize = 20) {
  const p = Math.min(10_000, Math.max(1, Math.trunc(Number.isFinite(page) ? page : 1)));
  const s = Math.min(100, Math.max(1, Math.trunc(Number.isFinite(pageSize) ? pageSize : 20)));
  return { skip: (p - 1) * s, take: s, page: p, pageSize: s };
}
