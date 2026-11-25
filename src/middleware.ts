import { NextResponse, type NextRequest } from "next/server";
import {
  API_CSP,
  BASE_SECURITY_HEADERS,
  HSTS_HEADER,
  SVG_ASSET_CSP,
  UPLOADED_FILE_CSP,
  buildPageCsp,
  generateCspNonce,
  isHttpsRequest,
  isIncomingRequestHttps,
  isLoopbackRequestHost,
  isNoReferrerPath,
  isPrivateNoStorePath,
} from "@/lib/security-headers";

const SESSION_COOKIE = "pamarcy_session";
const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;

function isEdgeSecureRequest(req: NextRequest): boolean {
  const explicit = process.env.COOKIE_SECURE?.trim().toLowerCase();
  if (explicit === "true" || explicit === "1") return true;
  if (explicit === "false" || explicit === "0") return false;
  if (process.env.NODE_ENV === "production") return true;
  return isHttpsRequest(req);
}

function clearEdgeSessionCookie(req: NextRequest, res: NextResponse) {
  const sameSite = process.env.SESSION_COOKIE_SAMESITE?.trim().toLowerCase() === "strict" ? "strict" : "lax";
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: isEdgeSecureRequest(req),
    sameSite,
    path: "/",
    maxAge: 0,
    expires: new Date(0),
  });
}

type SecurityHeaderOptions = {
  csp: string;
  isPrivate: boolean;
  enableHsts: boolean;
  referrerPolicy?: string;
};

function applySecurityHeaders(res: NextResponse, opts: SecurityHeaderOptions): NextResponse {
  for (const { key, value } of BASE_SECURITY_HEADERS) {
    res.headers.set(key, value);
  }
  if (opts.referrerPolicy) {
    res.headers.set("Referrer-Policy", opts.referrerPolicy);
  }
  res.headers.set("Content-Security-Policy", opts.csp);
  if (opts.enableHsts) {
    res.headers.set(HSTS_HEADER.key, HSTS_HEADER.value);
  }
  if (opts.isPrivate && !res.headers.has("Cache-Control")) {
    res.headers.set("Cache-Control", "private, no-store");
  }
  return res;
}

/**
 * Edge middleware: security headers (including per-request cryptographic CSP nonces) +
 * session cookie format/presence check for protected areas.
 * Real authorization (DB session validity, expiration, idle timeout, roles, permissions)
 * is enforced server-side in layouts and every API route.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const rawSession = req.cookies.get(SESSION_COOKIE)?.value;
  const hasValidSessionFormat = typeof rawSession === "string" && SESSION_TOKEN_RE.test(rawSession);
  const isDev = process.env.NODE_ENV === "development";
  const isIncomingHttps = isIncomingRequestHttps(req);
  const isHttps = isHttpsRequest(req);
  const enableHsts = process.env.NODE_ENV === "production" || isHttps;
  const referrerPolicy = isNoReferrerPath(pathname) ? "no-referrer" : undefined;

  // Enforce encryption in transit: redirect plaintext HTTP to HTTPS in production or when ENFORCE_HTTPS=true
  const enforceHttpsFlag = process.env.ENFORCE_HTTPS?.trim().toLowerCase();
  const forceHttps = enforceHttpsFlag === "true" || enforceHttpsFlag === "1";
  const allowInsecureHttp = process.env.ALLOW_INSECURE_HTTP?.trim().toLowerCase() === "true";
  const mustRedirectToHttps =
    !isIncomingHttps &&
    !allowInsecureHttp &&
    (forceHttps || (process.env.NODE_ENV === "production" && !isLoopbackRequestHost(req)));

  if (mustRedirectToHttps) {
    const httpsUrl = req.nextUrl.clone();
    httpsUrl.protocol = "https:";
    if (httpsUrl.port === "80") httpsUrl.port = "";
    const redir = NextResponse.redirect(httpsUrl, 308);
    return applySecurityHeaders(redir, {
      csp: API_CSP,
      isPrivate: isPrivateNoStorePath(pathname),
      enableHsts: true,
      referrerPolicy,
    });
  }

  if (pathname.startsWith("/admin") && !pathname.startsWith("/admin/login") && !hasValidSessionFormat) {
    const url = req.nextUrl.clone();
    url.pathname = "/admin/login";
    url.search = "";
    url.searchParams.set("next", pathname);
    const res = NextResponse.redirect(url);
    if (rawSession !== undefined) clearEdgeSessionCookie(req, res);
    return applySecurityHeaders(res, { csp: API_CSP, isPrivate: true, enableHsts, referrerPolicy });
  }
  if (pathname.startsWith("/account") && !hasValidSessionFormat) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("next", pathname);
    const res = NextResponse.redirect(url);
    if (rawSession !== undefined) clearEdgeSessionCookie(req, res);
    return applySecurityHeaders(res, { csp: API_CSP, isPrivate: true, enableHsts, referrerPolicy });
  }

  // User/admin uploaded files served through API (sandboxed non-executable CSP)
  if (pathname.startsWith("/api/files/")) {
    const res = NextResponse.next();
    if (rawSession !== undefined && !hasValidSessionFormat) clearEdgeSessionCookie(req, res);
    return applySecurityHeaders(res, {
      csp: UPLOADED_FILE_CSP,
      referrerPolicy,
      isPrivate: isPrivateNoStorePath(pathname),
      enableHsts,
    });
  }

  // All other API endpoints return JSON or CSV (never HTML)
  if (pathname.startsWith("/api/")) {
    const res = NextResponse.next();
    if (rawSession !== undefined && !hasValidSessionFormat) clearEdgeSessionCookie(req, res);
    return applySecurityHeaders(res, {
      csp: API_CSP,
      referrerPolicy,
      isPrivate: isPrivateNoStorePath(pathname),
      enableHsts,
    });
  }

  // Direct public SVG files (e.g. /logo-mark.svg)
  if (pathname.toLowerCase().endsWith(".svg")) {
    const res = NextResponse.next();
    return applySecurityHeaders(res, {
      csp: SVG_ASSET_CSP,
      isPrivate: false,
      enableHsts,
    });
  }

  // HTML page routes: generate fresh per-request CSP nonce and forward it to Next.js App Router
  const nonce = generateCspNonce();
  const pageCsp = buildPageCsp({
    nonce,
    isDev,
    upgradeInsecureRequests: !isDev && (isIncomingHttps || (isHttps && !isLoopbackRequestHost(req))),
  });

  const requestHeaders = new Headers(req.headers);
  requestHeaders.delete("content-security-policy-report-only");
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", pageCsp);

  const res = NextResponse.next({
    request: { headers: requestHeaders },
  });
  if (rawSession !== undefined && !hasValidSessionFormat) {
    clearEdgeSessionCookie(req, res);
  }
  return applySecurityHeaders(res, {
    csp: pageCsp,
    referrerPolicy,
    isPrivate: isPrivateNoStorePath(pathname),
    enableHsts,
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|uploads/|images/).*)"],
};
