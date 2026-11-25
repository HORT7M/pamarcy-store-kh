/**
 * Centralized HTTP security header definitions (Edge & Node runtime compatible).
 *
 * Architecture:
 * - `next.config.ts` applies baseline static headers to `/(.*)` and locked-down CSP
 *   policies to static asset routes excluded from Edge Middleware (`/uploads/*`,
 *   `/images/*`, `/favicon.ico`, `/_next/static/*`, `/_next/image`).
 * - `src/middleware.ts` applies per-request nonce-based `Content-Security-Policy`
 *   to HTML pages (forwarding the nonce to Next.js App Router for automatic script
 *   nonce attachment), strict non-executable policies to `/api/*`, uploaded files,
 *   and redirects, `Referrer-Policy: no-referrer` on sensitive token/PHI paths, and
 *   `Cache-Control: private, no-store` on routes carrying PII/health/session data.
 */

export type SecurityHeader = {
  readonly key: string;
  readonly value: string;
};

export type ActiveBotProvider = "builtin" | "turnstile" | "hcaptcha";

/**
 * Baseline security headers applied to every response.
 *
 * Compatibility notes:
 * - `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'`: the app never embeds
 *   its own pages in iframes (invoices & prescriptions open in a new tab; PayPal
 *   uses server-side Orders v2 top-level redirects).
 * - `Permissions-Policy`: disables unused device APIs (`camera`, `microphone`,
 *   `geolocation`, `payment`, `usb`, motion sensors). POS barcode scanning uses a
 *   keyboard-wedge text input (not webcam), PayPal uses redirect flow (not the W3C
 *   PaymentRequest API), and `clipboard-write` remains available to `'self'` for
 *   USDT wallet/amount copy buttons.
 * - `Cross-Origin-Opener-Policy: same-origin` & `Cross-Origin-Resource-Policy: same-origin`:
 *   isolate browsing contexts and prevent cross-origin embedding of pharmacy assets
 *   and API responses. `Cross-Origin-Embedder-Policy: require-corp` is intentionally
 *   NOT enabled so external product/banner images from Cloudinary and Wikimedia
 *   continue rendering reliably.
 */
export const BASE_SECURITY_HEADERS: readonly SecurityHeader[] = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  { key: "X-Download-Options", value: "noopen" },
  { key: "X-XSS-Protection", value: "0" },
] as const;

/** Two-year HSTS policy (omit `preload` unless domain owner explicitly opts in). */
export const HSTS_HEADER: SecurityHeader = {
  key: "Strict-Transport-Security",
  value: "max-age=63072000; includeSubDomains",
};

