import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_LOCALE,
  dictionaries,
  isLocale,
  LOCALES,
  LOCALE_META,
  LOCALE_NAMESPACE_FILES,
  normalizeLocale,
  type Dict,
} from "../../src/lib/i18n/dictionaries.ts";
import {
  localizeAuditEntity,
  localizeBanner,
  localizeCategoryName,
  localizeCustomerDisplayName,
  localizeNotification,
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
  it("loads all 5 modular locale directories with exact namespace, file, and key parity", () => {
    assert.deepEqual([...LOCALES], ["km", "en", "vi", "zh-CN", "fr"]);
    assert.equal(DEFAULT_LOCALE, "km");

    const listJsonFiles = (dir: string, rel = ""): string[] => {
      const out: string[] = [];
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const nextRel = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) out.push(...listJsonFiles(path.join(dir, ent.name), nextRel));
        else if (ent.name.endsWith(".json")) out.push(nextRel);
      }
      return out.sort();
    };

    const expectedFiles = [...LOCALE_NAMESPACE_FILES].sort();
    const enFlat = flatten(dictionaries.en as unknown as Record<string, unknown>);
    const enKeys = Object.keys(enFlat).sort();
    assert.ok(enKeys.length >= 1150, `Expected comprehensive dictionary, got ${enKeys.length} keys`);

    for (const loc of LOCALES) {
      const localeDir = path.join(process.cwd(), "src/lib/i18n/locales", loc);
      assert.ok(existsSync(localeDir), `Missing locale directory: ${localeDir}`);
      assert.deepEqual(listJsonFiles(localeDir), expectedFiles, `Namespace JSON file mismatch for locale ${loc}`);

      const merged: Record<string, unknown> = {};
      for (const relFile of LOCALE_NAMESPACE_FILES) {
        const enNs = flatten(
          JSON.parse(readFileSync(path.join(process.cwd(), "src/lib/i18n/locales/en", relFile), "utf8")) as Record<string, unknown>,
        );
        const locObj = JSON.parse(readFileSync(path.join(localeDir, relFile), "utf8")) as Record<string, unknown>;
        const locNs = flatten(locObj);
        assert.deepEqual(
          Object.keys(locNs).sort(),
          Object.keys(enNs).sort(),
          `Key mismatch in ${loc}/${relFile}`,
        );
        Object.assign(merged, locObj);
      }

      const flat = flatten(merged);
      const keys = Object.keys(flat).sort();
      assert.deepEqual(keys, enKeys, `Composed key mismatch for locale ${loc}`);
      assert.deepEqual(
        flatten(dictionaries[loc] as unknown as Record<string, unknown>),
        flat,
        `Runtime dictionary mismatch with JSON files for locale ${loc}`,
      );
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

  it("localizes categories, payment methods, banners, roles, permissions, reports, audit entities, and walk-in names", () => {
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

    // Roles, permissions, report labels, audit entities, and walk-in display name
    assert.equal(localizeRoleName("PHARMACIST", "Pharmacist", frTryT), "Pharmacien");
    assert.equal(localizePermissionDesc("pos.use", "Use POS", zhTryT), "使用收银台 POS");
    assert.equal(localizeReportLabel("Gross profit (USD)", viTryT), "Lợi nhuận gộp (USD)");
    assert.equal(localizeReportLabel("Gross sales (incl. delivery)", zhTryT), "销售总额（含配送费）");
    assert.equal(localizeReportLabel("Gross sales (incl. delivery)", frTryT), "Ventes brutes (livraison incluse)");
    assert.equal(localizeReportLabel("Unknown Column", viTryT), "Unknown Column");
    assert.equal(localizeAuditEntity("MedicineBatch", viTryT), "Lô thuốc");
    assert.equal(localizeAuditEntity("Purchase", zhTryT), "采购单");
    assert.equal(localizeAuditEntity("Order", frTryT), "Commande");
    assert.equal(localizeCustomerDisplayName("Walk-in", frT), "Client au comptoir");
    assert.equal(localizeCustomerDisplayName("Walk-in", zhT), "柜台 / 到店顾客");
    assert.equal(localizeCustomerDisplayName("Sokha Chea", frT), "Sokha Chea");
  });

  it("localizes API errors, Zod validation errors, and dynamic error messages across all 5 languages", () => {
    const viT = makeT(dictionaries.vi, dictionaries.en);
    const zhT = makeT(dictionaries["zh-CN"], dictionaries.en);
    const frT = makeT(dictionaries.fr, dictionaries.en);
    const kmT = makeT(dictionaries.km, dictionaries.en);

    assert.equal(translateApiError("Invalid discount code", frT), "Code promo invalide");
    assert.equal(translateApiError("Email is already registered", viT), "Email đã được đăng ký");
    assert.equal(translateApiError("A prescription image is required for prescription-only medicines", zhT), "处方药需上传处方图片");
    assert.equal(translateApiError("Prescription-only medicines must be dispensed by a pharmacist", frT), "Les médicaments sur ordonnance doivent être délivrés par un pharmacien");
    assert.equal(translateApiError("Enter a valid Cambodian phone number (+855)", viT), dictionaries.vi.checkout.invalidPhone);
    assert.equal(translateApiError("Current password is incorrect", kmT), "ពាក្យសម្ងាត់បច្ចុប្បន្នមិនត្រឹមត្រូវ");
    assert.equal(translateApiError("Minimum order of $20.00 required for this code", zhT), "使用此优惠码需订单满 $20.00");
    assert.equal(translateApiError("Insufficient stock for Paracetamol: requested 5, available 2", viT), "Không đủ hàng cho Paracetamol: yêu cầu 5, còn 2");
    assert.equal(translateApiError("Category has 3 medicine(s). Move them to another category first.", frT), "Cette catégorie contient 3 médicament(s). Déplacez-les d'abord vers une autre catégorie.");
    assert.equal(translateApiError("Cannot reduce below reserved quantity (4 units are reserved for orders)", zhT), "不能低于已预留数量（当前有 4 件被订单预留）");
  });

  it("localizes system and customer notifications cleanly across all 5 languages", () => {
    const samples = [
      { title: "New order PM-20261125-0001", message: "Sokha · $12.50" },
      { title: "Prescription review needed – PM-20261125-0002", message: "An order with prescription-only medicines is waiting for pharmacist review." },
      { title: "Order PM-20261125-0003", message: "Status: ready for delivery" },
      { title: "Payment received – PM-20261125-0004", message: "Thank you! Your order is confirmed." },
      { title: "Expired: Paracetamol 500mg", message: "Batch B2600B (100 units) expired on 12/11/2026. It is blocked from sale – write it off." },
      { title: "Low stock: Ibuprofen 400mg", message: "PR-IBU-400 has 3 units available (minimum 10)." },
      { title: "New customer registered", message: "Dara (+85512345678)" },
    ];
    for (const loc of ["km", "vi", "zh-CN", "fr"] as const) {
      const t = makeT(dictionaries[loc], dictionaries.en);
      const tryT = makeTryT(dictionaries[loc], dictionaries.en);
      for (const s of samples) {
        const res = localizeNotification(s, t, tryT);
        assert.notEqual(res.title, s.title, `Expected translated notification title for ${loc}: ${s.title}`);
      }
      const statusRes = localizeNotification(samples[2]!, t, tryT);
      assert.ok(!statusRes.message.startsWith("Status:"), `Expected localized order status message for ${loc}: ${statusRes.message}`);
      const expRes = localizeNotification(samples[4]!, t, tryT);
      assert.ok(expRes.message.includes("B2600B") && expRes.message.includes("100"), `Expected batch info preserved for ${loc}: ${expRes.message}`);
    }
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
