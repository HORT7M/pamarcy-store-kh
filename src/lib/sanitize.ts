/**
 * Context-aware output escaping, URL validation, and safe text formatting utilities.
 * Pure TypeScript (safe for both Server Components/API routes and Client Components).
 *
 * Follows OWASP XSS Prevention guidelines: encode/validate data for its specific
 * output context (HTML text, HTML attribute, URL/href, image src, JSON-in-HTML,
 * HTTP/email headers) without corrupting legitimate text or Khmer Unicode content.
 */

const CTRL_CHARS_ALL_RE = /[\u0000-\u001f\u007f]/;
const CTRL_CHARS_GLOBAL_RE = /[\u0000-\u001f\u007f]+/g;
const UNSAFE_MULTILINE_CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const DUMMY_ORIGIN = "https://pamarcy.invalid";

const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

/** Allowed remote image hosts (aligned with next.config.ts images.remotePatterns & CSP img-src). */
export const ALLOWED_IMAGE_HOSTS = ["res.cloudinary.com", "upload.wikimedia.org"] as const;

/** Allowed PayPal checkout approval hosts. */
export const ALLOWED_PAYPAL_HOSTS = [
  "paypal.com",
  "www.paypal.com",
  "sandbox.paypal.com",
  "www.sandbox.paypal.com",
] as const;

/** Allowed USDT block-explorer hosts. */
export const ALLOWED_EXPLORER_HOSTS = [
  "tronscan.org",
  "etherscan.io",
  "bscscan.com",
  "polygonscan.com",
] as const;

// ───────────────────── HTML & Template Context ─────────────────────

/** Escape untrusted text for safe insertion into HTML element content or quoted HTML attributes. */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"'`]/g, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}

/** Escape untrusted text for quoted HTML attribute values, stripping unsafe control characters. */
export function escapeHtmlAttr(value: unknown): string {
  if (value === null || value === undefined) return "";
  return escapeHtml(String(value).replace(CTRL_CHARS_GLOBAL_RE, ""));
}

/**
 * Serialize JSON safely for embedding inside HTML / inline <script> blocks.
 * Escapes `<`, `>`, `&`, U+2028, and U+2029 to prevent `</script>` and HTML comment breakouts.
 */