/** Locked-down CSP for JSON/CSV API responses, middleware redirects, and static JS/CSS chunks. */
export const API_CSP = [
  "default-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * Sandboxed non-executable CSP for user/admin uploaded files served through
 * `/api/files/*` and `/uploads/*`.
 */
export const UPLOADED_FILE_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox";

/** Locked-down CSP for static image assets (`/images/*`, `/favicon.ico`, `/_next/image`). */
export const STATIC_ASSET_CSP = [
  "default-src 'none'",
  "img-src 'self'",
  "style-src 'unsafe-inline'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** Locked-down CSP for direct navigation to SVG files (blocks embedded SVG scripts). */
export const SVG_ASSET_CSP = [
  "default-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** Generate a 128-bit cryptographically random base64 CSP nonce (Edge & Node safe). */
export function generateCspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/**
 * Edge-safe resolution of the active bot-protection provider so external CAPTCHA
 * origins are ONLY allowed in CSP when that external provider is actually configured.
 */
export function resolveActiveBotProvider(
  env: Record<string, string | undefined> = process.env,
): ActiveBotProvider {
  const pref = (env.BOT_PROTECTION_PROVIDER ?? "auto").trim().toLowerCase();
  const hasTurnstile = Boolean(env.TURNSTILE_SITE_KEY?.trim() && env.TURNSTILE_SECRET_KEY?.trim());
  const hasHcaptcha = Boolean(env.HCAPTCHA_SITE_KEY?.trim() && env.HCAPTCHA_SECRET_KEY?.trim());

  if (pref === "builtin") return "builtin";
  if (pref === "turnstile") return hasTurnstile ? "turnstile" : "builtin";
  if (pref === "hcaptcha") return hasHcaptcha ? "hcaptcha" : "builtin";
  if (hasTurnstile) return "turnstile";
  if (hasHcaptcha) return "hcaptcha";
  return "builtin";
}

export type PageCspOptions = {
  nonce: string;
  isDev?: boolean;
  upgradeInsecureRequests?: boolean;
  botProvider?: ActiveBotProvider;
};

/**
 * Build per-request strict CSP for Next.js 15 App Router HTML documents.
 *
 * Directive rationale:
 * - `script-src`: in production uses per-request cryptographic `'nonce-...'` +
 *   `'strict-dynamic'` (with `'self'` fallback for CSP2 browsers) — zero `'unsafe-inline'`
 *   and zero `'unsafe-eval'`. In local development (`NODE_ENV === "development"`), allows
 *   `'unsafe-inline' 'unsafe-eval'` for Next.js Fast Refresh & Dev Error Overlay.
 * - `script-src-attr 'none'`: blocks all inline event handlers (`onclick=`, `onerror=`, etc.).
 * - `style-src 'self' 'unsafe-inline'`: required by `next/image`, `RootLayout` font
 *   CSS variables, `sonner` runtime `<style>` injection, Radix UI poppers, and Recharts.
 * - `img-src`: `'self'` + `data:` (KHQR / USDT / PayPal QR codes & builtin SVG CAPTCHA)
 *   + `blob:` (client-side PDF/file helpers) + configured `next.config.ts` remote image
 *   hosts (`res.cloudinary.com`, `upload.wikimedia.org`).
 * - `font-src 'self'`: fonts are self-hosted via `@fontsource-variable/inter` and
 *   `@fontsource/noto-sans-khmer`.
 * - `connect-src`: `'self'` only in production (plus localhost WebSocket HMR in dev,
 *   and external CAPTCHA verification host ONLY when Turnstile/hCaptcha is configured).
 * - `frame-src`: `'none'` by default; allows Turnstile or hCaptcha widget iframe ONLY
 *   when that external provider is configured. Unused PayPal script/frame/connect origins
 *   are removed because PayPal uses server-side Orders v2 + top-level redirect links.
 * - `object-src 'none'`, `media-src 'none'`, `worker-src 'none'`,
 *   `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'self'`.
 * - `upgrade-insecure-requests`: enabled automatically on HTTPS production deployments,
 *   omitted on plain HTTP localhost so local production testing is never broken.
 */
export function buildPageCsp({
  nonce,
  isDev = false,
  upgradeInsecureRequests = false,
  botProvider = resolveActiveBotProvider(),
}: PageCspOptions): string {
  const scriptSrc = isDev
    ? ["'self'", "'unsafe-inline'", "'unsafe-eval'"]
    : ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  const styleSrc = ["'self'", "'unsafe-inline'"];
  const connectSrc = ["'self'"];
  const frameSrc: string[] = [];

  if (isDev) {
    connectSrc.push(
      "ws://localhost:*",
      "ws://127.0.0.1:*",
      "http://localhost:*",
      "http://127.0.0.1:*",
    );
  }

  if (botProvider === "turnstile") {
    scriptSrc.push("https://challenges.cloudflare.com");
    connectSrc.push("https://challenges.cloudflare.com");
    frameSrc.push("https://challenges.cloudflare.com");
  } else if (botProvider === "hcaptcha") {
    scriptSrc.push("https://hcaptcha.com", "https://js.hcaptcha.com", "https://*.hcaptcha.com");
    styleSrc.push("https://hcaptcha.com", "https://*.hcaptcha.com");
    connectSrc.push("https://hcaptcha.com", "https://api.hcaptcha.com", "https://*.hcaptcha.com");
    frameSrc.push("https://hcaptcha.com", "https://newassets.hcaptcha.com", "https://*.hcaptcha.com");
  }

  const directives = [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    "script-src-attr 'none'",
    `style-src ${styleSrc.join(" ")}`,
    "img-src 'self' data: blob: https://res.cloudinary.com https://upload.wikimedia.org",
    "font-src 'self'",
    `connect-src ${connectSrc.join(" ")}`,
    "media-src 'none'",
    "object-src 'none'",
    `frame-src ${frameSrc.length > 0 ? frameSrc.join(" ") : "'none'"}`,
    "worker-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ];

  if (upgradeInsecureRequests) {
    directives.push("upgrade-insecure-requests");
  }

  return directives.join("; ");
}

/** Detect whether the ACTUAL incoming HTTP request arrived over HTTPS (ignoring APP_URL fallback). */
export function isIncomingRequestHttps(req: {
  headers: { get(name: string): string | null };
  nextUrl: { protocol: string };
}): boolean {
  const xfp = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (xfp) return xfp === "https";
  const forwarded = req.headers.get("forwarded");
  if (forwarded) {
    const m = /(?:^|[;,\s])proto="?([a-z]+)"?(?:$|[;,\s])/i.exec(forwarded);
    if (m) return m[1]!.toLowerCase() === "https";
  }
  return req.nextUrl.protocol === "https:";
}

/** Detect whether the incoming request targets localhost / loopback (dev & local tests). */
export function isLoopbackRequestHost(req: {
  headers: { get(name: string): string | null };
  nextUrl: { hostname?: string };
}): boolean {
  const rawHost = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? req.nextUrl.hostname ?? "")
    .split(",")[0]
    ?.trim()
    .toLowerCase() ?? "";
  const hostname = rawHost.replace(/^\[([^\]]+)\](?::\d+)?$/, "$1").replace(/:\d+$/, "");
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/** Detect whether the incoming request or configured deployment URL uses HTTPS. */
export function isHttpsRequest(req: {
  headers: { get(name: string): string | null };
  nextUrl: { protocol: string };
}): boolean {
  if (isIncomingRequestHttps(req)) {
    return true;
  }
  if ((process.env.APP_URL ?? "").trim().toLowerCase().startsWith("https://")) {
    return true;
  }
  return false;
}

const PRIVATE_NO_STORE_PREFIXES = [
  "/admin",
  "/account",
  "/checkout",
  "/invoice",
  "/reset-password",
  "/forgot-password",
  "/api/auth",
  "/api/account",
  "/api/admin",
  "/api/orders",
  "/api/payments",
  "/api/files/prescriptions",
  "/api/uploads",
  "/api/cron",
  "/api/bot-protection",
] as const;

/** Routes containing PII, health/prescription data, session state, or signed URL tokens. */
export function isPrivateNoStorePath(pathname: string): boolean {
  return PRIVATE_NO_STORE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

const NO_REFERRER_PREFIXES = [
  "/reset-password",
  "/checkout/pay",
  "/invoice",
  "/api/files/prescriptions",
] as const;

/** Routes carrying secret URL query tokens or private health documents (`Referrer-Policy: no-referrer`). */
export function isNoReferrerPath(pathname: string): boolean {
  return NO_REFERRER_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Header rules for `next.config.ts`.
 *
 * Non-CSP baseline headers apply globally (`/(.*)`). Static locked-down CSP headers
 * are scoped ONLY to static routes excluded from `src/middleware.ts` so pages never
 * receive duplicate/conflicting `Content-Security-Policy` headers.
 */
export function getNextConfigHeaders(isProduction = process.env.NODE_ENV === "production") {
  const globalHeaders: { key: string; value: string }[] = [
    ...BASE_SECURITY_HEADERS.map((h) => ({ key: h.key, value: h.value })),
    ...(isProduction ? [{ key: HSTS_HEADER.key, value: HSTS_HEADER.value }] : []),
  ];

  return [
    {
      source: "/(.*)",
      headers: globalHeaders,
    },
    {
      source: "/uploads/:path*",
      headers: [{ key: "Content-Security-Policy", value: UPLOADED_FILE_CSP }],
    },
    {
      source: "/images/:path*",
      headers: [{ key: "Content-Security-Policy", value: STATIC_ASSET_CSP }],
    },
    {
      source: "/favicon.ico",
      headers: [{ key: "Content-Security-Policy", value: STATIC_ASSET_CSP }],
    },
    {
      source: "/_next/image",
      headers: [{ key: "Content-Security-Policy", value: STATIC_ASSET_CSP }],
    },
    {
      source: "/_next/static/:path*",
      headers: [{ key: "Content-Security-Policy", value: API_CSP }],
    },
  ];
}
