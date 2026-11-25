"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Clock, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useI18n } from "@/components/providers/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, FetchError } from "@/lib/fetcher";
import { isKhPhone } from "@/lib/phone";

function formatCountdown(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function ProfileForms({ user }: { user: { name: string; email: string; phone: string | null; locale: string } }) {
  const { t } = useI18n();
  const router = useRouter();
  const [p, setP] = useState({ name: user.name, phone: user.phone ?? "" });
  const [pw, setPw] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [busy, setBusy] = useState<"p" | "pw" | null>(null);
  const [pwCooldown, setPwCooldown] = useState(0);

  useEffect(() => {
    if (pwCooldown <= 0) return;
    const timer = setInterval(() => {
      setPwCooldown((c) => (c <= 1 ? 0 : c - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [pwCooldown]);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    if (p.name.trim().length < 2) return toast.error(t("common.required"));
    if (!isKhPhone(p.phone)) return toast.error(t("checkout.invalidPhone"));
    setBusy("p");
    try {
      await api("/api/account/profile", { method: "PATCH", body: p });
      toast.success(t("common.success"));
      router.refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function savePw(e: React.FormEvent) {
    e.preventDefault();
    if (pwCooldown > 0) return;
    if (pw.newPassword !== pw.confirm) return toast.error("Passwords do not match");
    if (pw.newPassword.length < 8 || !/[A-Za-z]/.test(pw.newPassword) || !/\d/.test(pw.newPassword)) return toast.error(t("auth.passwordHint"));
    setBusy("pw");
    try {
      await api("/api/account/password", { method: "POST", body: { currentPassword: pw.currentPassword, newPassword: pw.newPassword } });
      toast.success(t("common.success"));
      setPw({ currentPassword: "", newPassword: "", confirm: "" });
    } catch (err) {
      const fe = err as FetchError;
      if (fe.status === 429 && fe.retryAfter && fe.retryAfter > 0) {
        setPwCooldown(Math.ceil(fe.retryAfter));
      }
      toast.error(fe.message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <form onSubmit={saveProfile} className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">{t("account.profile")}</h2>
        <div className="space-y-1.5"><Label>{t("common.email")}</Label><Input value={user.email} disabled /></div>
        <div className="space-y-1.5"><Label>{t("checkout.fullName")}</Label><Input maxLength={100} value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} /></div>
        <div className="space-y-1.5"><Label>{t("checkout.phone")}</Label><Input maxLength={25} value={p.phone} onChange={(e) => setP({ ...p, phone: e.target.value })} /></div>
        <Button type="submit" disabled={busy === "p"}>{busy === "p" && <Loader2 className="animate-spin" />}{t("common.save")}</Button>
      </form>
      <form onSubmit={savePw} className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">{t("account.password")}</h2>
        <div className="space-y-1.5"><Label>{t("account.currentPassword")}</Label><Input type="password" autoComplete="current-password" maxLength={128} value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></div>
        <div className="space-y-1.5"><Label>{t("account.newPassword")}</Label><Input type="password" autoComplete="new-password" maxLength={128} value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /><p className="text-xs text-muted-foreground">{t("auth.passwordHint")}</p></div>
        <div className="space-y-1.5"><Label>{t("account.confirmPassword")}</Label><Input type="password" autoComplete="new-password" maxLength={128} value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></div>
        {pwCooldown > 0 && (
          <div role="alert" className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <Clock className="size-4 shrink-0" />
            <span>{t("auth.cooldownWait", { time: formatCountdown(pwCooldown) })}</span>
          </div>
        )}
        <Button type="submit" disabled={busy === "pw" || pwCooldown > 0}>
          {busy === "pw" && <Loader2 className="animate-spin" />}
          {pwCooldown > 0 ? formatCountdown(pwCooldown) : t("common.update")}
        </Button>
      </form>
    </div>
  );
}
