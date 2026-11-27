import type { Metadata, Viewport } from "next";
import "@fontsource-variable/inter";
import "@fontsource/noto-sans-khmer/400.css";
import "@fontsource/noto-sans-khmer/500.css";
import "@fontsource/noto-sans-khmer/600.css";
import "@fontsource/noto-sans-khmer/700.css";
import "./globals.css";
import { Toaster } from "sonner";
import { getCurrency, getLocale, getT } from "@/lib/i18n/server";
import { getSettings } from "@/lib/settings";
import { I18nProvider } from "@/components/providers/i18n-provider";
import { CartProvider } from "@/components/providers/cart-provider";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return {
    title: { default: t("meta.defaultTitle"), template: `%s · ${t("common.appName")}` },
    description: t("meta.defaultDescription"),
    icons: { icon: "/logo-mark.svg" },
  };
}

export const viewport: Viewport = { themeColor: "#0f9d58", width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [locale, currency, settings] = await Promise.all([getLocale(), getCurrency(), getSettings()]);
  return (
    <html lang={locale} suppressHydrationWarning>
      <body style={{ ["--font-inter" as string]: "'Inter Variable'", ["--font-khmer" as string]: "'Noto Sans Khmer'" }}>
        <I18nProvider locale={locale} currency={currency} rate={settings.exchangeRate}>
          <CartProvider>{children}</CartProvider>
        </I18nProvider>
        <Toaster position="top-center" richColors closeButton />
      </body>
    </html>
  );
}