export function serializeJsonForHtml(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// ───────────────────── Safe Text Formatting ─────────────────────

/**
 * Normalize single-line text (titles, subjects, search labels): strips CR/LF and control chars,
 * preserves Unicode (including Khmer) and normal punctuation.
 */
export function normalizeSingleLineText(value: unknown, maxLen?: number): string {
  if (value === null || value === undefined) return "";
  const cleaned = String(value).replace(CTRL_CHARS_GLOBAL_RE, " ").replace(/\s+/g, " ").trim();
  return maxLen && cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

/**
 * Normalize multiline text (descriptions, instructions, reviews, notes):
 * strips null bytes and non-printing C0 control chars while preserving legitimate line breaks & tabs.
 */
export function normalizeMultilineText(value: unknown, maxLen?: number): string {
  if (value === null || value === undefined) return "";
  const cleaned = String(value)
    .replace(/\r\n?/g, "\n")
    .replace(UNSAFE_MULTILINE_CTRL_RE, "")
    .trim();
  return maxLen && cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

/**
 * Convert plain untrusted text into safe HTML paragraphs/line breaks.
 * Escapes all HTML first, then maps blank lines to <p> and single newlines to <br />.
 */
export function formatTextAsSafeHtml(text: string): string {
  const normalized = normalizeMultilineText(text);
  if (!normalized) return "";
  return normalized
    .split(/\n{2,}/)
    .map((para) => `<p style="margin:0 0 12px 0;line-height:1.6;">${escapeHtml(para).replace(/\n/g, "<br />")}</p>`)
    .join("");
}

/** Render a context-escaped HTML email body while preserving legitimate multiline text formatting. */
export function renderSafeEmailHtml(opts: {
  title: string;
  message: string;
  linkUrl?: string | null;
  linkLabel?: string;
  footer?: string;
}): string {
  const safeTitle = escapeHtml(normalizeSingleLineText(opts.title, 300));
  const safeBody = formatTextAsSafeHtml(opts.message);
  const safeUrl = opts.linkUrl ? safeExternalUrl(opts.linkUrl, { allowHttp: true }) : null;
  const safeLabel = escapeHtml(normalizeSingleLineText(opts.linkLabel ?? "View details", 100));
  const safeFooter = escapeHtml(
    normalizeSingleLineText(opts.footer ?? "Pamarcy Store — Online Pharmacy Cambodia", 300),
  );

  const cta = safeUrl
    ? `<p style="margin:18px 0 0 0;"><a href="${escapeHtmlAttr(safeUrl)}" rel="noopener noreferrer" style="display:inline-block;background:#0f9d58;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;font-size:14px;">${safeLabel}</a></p>`
    : "";

  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8" /></head>',
    '<body style="margin:0;padding:24px;background:#f5f8f6;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111827;">',
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5ece8;border-radius:14px;overflow:hidden;">',
    `<div style="background:#0f9d58;color:#ffffff;padding:16px 22px;font-size:16px;font-weight:700;">${safeTitle}</div>`,
    `<div style="padding:20px 22px;font-size:14px;color:#374151;">${safeBody}${cta}</div>`,
    `<div style="border-top:1px solid #e5ece8;padding:12px 22px;font-size:12px;color:#6b7280;">${safeFooter}</div>`,
    "</div></body></html>",
  ].join("");
}

// ───────────────────── URL / Navigation Context ─────────────────────

function hostMatches(hostname: string, allowedHosts: readonly string[], allowSubdomains = false): boolean {
  const h = hostname.toLowerCase();
  return allowedHosts.some((allowed) => {
    const a = allowed.toLowerCase();
    return h === a || (allowSubdomains && h.endsWith(`.${a}`));
  });
}

/**
 * Validate a relative same-origin path (e.g. `/shop?category=pain-relief`, `/admin/orders/123`).
 * Blocks protocol-relative URLs (`//evil.com`), backslash tricks (`/\evil.com`), control chars,
 * and dangerous schemes (`javascript:`, `data:`, `vbscript:`).
 */
export function safeInternalPath(raw: string | null | undefined): string | null;
export function safeInternalPath(raw: string | null | undefined, fallback: string): string;
export function safeInternalPath(raw: string | null | undefined, fallback?: string): string | null {
  const fail = fallback !== undefined ? fallback : null;
  if (typeof raw !== "string") return fail;
  const trimmed = raw.trim();
  if (!trimmed || CTRL_CHARS_ALL_RE.test(trimmed)) return fail;
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.includes("\\")) return fail;
  try {
    const parsed = new URL(trimmed, DUMMY_ORIGIN);
    if (parsed.origin !== DUMMY_ORIGIN) return fail;
    if (!parsed.pathname.startsWith("/") || parsed.pathname.startsWith("//")) return fail;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fail;
  }
}

/**
 * Validate an external HTTP(S) URL. Strictly rejects `javascript:`, `data:`, `vbscript:`,
 * `blob:`, `file:`, control characters, embedded credentials, and non-allowlisted hosts.
 */
export function safeExternalUrl(
  raw: string | null | undefined,
  opts: { allowHttp?: boolean; allowedHosts?: readonly string[]; allowSubdomains?: boolean } = {},
): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || CTRL_CHARS_ALL_RE.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    const okProto = parsed.protocol === "https:" || (opts.allowHttp === true && parsed.protocol === "http:");
    if (!okProto) return null;
    if (parsed.username || parsed.password) return null;
    if (!parsed.hostname) return null;
    if (opts.allowedHosts && !hostMatches(parsed.hostname, opts.allowedHosts, opts.allowSubdomains)) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

/** Allow either a safe relative app path OR a safe `https://` URL (e.g. marketing banner links). */
export function safeNavigationHref(raw: string | null | undefined, fallback = "/shop"): string {
  const internal = safeInternalPath(raw);
  if (internal) return internal;
  const external = safeExternalUrl(raw, { allowHttp: false });
  if (external) return external;
  return fallback;
}

/** Validate a URL intended for banner links in forms/APIs (returns canonical URL or null if unsafe). */
export function validateBannerLink(raw: string | null | undefined): string | null {
  const internal = safeInternalPath(raw);
  if (internal) return internal;
  return safeExternalUrl(raw, { allowHttp: false });
}

const LOCAL_IMAGE_PATH_RE =
  /^\/(?:images|uploads|api\/files\/uploads)\/[A-Za-z0-9][A-Za-z0-9/_\-.]*\.(?:jpg|jpeg|png|webp|gif|avif)$/i;
const SAFE_QR_PNG_DATA_URL_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;

/**
 * Validate an image `src` attribute.
 * Permits only safe local raster image paths (`/images/...`, `/uploads/...`, `/api/files/uploads/...`
 * with no traversal and no SVG), allowlisted HTTPS image hosts (`res.cloudinary.com`,
 * `upload.wikimedia.org`), or (when explicitly opted in) PNG base64 QR data URLs.
 */
export function safeImageSrc(
  raw: string | null | undefined,
  opts: { allowQrPngDataUrl?: boolean } = {},
): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || CTRL_CHARS_ALL_RE.test(trimmed) || trimmed.includes("\\")) return null;

  if (opts.allowQrPngDataUrl && SAFE_QR_PNG_DATA_URL_RE.test(trimmed)) {
    return trimmed;
  }

  if (trimmed.startsWith("/")) {
    if (trimmed.startsWith("//") || trimmed.includes("..") || trimmed.includes("?") || trimmed.includes("#")) {
      return null;
    }
    if (!LOCAL_IMAGE_PATH_RE.test(trimmed)) return null;
    return trimmed;
  }

  return safeExternalUrl(trimmed, { allowedHosts: ALLOWED_IMAGE_HOSTS, allowHttp: false });
}

