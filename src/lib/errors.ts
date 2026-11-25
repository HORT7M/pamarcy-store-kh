import { rateLimitHeaders } from "./rate-limit";

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  headers?: Record<string, string>;
  constructor(
    status: number,
    code: string,
    message?: string,
    details?: unknown,
    headers?: Record<string, string>,
  ) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export const badRequest = (msg: string, details?: unknown) => new ApiError(400, "BAD_REQUEST", msg, details);
export const unauthorized = (msg = "Authentication required") => new ApiError(401, "UNAUTHORIZED", msg);
export const forbidden = (msg = "You do not have permission to perform this action") => new ApiError(403, "FORBIDDEN", msg);
export const notFound = (msg = "Not found") => new ApiError(404, "NOT_FOUND", msg);
export const conflict = (msg: string, details?: unknown) => new ApiError(409, "CONFLICT", msg, details);
export const payloadTooLarge = (msg = "File too large", details?: unknown) => new ApiError(413, "PAYLOAD_TOO_LARGE", msg, details);
export const unsupportedMedia = (msg = "Unsupported file type", details?: unknown) => new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", msg, details);

export function tooManyRequests(
  msg = "Too many requests",
  retryAfter = 60,
  opts?: { limit?: number; resetAt?: number; reason?: string; [k: string]: unknown },
) {
  const retry = Math.max(1, Math.ceil(retryAfter));
  const resetAt = typeof opts?.resetAt === "number" ? opts.resetAt : Date.now() + retry * 1000;
  const limit = typeof opts?.limit === "number" ? opts.limit : undefined;
  const rest: Record<string, unknown> = {};
  if (opts) {
    for (const [k, v] of Object.entries(opts)) {
      if (k !== "limit" && k !== "resetAt" && v !== undefined) rest[k] = v;
    }
  }
  return new ApiError(
    429,
    "RATE_LIMITED",
    msg,
    { retryAfter: retry, ...rest },
    rateLimitHeaders({ limit, remaining: 0, resetAt, retryAfter: retry }),
  );
}

export const botBlocked = (msg = "Automated request blocked", details?: unknown) => new ApiError(403, "BOT_BLOCKED", msg, details);
export const captchaRequired = (msg = "Human verification required", details?: unknown) => new ApiError(403, "CAPTCHA_REQUIRED", msg, details);
export const captchaInvalid = (msg = "Human verification failed", details?: unknown) => new ApiError(403, "CAPTCHA_INVALID", msg, details);
