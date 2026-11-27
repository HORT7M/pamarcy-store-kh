import { Suspense } from "react";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/session";
import { getT } from "@/lib/i18n/server";
import { Logo } from "@/components/common/logo";
import { LocaleSwitcher } from "@/components/common/locale-switcher";
import { AuthForm } from "@/components/auth/auth-form";

export const dynamic = "force-dynamic";
export async function generateMetadata() {
  const { t } = await getT();
  return { title: t("meta.staffSignIn"), robots: { index: false } };
}

export default async function AdminLoginPage() {
  const user = await getCurrentUser();
  if (user?.isStaff) redirect("/admin");
  const { t } = await getT();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-secondary via-white to-accent px-4 py-12">
      <div className="mb-6 flex w-full max-w-md items-center justify-between">
        <Logo subtitle={t("auth.pharmacyAdmin")} />
        <LocaleSwitcher compact />
      </div>
      <div className="w-full max-w-md rounded-3xl border bg-white p-8 shadow-lg">
        <div className="mb-6 flex items-center gap-3">
          <div className="rounded-xl bg-secondary p-2.5 text-primary"><ShieldCheck className="size-6" /></div>
          <div>
            <h1 className="text-xl font-bold">{t("auth.staffLogin")}</h1>
            <p className="text-xs text-muted-foreground">{t("auth.authorizedStaffOnly")}</p>
          </div>
        </div>
        <Suspense><AuthForm mode="login" scope="admin" /></Suspense>
        <div className="mt-6 border-t pt-4 text-center text-xs text-muted-foreground">
          <Link href="/" className="text-primary hover:underline">← {t("auth.backToStorefront")}</Link>
        </div>
      </div>
    </div>
  );
}