const PRESCRIPTION_LOCAL_RE =
  /^\/api\/files\/prescriptions\/[a-z0-9-]+\.(?:jpg|png|webp|pdf)(?:\?claim=[0-9]{10,16}\.[A-Za-z0-9_-]{32,64})?$/;

/**
 * Validate a prescription URL before rendering in `<a href>` or storing on an order.
 * Only permits our authenticated prescription endpoint or authenticated Cloudinary HTTPS URLs.
 */
export function safePrescriptionHref(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || CTRL_CHARS_ALL_RE.test(trimmed) || trimmed.includes("\\")) return null;
  if (PRESCRIPTION_LOCAL_RE.test(trimmed)) return trimmed;
  return safeExternalUrl(trimmed, { allowedHosts: ["res.cloudinary.com"], allowHttp: false });
}

/** Validate a PayPal approval redirect URL strictly against official PayPal HTTPS domains. */
export function safePaypalApproveUrl(raw: string | null | undefined): string | null {
  return safeExternalUrl(raw, { allowedHosts: ALLOWED_PAYPAL_HOSTS, allowHttp: false });
}

const TX_HASH_SAFE_RE = /^(?:0x)?[0-9a-fA-F]{64}$/;

/** Build a safe HTTPS blockchain explorer transaction URL from an allowlisted explorer base + hex txHash. */
export function safeExplorerTxUrl(
  explorerBase: string | null | undefined,
  txHash: string | null | undefined,
): string | null {
  if (typeof txHash !== "string") return null;
  const hash = txHash.trim();
  if (!TX_HASH_SAFE_RE.test(hash)) return null;
  const base = safeExternalUrl(explorerBase, { allowedHosts: ALLOWED_EXPLORER_HOSTS, allowHttp: false });
  if (!base) return null;
  return `${base}${encodeURIComponent(hash)}`;
}

const SAFE_TEL_RE = /^\+?[0-9][0-9\s\-()]{4,29}$/;

/** Build a safe `tel:` href value from a phone string. */
export function safeTelHref(phone: string | null | undefined): string | null {
  if (typeof phone !== "string") return null;
  const trimmed = phone.trim();
  if (!trimmed || CTRL_CHARS_ALL_RE.test(trimmed) || !SAFE_TEL_RE.test(trimmed)) return null;
  const compact = trimmed.replace(/[\s()]/g, "");
  return `tel:${compact}`;
}

const SAFE_MAILTO_RE = /^[^\s@<>'"`\\/?#&;,]{1,64}@[^\s@<>'"`\\/?#&;,]{1,253}\.[^\s@<>'"`\\/?#&;,]{2,63}$/;

/** Build a safe `mailto:` href value (blocks CRLF, query-param injection, and unsafe characters). */
export function safeMailtoHref(email: string | null | undefined): string | null {
  if (typeof email !== "string") return null;
  const trimmed = email.trim();
  if (!trimmed || CTRL_CHARS_ALL_RE.test(trimmed) || !SAFE_MAILTO_RE.test(trimmed)) return null;
  return `mailto:${trimmed}`;
}

/** Validate a social link or handle for store settings (empty, @handle, or https:// URL). */
export function isSafeSocialReference(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  if (CTRL_CHARS_ALL_RE.test(trimmed)) return false;
  if (/^@[A-Za-z0-9._-]{2,100}$/.test(trimmed)) return true;
  return safeExternalUrl(trimmed, { allowHttp: false }) !== null;
}

/** Encode a single URL path segment (like a product slug or ID), rejecting traversal segments. */
export function safePathSegment(segment: string | null | undefined): string | null {
  if (typeof segment !== "string") return null;
  const trimmed = segment.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || CTRL_CHARS_ALL_RE.test(trimmed)) return null;
  if (trimmed.includes("/") || trimmed.includes("\\")) return null;
  return encodeURIComponent(trimmed);
}

// ───────────────────── HTTP & Email Header Context ─────────────────────

/** Strip CR, LF, NUL and other C0 control characters to prevent HTTP/SMTP header injection. */
export function sanitizeHeaderText(value: unknown, maxLen = 500): string {
  return normalizeSingleLineText(value, maxLen);
}

/** Sanitize a download filename for safe use in Content-Disposition headers. */
export function sanitizeFilename(value: string, fallback = "download"): string {
  const cleaned = value
    .replace(CTRL_CHARS_GLOBAL_RE, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 120);
  return cleaned || fallback;
}
