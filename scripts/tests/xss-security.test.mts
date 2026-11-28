import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  escapeHtml,
  escapeHtmlAttr,
  formatTextAsSafeHtml,
  isSafeSocialReference,
  normalizeMultilineText,
  normalizeSingleLineText,
  renderSafeEmailHtml,
  safeExplorerTxUrl,
  safeExternalUrl,
  safeImageSrc,
  safeInternalPath,
  safeMailtoHref,
  safeNavigationHref,
  safePathSegment,
  safePaypalApproveUrl,
  safePrescriptionHref,
  safeTelHref,
  sanitizeFilename,
  sanitizeHeaderText,
  serializeJsonForHtml,
  validateBannerLink,
} from "../../src/lib/sanitize.ts";
import { makeT } from "../../src/lib/i18n/translate.ts";
import { dictionaries } from "../../src/lib/i18n/dictionaries.ts";
import {
  bannerSchema,
  categorySchema,
  checkoutSchema,
  medicineSchema,
  storeSettingsSchema,
} from "../../src/lib/validators.ts";

const APP = process.env.APP_URL || "http://localhost:3000";

function walkSrc(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkSrc(full, out);
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(full);
  }
  return out;
}

describe("Static source-code XSS sink audit", () => {
  it("forbids unsafe DOM/HTML injection sinks anywhere in src/", () => {
    const files = walkSrc("src");
    assert.ok(files.length > 50, "Expected to scan all application source files");
    const forbidden = [
      /\bdangerouslySetInnerHTML\b/,
      /\.\s*innerHTML\s*=/,
      /\.\s*outerHTML\s*=/,
      /\.\s*insertAdjacentHTML\s*\(/,
      /\bdocument\.write(?:ln)?\s*\(/,
      /\beval\s*\(/,
      /\bnew\s+Function\s*\(/,
    ];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const re of forbidden) {
        assert.equal(re.test(src), false, `Unsafe XSS sink matching ${re} found in ${f}`);
      }
    }
  });

  it("ensures all target=_blank links include rel=noopener noreferrer", () => {
    const files = walkSrc("src").filter((f) => f.endsWith(".tsx"));
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const matches = [...src.matchAll(/<(?:a|Link)\b[^>]*target="_blank"[^>]*>/g)];
      for (const m of matches) {
        assert.match(
          m[0],
          /rel="noopener noreferrer"/,
          `target="_blank" link in ${f} missing rel="noopener noreferrer": ${m[0]}`,
        );
      }
    }
  });

  it("ensures dynamic URL rendering sinks use context-aware sanitizers", () => {
    const orderDetail = readFileSync("src/components/admin/order-detail.tsx", "utf8");
    assert.match(orderDetail, /safePrescriptionHref\(/);
    assert.equal(orderDetail.includes("href={o.prescriptionUrl}"), false);

    const home = readFileSync("src/app/(shop)/page.tsx", "utf8");
    assert.match(home, /safeNavigationHref\(/);
    assert.match(home, /safeImageSrc\(/);
    assert.equal(home.includes('href={b.link ?? "/shop"}'), false);

    const panel = readFileSync("src/components/payment/payment-panel.tsx", "utf8");
    assert.match(panel, /safePaypalApproveUrl\(/);
    assert.match(panel, /safeExplorerTxUrl\(/);
    assert.match(panel, /safeImageSrc\(/);
    assert.equal(panel.includes("href={p.paypalApproveUrl}"), false);
    assert.equal(panel.includes("href={p.network.explorer + p.txHash}"), false);

    const bell = readFileSync("src/components/common/notification-bell.tsx", "utf8");
    assert.match(bell, /safeInternalPath\(/);
    assert.equal(bell.includes("href={n.link}"), false);

    const credits = readFileSync("src/app/(shop)/credits/page.tsx", "utf8");
    assert.match(credits, /safeExternalUrl\(/);
    assert.equal(credits.includes("href={c.source}"), false);
    assert.equal(credits.includes("href={c.licenseUrl}"), false);

    const productImg = readFileSync("src/components/common/product-image.tsx", "utf8");
    assert.match(productImg, /safeImageSrc\(/);

    const authForm = readFileSync("src/components/auth/auth-form.tsx", "utf8");
    assert.match(authForm, /safeInternalPath\(/);
  });
});

describe("Context-aware HTML, template & JSON escaping", () => {
  it("escapes HTML special characters in text and attribute contexts while preserving legitimate Unicode & Khmer text", () => {
    const untrusted = `<script>alert("xss")</script> & 'Dr. O'Connor' \`test\` < 500mg — ឱសថស្ថាន ផាម៉ាស៊ី`;
    const escaped = escapeHtml(untrusted);
    assert.equal(escaped.includes("<script>"), false);
    assert.equal(escaped.includes("</script>"), false);
    assert.ok(escaped.includes("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"));
    assert.ok(escaped.includes("&amp; &#39;Dr. O&#39;Connor&#39; &#96;test&#96; &lt; 500mg"));
    assert.ok(escaped.includes("ឱសថស្ថាន ផាម៉ាស៊ី"));

    const attrEsc = escapeHtmlAttr(`" onclick="alert(1)\r\n\x00`);
    assert.equal(attrEsc.includes('"'), false);
    assert.equal(/[\x00-\x1f]/.test(attrEsc), false);
    assert.ok(attrEsc.startsWith("&quot;"));
  });

  it("formats multiline text to safe HTML preserving paragraphs & line breaks while neutralizing HTML tags", () => {
    const input = "Line 1: Children < 12\r\nLine 2: Take 1 tablet & water\n\n<img src=x onerror=alert(1)>";
    const html = formatTextAsSafeHtml(input);
    assert.equal(html.includes("<img"), false);
    assert.ok(html.includes("Children &lt; 12<br />Line 2: Take 1 tablet &amp; water"));
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
    assert.equal((html.match(/<p /g) ?? []).length, 2, "Double newline should preserve paragraph break");
  });

  it("renders safe HTML emails escaping untrusted content and blocking dangerous CTA URLs", () => {
    const malicious = renderSafeEmailHtml({
      title: `New order <img src=x onerror=alert(1)>\r\nBcc: evil@example.com`,
      message: `Customer: <b>Mallory</b>\nNotes: Take < 2 pills`,
      linkUrl: "javascript:alert(document.cookie)",
      linkLabel: `<script>x</script>`,
    });
    assert.equal(malicious.includes("<img"), false);
    assert.equal(malicious.includes("<b>"), false);
    assert.equal(malicious.includes("<script>"), false);
    assert.equal(malicious.includes("javascript:"), false);
    assert.equal(malicious.includes("<a "), false, "Unsafe CTA URL must be omitted");
    assert.ok(malicious.includes("&lt;b&gt;Mallory&lt;/b&gt;<br />Notes: Take &lt; 2 pills"));

    const legit = renderSafeEmailHtml({
      title: "New order PM-001",
      message: "Hello សុខា,\nYour order is ready.",
      linkUrl: "https://pamarcy.com.kh/admin/orders/ord_1?a=1&b=2",
      linkLabel: "Open Order",
    });
    assert.ok(legit.includes('href="https://pamarcy.com.kh/admin/orders/ord_1?a=1&amp;b=2"'));
    assert.ok(legit.includes('rel="noopener noreferrer"'));
    assert.ok(legit.includes("Hello សុខា,<br />Your order is ready."));
  });

  it("serializes JSON safely for HTML script contexts without </script> breakout", () => {
    const payload = { note: "</script><script>alert(1)</script><!-- & \u2028\u2029" };
    const serialized = serializeJsonForHtml(payload);
    assert.equal(serialized.includes("</script>"), false);
    assert.equal(serialized.includes("<"), false);
    assert.equal(serialized.includes(">"), false);
    assert.equal(serialized.includes("&"), false);
    assert.equal(serialized.includes("\u2028"), false);
    assert.equal(serialized.includes("\u2029"), false);
    assert.deepEqual(JSON.parse(serialized), payload);
  });

  it("prevents $ replacement-pattern injection in i18n template interpolation", () => {
    const t = makeT(dictionaries.en);
    const out = t("shop.results", { n: "$& $` $' $$ <script>" });
    assert.ok(out.includes("$& $` $' $$ <script>"));
  });
});

describe("Context-aware URL, navigation, image & payment link sanitization", () => {
  it("blocks javascript:, data:, vbscript:, control-char obfuscation, and backslash/protocol-relative open redirects", () => {
    const badUrls = [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "   javascript:alert(1)",
      "\tjavascript:alert(1)",
      "java\nscript:alert(1)",
      "java\rscript:alert(1)",
      "java\x00script:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "vbscript:msgbox(1)",
      "blob:https://pamarcy.com.kh/123",
      "file:///etc/passwd",
      "//evil.example.com/phish",
      "/\\evil.example.com/phish",
      "\\/evil.example.com",
      "https://user:pass@evil.example.com/x",
    ];

    for (const u of badUrls) {
      assert.equal(safeInternalPath(u), null, `safeInternalPath must reject ${JSON.stringify(u)}`);
      assert.equal(safeInternalPath(u, "/fallback"), "/fallback");
      assert.equal(validateBannerLink(u), null, `validateBannerLink must reject ${JSON.stringify(u)}`);
      assert.equal(safeNavigationHref(u, "/shop"), "/shop");
      assert.equal(safeImageSrc(u), null, `safeImageSrc must reject ${JSON.stringify(u)}`);
      assert.equal(safePrescriptionHref(u), null, `safePrescriptionHref must reject ${JSON.stringify(u)}`);
      assert.equal(safePaypalApproveUrl(u), null, `safePaypalApproveUrl must reject ${JSON.stringify(u)}`);
    }

    assert.equal(safeInternalPath("/shop?category=pain-relief&page=2"), "/shop?category=pain-relief&page=2");
    assert.equal(safeNavigationHref("/shop?offers=1"), "/shop?offers=1");
    assert.equal(safeNavigationHref("https://pamarcy.com.kh/promo"), "https://pamarcy.com.kh/promo");
    assert.equal(safeNavigationHref("http://insecure.example.com/promo", "/shop"), "/shop");
  });

  it("enforces strict allowlists for image sources, prescriptions, PayPal URLs, explorers, tel, and mailto", () => {
    // Images
    assert.equal(safeImageSrc("/images/products/pain-relief/paracetamol-500mg-tablets.jpg"), "/images/products/pain-relief/paracetamol-500mg-tablets.jpg");
    assert.equal(safeImageSrc("/api/files/uploads/products/1234-abcd.webp"), "/api/files/uploads/products/1234-abcd.webp");
    assert.equal(safeImageSrc("https://res.cloudinary.com/demo/image/upload/v1/med.jpg"), "https://res.cloudinary.com/demo/image/upload/v1/med.jpg");
    assert.equal(safeImageSrc("https://evil.example.com/pic.jpg"), null);
    assert.equal(safeImageSrc("/images/products/../../etc/passwd.jpg"), null);
    assert.equal(safeImageSrc("/images/evil.svg"), null);
    assert.equal(safeImageSrc("data:image/svg+xml;base64,PHN2Zy8+", { allowQrPngDataUrl: true }), null);
    assert.equal(safeImageSrc("data:image/png;base64,iVBORw0KGgo=", { allowQrPngDataUrl: false }), null);
    assert.equal(safeImageSrc("data:image/png;base64,iVBORw0KGgo=", { allowQrPngDataUrl: true }), "data:image/png;base64,iVBORw0KGgo=");

    // Prescriptions
    assert.equal(safePrescriptionHref("/api/files/prescriptions/a1b2-c3d4.pdf"), "/api/files/prescriptions/a1b2-c3d4.pdf");
    assert.equal(
      safePrescriptionHref("/api/files/prescriptions/a1b2-c3d4.jpg?claim=1700000000000.abcdefghijklmnopqrstuvwxyz123456"),
      "/api/files/prescriptions/a1b2-c3d4.jpg?claim=1700000000000.abcdefghijklmnopqrstuvwxyz123456",
    );
    assert.equal(safePrescriptionHref("/api/files/prescriptions/../secret.pdf"), null);
    assert.equal(safePrescriptionHref("https://evil.example.com/rx.pdf"), null);

    // PayPal
    assert.equal(
      safePaypalApproveUrl("https://www.sandbox.paypal.com/checkoutnow?token=ABC123"),
      "https://www.sandbox.paypal.com/checkoutnow?token=ABC123",
    );
    assert.equal(safePaypalApproveUrl("https://paypal.com.evil.com/checkoutnow"), null);
    assert.equal(safePaypalApproveUrl("http://www.paypal.com/checkoutnow"), null);

    // Explorers
    const validHash = "cef89faeeb694e6a372e4bc77289003e4b9eb378caf6ff07e641a0360cef82d8";
    assert.equal(
      safeExplorerTxUrl("https://tronscan.org/#/transaction/", validHash),
      `https://tronscan.org/#/transaction/${validHash}`,
    );
    assert.equal(safeExplorerTxUrl("https://tronscan.org/#/transaction/", "javascript:alert(1)"), null);
    assert.equal(safeExplorerTxUrl("https://evil.example.com/tx/", validHash), null);

    // Tel, Mailto, Social, External, Path segments
    assert.equal(safeTelHref("+855 23 900 888"), "tel:+85523900888");
    assert.equal(safeTelHref("javascript:alert(1)"), null);
    assert.equal(safeMailtoHref("hello@pamarcy.com.kh"), "mailto:hello@pamarcy.com.kh");
    assert.equal(safeMailtoHref("hello@pamarcy.com.kh?bcc=attacker@evil.com"), null);
    assert.equal(safeMailtoHref("hello@pamarcy.com.kh\r\nBcc:evil@x.com"), null);
    assert.equal(isSafeSocialReference("@pamarcy_kh"), true);
    assert.equal(isSafeSocialReference("https://t.me/pamarcy"), true);
    assert.equal(isSafeSocialReference("javascript:alert(1)"), false);
    assert.equal(safeExternalUrl("http://creativecommons.org/publicdomain/zero/1.0/deed.en", { allowHttp: true }) !== null, true);
    assert.equal(safePathSegment("paracetamol-500"), "paracetamol-500");
    assert.equal(safePathSegment("../admin"), null);
  });

  it("sanitizes HTTP/email header text, filenames, and preserves multiline formatting safely", () => {
    assert.equal(sanitizeHeaderText("Order #1\r\nBcc: evil@example.com\x00"), "Order #1 Bcc: evil@example.com");
    assert.equal(sanitizeFilename('sales-2026"; filename="evil.html'), "sales-2026-filename-evil.html");
    assert.equal(sanitizeFilename("../../etc/passwd"), "etc-passwd");
    assert.equal(normalizeSingleLineText("  Hello\r\nWorld  "), "Hello World");
    assert.equal(normalizeMultilineText("Line 1\r\nLine 2\x00\n\nLine 3"), "Line 1\nLine 2\n\nLine 3");
  });
});

describe("Zod input validation XSS defenses (preserving legitimate formatting)", () => {
  it("rejects XSS URLs in banner, medicine, category, checkout, and store settings schemas", () => {
    assert.equal(
      bannerSchema.safeParse({
        titleEn: "Promo",
        titleKm: "ប្រូម៉ូសិន",
        imageUrl: "/images/banners/banner-promo-vitamins.jpg",
        link: "javascript:alert(1)",
      }).success,
      false,
    );
    assert.equal(
      bannerSchema.safeParse({
        titleEn: "Promo",
        titleKm: "ប្រូម៉ូសិន",
        imageUrl: "javascript:alert(1)",
        link: "/shop",
      }).success,
      false,
    );
    assert.equal(
      categorySchema.safeParse({
        nameEn: "Pain Relief",
        nameKm: "បំបាត់ការឈឺចាប់",
        imageUrl: "data:image/svg+xml;base64,PHN2Zy8+",
      }).success,
      false,
    );
    assert.equal(
      checkoutSchema.safeParse({
        items: [{ medicineId: "med_123", quantity: 1 }],
        fullName: "Sokha",
        phone: "012345678",
        province: "Phnom Penh",
        district: "Doun Penh",
        prescriptionUrl: "javascript:alert(document.domain)",
      }).success,
      false,
    );
    assert.equal(
      storeSettingsSchema.safeParse({
        storeNameEn: "Pamarcy",
        storeNameKm: "ផាម៉ាស៊ី",
        phone: "+85523900888",
        email: "hello@pamarcy.com.kh",
        addressEn: "Phnom Penh",
        addressKm: "ភ្នំពេញ",
        openingHours: "07:00 - 21:00",
        licenseNo: "MOH-001",
        exchangeRate: 4100,
        deliveryFeePhnomPenh: 1.5,
        deliveryFeeProvince: 3,
        freeDeliveryThreshold: 30,
        reservationMinutes: 30,
        lowStockDefault: 10,
        emailNotifications: false,
        notificationEmail: "",
        facebook: "javascript:alert(1)",
        telegram: "",
      }).success,
      false,
    );
  });

  it("preserves legitimate multiline text, Khmer script, and medical punctuation (<, >, &, quotes)", () => {
    const res = medicineSchema.safeParse({
      nameEn: "Paracetamol 500mg",
      nameKm: "ប៉ារ៉ាសេតាម៉ុល ៥០០ម.ក្រ",
      sku: "PR-PARA-500",
      categoryId: "cat_123",
      price: 2.5,
      costPrice: 1.2,
      descriptionEn: "Adults & children > 12 years:\nTake 1–2 tablets every 4–6 hours.\nDo not use if age < 12 without Dr. O'Connor's advice.",
      warnings: "Keep out of reach of children.\nDo not exceed 4g/day.",
      imageUrl: "/images/products/pain-relief/paracetamol-500mg-tablets.jpg",
    });
    assert.equal(res.success, true);
    if (res.success) {
      assert.ok(res.data.descriptionEn?.includes("Adults & children > 12 years:\n"));
      assert.ok(res.data.descriptionEn?.includes("age < 12"));
      assert.ok(res.data.warnings?.includes("children.\nDo not"));
    }
  });
});

describe("Live HTTP SSR XSS output escaping verification (when server is running)", () => {
  it("escapes reflected search queries and filters unknown query params in pagination links", async (t) => {
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

    const payload = `"><script>window.__xss=1</script><img src=x onerror=alert(1)>`;
    const res = await fetch(`${APP}/shop?q=${encodeURIComponent(payload)}&injectedParam=evil`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.equal(html.includes("<script>window.__xss=1</script>"), false, "Reflected <script> must be HTML-escaped");
    assert.equal(html.includes("<img src=x onerror=alert(1)>"), false, "Reflected <img> must be HTML-escaped");
    assert.ok(html.includes("&lt;script&gt;window.__xss=1&lt;/script&gt;"), "Escaped search text should render safely in heading");

    const pageRes = await fetch(`${APP}/shop?page=1&injectedParam=evil`);
    assert.equal(pageRes.status, 200);
    const pageHtml = await pageRes.text();
    const hrefs = [...pageHtml.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
    assert.ok(hrefs.some((h) => h.includes("/shop?page=2")), "Expected pagination link to /shop?page=2");
    for (const h of hrefs) {
      assert.equal(h.includes("injectedParam"), false, `Unknown query param reflected into href: ${h}`);
    }
  });
});
