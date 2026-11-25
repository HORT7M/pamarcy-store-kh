import Link from "next/link";
import { MapPin, Phone, Mail, Clock, ShieldCheck } from "lucide-react";
import { Logo } from "@/components/common/logo";
import { getT } from "@/lib/i18n/server";
import { localizeCategoryName } from "@/lib/i18n/translate";
import type { StoreSettings } from "@/lib/settings";
import { formatKhPhone } from "@/lib/phone";
import { safeMailtoHref, safeTelHref } from "@/lib/sanitize";

export async function ShopFooter({ settings, categories }: { settings: StoreSettings; categories: { slug: string; nameEn: string; nameKm: string }[] }) {
  const { t, tryT, locale } = await getT();
  const telHref = safeTelHref(settings.phone);
  const mailHref = safeMailtoHref(settings.email);
  return (
    <footer className="mt-16 border-t bg-[#0b2a1b] text-white/80">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 md:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-4">
          <Logo light />
          <p className="text-sm leading-relaxed">{t("footer.about")}</p>
          <div className="flex items-center gap-2 text-xs"><ShieldCheck className="size-4 text-emerald-400" /> {t("common.licence")}: {settings.licenseNo}</div>
        </div>
        <div>
          <h3 className="mb-4 font-semibold text-white">{t("common.categories")}</h3>
          <ul className="space-y-2 text-sm">
            {categories.slice(0, 7).map((c) => <li key={c.slug}><Link href={`/shop?category=${encodeURIComponent(c.slug)}`} className="hover:text-white">{localizeCategoryName(c, locale, tryT)}</Link></li>)}
          </ul>
        </div>
        <div>
          <h3 className="mb-4 font-semibold text-white">{t("footer.help")}</h3>
          <ul className="space-y-2 text-sm">
            <li><Link href="/account/orders" className="hover:text-white">{t("account.track")}</Link></li>
            <li><Link href="/account" className="hover:text-white">{t("common.account")}</Link></li>
            <li><Link href="/cart" className="hover:text-white">{t("common.cart")}</Link></li>
            <li><Link href="/admin/login" className="hover:text-white">{t("auth.staffLogin")}</Link></li>
          </ul>
        </div>
        <div className="space-y-3 text-sm">
          <h3 className="mb-4 font-semibold text-white">{t("common.contact")}</h3>
          <p className="flex gap-2"><MapPin className="mt-0.5 size-4 shrink-0 text-emerald-400" />{locale === "km" ? settings.addressKm : settings.addressEn}</p>
          <p className="flex gap-2"><Phone className="size-4 shrink-0 text-emerald-400" />{telHref ? <a href={telHref} className="hover:text-white">{formatKhPhone(settings.phone)}</a> : <span>{formatKhPhone(settings.phone)}</span>}</p>
          <p className="flex gap-2"><Mail className="size-4 shrink-0 text-emerald-400" />{mailHref ? <a href={mailHref} className="hover:text-white">{settings.email}</a> : <span>{settings.email}</span>}</p>
          <p className="flex gap-2"><Clock className="size-4 shrink-0 text-emerald-400" />{t("common.openingHours")}: {settings.openingHours}</p>
          <div className="pt-2">
            <div className="mb-2 text-xs uppercase tracking-wide text-white/60">{t("footer.payments")}</div>
            <div className="flex flex-wrap gap-2">
              {["KHQR", "USDT", "PayPal"].map((m) => <span key={m} className="rounded-md bg-white px-2.5 py-1 text-xs font-bold text-[#0b2a1b]">{m}</span>)}
            </div>
          </div>
        </div>
      </div>
      <div className="border-t border-white/10">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-2 px-4 py-4 text-xs text-white/60 sm:flex-row">
          <span>© {new Date().getFullYear()} {locale === "km" ? settings.storeNameKm : settings.storeNameEn}. {t("footer.rights")}</span>
          <Link href="/credits" className="hover:text-white">{t("common.photoCreditsWikimedia")}</Link>
        </div>
      </div>
    </footer>
  );
}
