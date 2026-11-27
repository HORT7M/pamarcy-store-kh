import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getT } from "@/lib/i18n/server";
import { getCurrentUser } from "@/lib/auth/session";
import { PasswordResetForm } from "@/components/auth/password-reset-form";

export async function generateMetadata() {
  const { t } = await getT();
  return { title: t("meta.forgotPassword") };
}

export default async function Page() {
  const user = await getCurrentUser();
  if (user) redirect(user.isStaff ? "/admin" : "/account");
  const { t } = await getT();
  return (
    <div className="mx-auto flex max-w-md flex-col px-4 py-12">
      <div className="rounded-3xl border bg-white p-8 shadow-sm">
        <h1 className="mb-4 text-center text-2xl font-bold">{t("auth.forgotTitle")}</h1>
        <Suspense><PasswordResetForm mode="request" /></Suspense>
      </div>
    </div>
  );
}
