import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_LOCALE,
  dictionaries,
  isLocale,
  LOCALES,
  LOCALE_META,
  normalizeLocale,
  type Dict,
} from "../../src/lib/i18n/dictionaries.ts";
import {
  localizeBanner,
  localizeCategoryName,
  localizePaymentMethod,
  localizePermissionDesc,
  localizeReportLabel,
  localizeRoleName,
  makeT,
  makeTryT,
  translateApiError,
  type TKey,
} from "../../src/lib/i18n/translate.ts";
import { generateAccessibleCaptcha } from "../../src/lib/security/captcha-svg.ts";
import { profileSchema } from "../../src/lib/validators.ts";

function flatten(obj: Record<string, unknown>, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      flatten(v as Record<string, unknown>, key, out);
    } else if (typeof v === "string") {
      out[key] = v;
    }
  }
  return out;
}

function placeholders(str: string): string[] {
  return [...new Set([...str.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort();
}

describe("i18n multilingual support (km, en, vi, zh-CN, fr)", () => {
  it("loads all 5 locale JSON files with exact key parity and non-empty strings", () => {
    assert.deepEqual([...LOCALES], ["km", "en", "vi", "zh-CN", "fr"]);
    assert.equal(DEFAULT_LOCALE, "km");

    const enFlat = flatten(dictionaries.en as unknown as Record<string, unknown>);
    const enKeys = Object.keys(enFlat).sort();
    assert.ok(enKeys.length >= 1000, `Expected comprehensive dictionary, got ${enKeys.length} keys`);

    for (const loc of LOCALES) {
      const filePath = path.join(process.cwd(), "src/lib/i18n/locales", `${loc}.json`);
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
      const flat = flatten(parsed);
      const keys = Object.keys(flat).sort();
      assert.deepEqual(keys, enKeys, `Key mismatch for locale ${loc}`);
      assert.ok(LOCALE_META[loc]?.nativeName, `Missing LOCALE_META for ${loc}`);

      for (const k of enKeys) {
        assert.ok(flat[k] && flat[k]!.trim().length > 0, `Empty translation for ${loc}:${k}`);
        assert.deepEqual(
          placeholders(flat[k]!),
          placeholders(enFlat[k]!),
          `Placeholder mismatch for ${loc}:${k}`,
        );
      }
    }
  });

  it("normalizes canonical and regional BCP-47 locale codes cleanly", () => {
    assert.equal(normalizeLocale("km"), "km");
    assert.equal(normalizeLocale("km-KH"), "km");
    assert.equal(normalizeLocale("en"), "en");
    assert.equal(normalizeLocale("en-US"), "en");
    assert.equal(normalizeLocale("vi"), "vi");
    assert.equal(normalizeLocale("vi-VN"), "vi");
    assert.equal(normalizeLocale("zh"), "zh-CN");
    assert.equal(normalizeLocale("zh-CN"), "zh-CN");
    assert.equal(normalizeLocale("zh_Hans"), "zh-CN");
    assert.equal(normalizeLocale("fr"), "fr");
    assert.equal(normalizeLocale("fr-FR"), "fr");
    assert.equal(normalizeLocale("es"), null);
    assert.equal(normalizeLocale(""), null);
    assert.equal(normalizeLocale(null), null);
    assert.equal(isLocale("vi"), true);
    assert.equal(isLocale("zh-CN"), true);
    assert.equal(isLocale("fr"), true);
    assert.equal(isLocale("de"), false);
  });

  it("falls back to English when a key is missing in target locale, then to the key itself", () => {
    const partial = structuredClone(dictionaries.fr) as unknown as Record<string, Record<string, string>>;
    delete partial.common!.save;
    partial.common!.cancel = "";

    const t = makeT(partial as unknown as Dict, dictionaries.en);
    assert.equal(t("common.save"), dictionaries.en.common.save);
    assert.equal(t("common.cancel"), dictionaries.en.common.cancel);
    assert.equal(t("common.home"), dictionaries.fr.common.home);
    assert.equal(t("nonexistent.key" as TKey), "nonexistent.key");

    const tryT = makeTryT(partial as unknown as Dict, dictionaries.en);
    assert.equal(tryT("nonexistent.key", "Custom Fallback"), "Custom Fallback");
    assert.equal(tryT("common.save", "Fallback"), dictionaries.en.common.save);
  });

  it("interpolates variables accurately across all 5 languages", () => {
    for (const loc of LOCALES) {
      const t = makeT(dictionaries[loc], dictionaries.en);
      const low = t("common.lowStock", { n: 4 });
      assert.ok(low.includes("4"), `Expected interpolated number in ${loc}: ${low}`);
      const posCharge = t("pos.chargeBtn", { amount: "12.50", method: "CASH" });
      assert.ok(posCharge.includes("12.50") && posCharge.includes("CASH"));
    }
  });

  it("localizes categories, payment methods, banners, roles, permissions, reports, and API errors", () => {
    const viT = makeT(dictionaries.vi, dictionaries.en);
    const viTryT = makeTryT(dictionaries.vi, dictionaries.en);
    const zhT = makeT(dictionaries["zh-CN"], dictionaries.en);
    const zhTryT = makeTryT(dictionaries["zh-CN"], dictionaries.en);
    const frT = makeT(dictionaries.fr, dictionaries.en);
    const frTryT = makeTryT(dictionaries.fr, dictionaries.en);
    const kmTryT = makeTryT(dictionaries.km, dictionaries.en);

    // Categories preserve km/en DB values and translate vi/zh-CN/fr
    const cat = { slug: "pain-relief", nameEn: "Pain Relief", nameKm: "ថ្នាំបំបាត់ការឈឺចាប់" };
    assert.equal(localizeCategoryName(cat, "km", kmTryT), "ថ្នាំបំបាត់ការឈឺចាប់");
    assert.equal(localizeCategoryName(cat, "en", makeTryT(dictionaries.en)), "Pain Relief");
    assert.equal(localizeCategoryName(cat, "vi", viTryT), "Giảm đau");
    assert.equal(localizeCategoryName(cat, "zh-CN", zhTryT), "止痛药");
    assert.equal(localizeCategoryName(cat, "fr", frTryT), "Antidouleurs");

    // Payment methods
    const cash = { code: "CASH", nameEn: "Cash (POS)", nameKm: "សាច់ប្រាក់" };
    assert.equal(localizePaymentMethod(cash, "vi", viTryT), "Tiền mặt");
    assert.equal(localizePaymentMethod(cash, "zh-CN", zhTryT), "现金");
    assert.equal(localizePaymentMethod(cash, "fr", frTryT), "Espèces");

    // Seeded banners
    const b = { titleEn: "Vitamins for the Whole Family", titleKm: "វីតាមីនសម្រាប់គ្រួសារទាំងមូល", subtitleEn: "Up to 20% off selected supplements", subtitleKm: "បញ្ចុះតម្លៃ" };
    assert.equal(localizeBanner(b, "vi", viT).title, "Vitamin cho cả gia đình");
    assert.equal(localizeBanner(b, "zh-CN", zhT).title, "全家人的维生素");
    assert.equal(localizeBanner(b, "fr", frT).title, "Des vitamines pour toute la famille");

    // Roles & permissions & report labels
    assert.equal(localizeRoleName("PHARMACIST", "Pharmacist", frTryT), "Pharmacien");
    assert.equal(localizePermissionDesc("pos.use", "Use POS", zhTryT), "使用收银台 POS");
    assert.equal(localizeReportLabel("Gross profit (USD)", viTryT), "Lợi nhuận gộp (USD)");
    assert.equal(localizeReportLabel("Unknown Column", viTryT), "Unknown Column");

    // API error translation
    assert.equal(translateApiError("Invalid discount code", frT), "Code promo invalide");
    assert.equal(translateApiError("Minimum order of $20.00 required for this code", zhT), "使用此优惠码需订单满 $20.00");
    assert.equal(translateApiError("Insufficient stock for Paracetamol: requested 5, available 2", viT), "Không đủ hàng cho Paracetamol: yêu cầu 5, còn 2");
  });

  it("generates localized accessible captcha prompts for all 5 languages", () => {
    for (const loc of LOCALES) {
      const cap = generateAccessibleCaptcha(loc);
      assert.ok(cap.prompt.length > 5, `Empty captcha prompt for ${loc}`);
      assert.match(cap.answer, /^\d+$/, `Numeric answer expected for ${loc}`);
    }
    assert.ok(generateAccessibleCaptcha("vi").prompt.includes("bằng bao nhiêu"));
    assert.ok(generateAccessibleCaptcha("zh-CN").prompt.includes("等于多少"));
    assert.ok(generateAccessibleCaptcha("fr").prompt.includes("Combien font"));
  });

  it("accepts all 5 canonical locales in profileSchema and rejects invalid ones", () => {
    for (const loc of LOCALES) {
      const res = profileSchema.safeParse({ name: "Test User", phone: "012 345 678", locale: loc });
      assert.equal(res.success, true, `profileSchema should accept ${loc}`);
    }
    const bad = profileSchema.safeParse({ name: "Test User", phone: "012 345 678", locale: "es" });
    assert.equal(bad.success, false, "profileSchema should reject unsupported locale");
  });
});
