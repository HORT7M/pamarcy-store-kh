import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}

import nextConfigMod from "../../next.config.ts";
const nextConfig = ("default" in nextConfigMod && nextConfigMod.default ? nextConfigMod.default : nextConfigMod) as typeof nextConfigMod;
import { middleware } from "../../src/middleware.ts";
import {
  API_CSP,
  BASE_SECURITY_HEADERS,
  HSTS_HEADER,
  SVG_ASSET_CSP,
  UPLOADED_FILE_CSP,
  buildPageCsp,
  generateCspNonce,
  getNextConfigHeaders,
  isNoReferrerPath,
  isPrivateNoStorePath,
  resolveActiveBotProvider,
} from "../../src/lib/security-headers.ts";

const APP = process.env.APP_URL || "http://localhost:3000";

function parseCsp(csp: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const raw of csp.split(";")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const name = parts[0]!.toLowerCase();
    map.set(name, parts.slice(1));
  }
  return map;
}

describe("HTTP security headers configuration (unit)", () => {
  it("generates unique 128-bit base64 cryptographic CSP nonces compatible with Next.js", () => {
    const seen = new Set<string>();
    const nextNonceRegex = /^[A-Za-z0-9+/_-]+={0,2}$/;
    for (let i = 0; i < 64; i++) {
      const n = generateCspNonce();
      assert.match(n, nextNonceRegex, `Nonce "${n}" must match Next.js CSP nonce regex`);
      assert.equal(Buffer.from(n, "base64").length, 16, "Nonce should decode to 16 random bytes (128 bits)");
      assert.equal(seen.has(n), false, "Nonces must be unique per request");
      seen.add(n);
    }
  });

  it("builds a strict production page CSP without unsafe-inline scripts, unsafe-eval, or unused third-party PayPal origins", () => {
    const nonce = generateCspNonce();
    const csp = buildPageCsp({
      nonce,
      isDev: false,
      upgradeInsecureRequests: true,
      botProvider: "builtin",
    });
    const d = parseCsp(csp);

    assert.deepEqual(d.get("default-src"), ["'self'"]);

    const scriptSrc = d.get("script-src") ?? [];
    assert.ok(scriptSrc.includes(`'nonce-${nonce}'`), "script-src must contain the per-request nonce");
    assert.ok(scriptSrc.includes("'strict-dynamic'"), "script-src must include 'strict-dynamic'");
    assert.equal(scriptSrc.includes("'unsafe-inline'"), false, "script-src must never allow 'unsafe-inline'");
    assert.equal(scriptSrc.includes("'unsafe-eval'"), false, "production script-src must never allow 'unsafe-eval'");
    assert.equal(scriptSrc.some((s) => s.includes("paypal")), false, "unused PayPal script origins must not be allowed");

    assert.deepEqual(d.get("script-src-attr"), ["'none'"], "inline event handlers must be blocked via script-src-attr");

    // Required compatibility for next/image, RootLayout font vars, Sonner, Radix, Recharts
    assert.deepEqual(d.get("style-src"), ["'self'", "'unsafe-inline'"]);

    // Required compatibility for KHQR/USDT/PayPal QR data URLs, jsPDF blobs, Cloudinary & Wikimedia
    const imgSrc = d.get("img-src") ?? [];
    assert.ok(imgSrc.includes("'self'"));
    assert.ok(imgSrc.includes("data:"));
    assert.ok(imgSrc.includes("blob:"));
    assert.ok(imgSrc.includes("https://res.cloudinary.com"));
    assert.ok(imgSrc.includes("https://upload.wikimedia.org"));
    assert.equal(imgSrc.some((s) => s.includes("paypal")), false);

    assert.deepEqual(d.get("font-src"), ["'self'"]);
    assert.deepEqual(d.get("connect-src"), ["'self'"]);
    assert.deepEqual(d.get("media-src"), ["'none'"]);
    assert.deepEqual(d.get("object-src"), ["'none'"]);
    assert.deepEqual(d.get("frame-src"), ["'none'"]);
    assert.deepEqual(d.get("worker-src"), ["'none'"]);
    assert.deepEqual(d.get("frame-ancestors"), ["'none'"]);
    assert.deepEqual(d.get("base-uri"), ["'none'"]);
    assert.deepEqual(d.get("form-action"), ["'self'"]);
    assert.ok(d.has("upgrade-insecure-requests"), "HTTPS production responses should include upgrade-insecure-requests");
  });

  it("omits upgrade-insecure-requests on HTTP and scopes unsafe-eval & HMR websockets strictly to dev", () => {
    const prodHttp = parseCsp(buildPageCsp({ nonce: "abc123", isDev: false, upgradeInsecureRequests: false, botProvider: "builtin" }));
    assert.equal(prodHttp.has("upgrade-insecure-requests"), false);
    assert.equal((prodHttp.get("script-src") ?? []).includes("'unsafe-eval'"), false);

    const dev = parseCsp(buildPageCsp({ nonce: "abc123", isDev: true, upgradeInsecureRequests: false, botProvider: "builtin" }));
    assert.ok((dev.get("script-src") ?? []).includes("'unsafe-eval'"));
    assert.ok((dev.get("connect-src") ?? []).includes("ws://localhost:*"));
  });

  it("conditionally allows Turnstile or hCaptcha origins ONLY when configured", () => {
    assert.equal(resolveActiveBotProvider({}), "builtin");
    assert.equal(
      resolveActiveBotProvider({ TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret" }),
      "turnstile",
    );
    assert.equal(
      resolveActiveBotProvider({ BOT_PROTECTION_PROVIDER: "builtin", TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret" }),
      "builtin",
    );
    assert.equal(
      resolveActiveBotProvider({ HCAPTCHA_SITE_KEY: "site", HCAPTCHA_SECRET_KEY: "secret" }),
      "hcaptcha",
    );

    const ts = parseCsp(buildPageCsp({ nonce: "n1", isDev: false, botProvider: "turnstile" }));
    assert.ok((ts.get("frame-src") ?? []).includes("https://challenges.cloudflare.com"));
    assert.ok((ts.get("connect-src") ?? []).includes("https://challenges.cloudflare.com"));

    const hc = parseCsp(buildPageCsp({ nonce: "n1", isDev: false, botProvider: "hcaptcha" }));
    assert.ok((hc.get("script-src") ?? []).includes("https://hcaptcha.com"));
    assert.ok((hc.get("frame-src") ?? []).includes("https://hcaptcha.com"));
    assert.ok((hc.get("frame-src") ?? []).includes("https://*.hcaptcha.com"));
    assert.ok((hc.get("connect-src") ?? []).includes("https://api.hcaptcha.com"));
  });

  it("configures next.config.ts with global baseline headers, disabled X-Powered-By, and zero CSP conflict on dynamic pages", async () => {
    assert.equal(nextConfig.poweredByHeader, false, "X-Powered-By must be disabled");
    assert.equal(typeof nextConfig.headers, "function");

    const rules = getNextConfigHeaders(true);
    const globalRule = rules.find((r) => r.source === "/(.*)");
    assert.ok(globalRule, "next.config.ts must define a global /(.*) header rule");

    const globalMap = new Map(globalRule.headers.map((h) => [h.key.toLowerCase(), h.value]));
    assert.equal(globalMap.get("x-frame-options"), "DENY");
    assert.equal(globalMap.get("x-content-type-options"), "nosniff");
    assert.equal(globalMap.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.equal(globalMap.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(globalMap.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(globalMap.get("x-dns-prefetch-control"), "off");
    assert.equal(globalMap.get("x-permitted-cross-domain-policies"), "none");
    assert.equal(globalMap.get("x-download-options"), "noopen");
    assert.equal(globalMap.get("x-xss-protection"), "0");
    assert.equal(globalMap.get("strict-transport-security"), HSTS_HEADER.value);
    assert.match(globalMap.get("permissions-policy") ?? "", /camera=\(\)/);
    assert.match(globalMap.get("permissions-policy") ?? "", /microphone=\(\)/);
    assert.match(globalMap.get("permissions-policy") ?? "", /geolocation=\(\)/);
    // Must NOT set COEP: require-corp (would break external Cloudinary/Wikimedia images)
    assert.equal(globalMap.has("cross-origin-embedder-policy"), false);
    // Must NOT set global CSP on /(.*) because middleware sets per-request nonce CSP on matched routes
    assert.equal(globalMap.has("content-security-policy"), false);

    // Excluded static paths MUST have locked-down CSP headers
    for (const staticSource of ["/uploads/:path*", "/images/:path*", "/favicon.ico", "/_next/image", "/_next/static/:path*"]) {
      const r = rules.find((x) => x.source === staticSource);
      assert.ok(r, `Missing static CSP rule for ${staticSource}`);
      const csp = r.headers.find((h) => h.key.toLowerCase() === "content-security-policy")?.value ?? "";
      assert.ok(csp.includes("default-src 'none'"), `${staticSource} CSP must start with default-src 'none'`);
      assert.ok(csp.includes("frame-ancestors 'none'"), `${staticSource} CSP must forbid framing`);
      if (staticSource === "/uploads/:path*") {
        assert.ok(csp.includes("sandbox"), "/uploads/:path* CSP must include sandbox");
      }
    }
  });

  it("classifies private no-store and no-referrer routes accurately", () => {
    for (const p of ["/admin", "/admin/orders", "/account", "/checkout", "/checkout/pay/123", "/invoice/123", "/reset-password", "/api/admin/dashboard", "/api/auth/login", "/api/files/prescriptions/a.pdf", "/api/bot-protection/challenge"]) {
      assert.equal(isPrivateNoStorePath(p), true, `${p} should be private no-store`);
    }
    for (const p of ["/", "/shop", "/product/paracetamol-500", "/api/products", "/api/categories", "/api/files/uploads/products/a.jpg"]) {
      assert.equal(isPrivateNoStorePath(p), false, `${p} should not force private no-store`);
    }
    for (const p of ["/reset-password", "/checkout/pay/123", "/invoice/123", "/api/files/prescriptions/a.pdf"]) {
      assert.equal(isNoReferrerPath(p), true, `${p} should use Referrer-Policy: no-referrer`);
    }
    assert.equal(isNoReferrerPath("/shop"), false);
  });
});

describe("Edge middleware security headers enforcement", () => {
  it("applies unique per-request nonces, forwards CSP to Next.js, strips spoofed headers, and never leaks x-nonce in response", () => {
    const req1 = new NextRequest("https://pamarcy.com.kh/", {
      headers: {
        "x-forwarded-proto": "https",
        "x-nonce": "attacker-spoofed-nonce",
        "content-security-policy": "script-src 'unsafe-inline'",
        "content-security-policy-report-only": "script-src 'nonce-spoofed'",
      },
    });
    const res1 = middleware(req1);
    const csp1 = res1.headers.get("content-security-policy") ?? "";
    const m1 = csp1.match(/'nonce-([^']+)'/);
    assert.ok(m1, "HTML page response must include a CSP nonce");
    assert.notEqual(m1[1], "attacker-spoofed-nonce");
    assert.notEqual(m1[1], "spoofed");
    assert.equal(res1.headers.get("x-nonce"), null, "x-nonce must not be leaked as a response header");
    assert.equal(res1.headers.get("x-middleware-request-x-nonce"), m1[1], "Forwarded request x-nonce must match response CSP nonce");
    assert.equal(res1.headers.get("x-middleware-request-content-security-policy"), csp1, "Forwarded request CSP must match response CSP");
    assert.equal(res1.headers.get("x-middleware-request-content-security-policy-report-only"), null);

    // Second request must receive a fresh nonce
    const res2 = middleware(new NextRequest("https://pamarcy.com.kh/"));
    const csp2 = res2.headers.get("content-security-policy") ?? "";
    const m2 = csp2.match(/'nonce-([^']+)'/);
    assert.ok(m2);
    assert.notEqual(m1[1], m2[1], "Each request must receive a fresh CSP nonce");

    // Verify all baseline headers + HSTS on HTTPS request
    for (const { key, value } of BASE_SECURITY_HEADERS) {
      assert.equal(res1.headers.get(key), value, `Expected ${key}=${value}`);
    }
    assert.equal(res1.headers.get("strict-transport-security"), HSTS_HEADER.value);
  });

  it("enforces strict headers on redirects, API endpoints, token pages, uploads, and SVG files", () => {
    // Unauthenticated /admin redirect
    const redir = middleware(new NextRequest("http://localhost:3000/admin/orders"));
    assert.equal(redir.status, 307);
    assert.equal(redir.headers.get("x-frame-options"), "DENY");
    assert.equal(redir.headers.get("x-content-type-options"), "nosniff");
    assert.equal(redir.headers.get("content-security-policy"), API_CSP);
    assert.equal(redir.headers.get("cache-control"), "private, no-store");

    // Token-bearing pages must use Referrer-Policy: no-referrer and Cache-Control: private, no-store
    for (const url of [
      "http://localhost:3000/reset-password?token=secret123",
      "http://localhost:3000/checkout/pay/ord_1?token=hmac123",
      "http://localhost:3000/invoice/ord_1?token=hmac123",
    ]) {
      const r = middleware(new NextRequest(url));
      assert.equal(r.headers.get("referrer-policy"), "no-referrer", `${url} must set Referrer-Policy: no-referrer`);
      assert.equal(r.headers.get("cache-control"), "private, no-store", `${url} must set Cache-Control: private, no-store`);
      assert.match(r.headers.get("content-security-policy") ?? "", /'nonce-[^']+'/);
    }

    // JSON API route
    const apiRes = middleware(new NextRequest("http://localhost:3000/api/admin/dashboard"));
    assert.equal(apiRes.headers.get("content-security-policy"), API_CSP);
    assert.equal(apiRes.headers.get("cache-control"), "private, no-store");

    // Public catalogue API route should not force private no-store
    const pubApiRes = middleware(new NextRequest("http://localhost:3000/api/products"));
    assert.equal(pubApiRes.headers.get("content-security-policy"), API_CSP);
    assert.equal(pubApiRes.headers.get("cache-control"), null);

    // Private prescription file route
    const rxRes = middleware(new NextRequest("http://localhost:3000/api/files/prescriptions/abc.pdf"));
    assert.equal(rxRes.headers.get("content-security-policy"), UPLOADED_FILE_CSP);
    assert.equal(rxRes.headers.get("referrer-policy"), "no-referrer");
    assert.equal(rxRes.headers.get("cache-control"), "private, no-store");

    // Public uploaded catalogue image route preserves cacheability while applying sandboxed CSP
    const pubUploadRes = middleware(new NextRequest("http://localhost:3000/api/files/uploads/products/abc.jpg"));
    assert.equal(pubUploadRes.headers.get("content-security-policy"), UPLOADED_FILE_CSP);
    assert.equal(pubUploadRes.headers.get("cache-control"), null);

    // Direct SVG file
    const svgRes = middleware(new NextRequest("http://localhost:3000/logo-mark.svg"));
    assert.equal(svgRes.headers.get("content-security-policy"), SVG_ASSET_CSP);
    assert.equal(svgRes.headers.get("x-content-type-options"), "nosniff");

    // Local HTTP preview must NOT emit upgrade-insecure-requests even when APP_URL is https://
    const origAppUrl = process.env.APP_URL;
    try {
      process.env.APP_URL = "https://pamarcy.com.kh";
      const localHttpRes = middleware(new NextRequest("http://localhost:3000/shop"));
      const localCsp = localHttpRes.headers.get("content-security-policy") ?? "";
      assert.equal(localCsp.includes("upgrade-insecure-requests"), false, "Plain HTTP localhost must not emit upgrade-insecure-requests");

      // Forwarded: proto=https MUST emit upgrade-insecure-requests
      const fwdHttpsRes = middleware(
        new NextRequest("http://pamarcy.com.kh/shop", {
          headers: { forwarded: "for=203.0.113.10;proto=https", host: "pamarcy.com.kh" },
        }),
      );
      const fwdCsp = fwdHttpsRes.headers.get("content-security-policy") ?? "";
      assert.ok(fwdCsp.includes("upgrade-insecure-requests"), "Forwarded proto=https must emit upgrade-insecure-requests");
    } finally {
      if (origAppUrl === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = origAppUrl;
    }
  });
});

describe("Live HTTP security headers & SSR nonce compatibility (when server is running)", () => {
  it("verifies live headers, zero duplicate CSPs, and matching nonces on every SSR <script> tag", async (t) => {
    let reachable = false;
    try {
      const probe = await fetch(`${APP}/api/categories`, { signal: AbortSignal.timeout(1500) });
      reachable = probe.status > 0;
    } catch {
      reachable = false;
    }
    if (!reachable) {
      t.skip(`No live server listening at ${APP}`);
      return;
    }

    // 1. HTML pages: verify nonces match EVERY <script> tag and nonces rotate per request
    const pagePaths = ["/", "/shop", "/login", "/register", "/cart", "/credits", "/forgot-password", "/reset-password", "/admin/login"];
    const nonces = new Set<string>();

    for (const p of pagePaths) {
      const res = await fetch(`${APP}${p}`, { redirect: "manual" });
      assert.equal(res.status, 200, `Expected 200 on ${p}, got ${res.status}`);
      assert.equal(res.headers.get("x-powered-by"), null, `${p} must not expose X-Powered-By`);
      assert.equal(res.headers.get("x-frame-options"), "DENY", `${p} must set X-Frame-Options: DENY`);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff", `${p} must set X-Content-Type-Options: nosniff`);
      assert.equal(res.headers.get("cross-origin-opener-policy"), "same-origin");
      assert.equal(res.headers.get("cross-origin-resource-policy"), "same-origin");
      assert.equal(res.headers.get("x-nonce"), null, `${p} must not expose x-nonce response header`);

      const expectedReferrer = isNoReferrerPath(p) ? "no-referrer" : "strict-origin-when-cross-origin";
      assert.equal(res.headers.get("referrer-policy"), expectedReferrer, `${p} Referrer-Policy mismatch`);

      const csp = res.headers.get("content-security-policy") ?? "";
      assert.equal((csp.match(/default-src/g) ?? []).length, 1, `${p} must have exactly one Content-Security-Policy header (no duplicates)`);
      assert.ok(csp.includes("script-src-attr 'none'"), `${p} CSP must block inline event handlers`);
      const isDevServer = csp.includes("ws://localhost:*");
      const html = await res.text();
      const scriptTags = [...html.matchAll(/<script\b([^>]*)>/gi)];
      assert.ok(scriptTags.length > 0, `${p} should contain Next.js <script> tags`);
      if (!isDevServer) {
        const m = csp.match(/'nonce-([^']+)'/);
        assert.ok(m, `${p} production CSP must include a nonce`);
        const nonce = m[1]!;
        assert.equal(nonces.has(nonce), false, `Nonce reused across requests on ${p}`);
        nonces.add(nonce);
        for (const tag of scriptTags) {
          assert.ok(
            tag[1]!.includes(`nonce="${nonce}"`),
            `${p} contains a <script> tag without matching nonce="${nonce}": ${tag[0]}`,
          );
        }
      }
      assert.equal(/\son[a-z]+\s*=/i.test(html), false, `${p} SSR HTML should not contain inline event handlers`);
    }

    // 2. Static assets excluded from middleware must STILL receive full security headers + locked-down CSP
    for (const asset of ["/images/products/pain-relief/paracetamol-500mg-tablets.jpg", "/favicon.ico", "/logo-mark.svg"]) {
      const res = await fetch(`${APP}${asset}`);
      assert.equal(res.status, 200, `Expected 200 on ${asset}`);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff", `${asset} must include X-Content-Type-Options: nosniff`);
      assert.equal(res.headers.get("x-frame-options"), "DENY", `${asset} must include X-Frame-Options: DENY`);
      assert.equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
      assert.equal(res.headers.get("cross-origin-resource-policy"), "same-origin");
      const csp = res.headers.get("content-security-policy") ?? "";
      assert.ok(csp.includes("default-src 'none'"), `${asset} must have locked-down CSP`);
      assert.ok(csp.includes("frame-ancestors 'none'"), `${asset} must forbid framing`);
    }

    // 3. Redirect and API endpoint headers
    const adminRedir = await fetch(`${APP}/admin`, { redirect: "manual" });
    assert.equal(adminRedir.status, 307);
    assert.equal(adminRedir.headers.get("x-frame-options"), "DENY");
    assert.equal(adminRedir.headers.get("x-content-type-options"), "nosniff");
    assert.equal(adminRedir.headers.get("content-security-policy"), API_CSP);
    assert.equal(adminRedir.headers.get("cache-control"), "private, no-store");

    // 404 Not Found page must also receive full headers and valid matching nonces on all scripts
    const notFoundRes = await fetch(`${APP}/nonexistent-security-header-check-404`);
    assert.equal(notFoundRes.status, 404);
    assert.equal(notFoundRes.headers.get("x-frame-options"), "DENY");
    assert.equal(notFoundRes.headers.get("x-content-type-options"), "nosniff");
    const nfCsp = notFoundRes.headers.get("content-security-policy") ?? "";
    const nfHtml = await notFoundRes.text();
    if (!nfCsp.includes("ws://localhost:*")) {
      const nfMatch = nfCsp.match(/'nonce-([^']+)'/);
      assert.ok(nfMatch, "404 page must include a CSP nonce in production");
      for (const tag of nfHtml.matchAll(/<script\b([^>]*)>/gi)) {
        assert.ok(tag[1]!.includes(`nonce="${nfMatch[1]}"`), `404 page <script> missing matching nonce: ${tag[0]}`);
      }
    }

    // /_next/image optimizer must include baseline headers
    const imgOptRes = await fetch(`${APP}/_next/image?url=%2Fimages%2Fproducts%2Fpain-relief%2Fparacetamol-500mg-tablets.jpg&w=640&q=75`);
    assert.equal(imgOptRes.status, 200);
    assert.equal(imgOptRes.headers.get("x-content-type-options"), "nosniff");
    assert.equal(imgOptRes.headers.get("x-frame-options"), "DENY");
    assert.equal(imgOptRes.headers.get("cross-origin-resource-policy"), "same-origin");

    const api401 = await fetch(`${APP}/api/admin/dashboard`);
    assert.equal(api401.status, 401);
    assert.equal(api401.headers.get("x-content-type-options"), "nosniff");
    assert.equal(api401.headers.get("x-frame-options"), "DENY");
    assert.equal(api401.headers.get("content-security-policy"), API_CSP);
    assert.equal(api401.headers.get("cache-control"), "private, no-store");
  });
});
