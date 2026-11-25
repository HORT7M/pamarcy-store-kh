"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { CheckCircle2, Clock, Eye, EyeOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/components/providers/i18n-provider";
import { BotProtectionWidget, HoneypotField, useBotProtection } from "@/components/security/bot-protection";
import { api, FetchError } from "@/lib/fetcher";

function formatCountdown(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function PasswordResetForm({ mode }: { mode: "request" | "confirm" }) {
  const { t } = useI18n();
  const router = useRouter();
  const sp = useSearchParams();
  const token = sp.get("token")?.trim() ?? "";

  const [identifier, setIdentifier] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  const bot = useBotProtection(mode === "request" ? "password_reset" : "password_reset_confirm", { autoLoad: false });

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown((c) => (c <= 1 ? 0 : c - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  async function submitRequest(ev: React.FormEvent) {
    ev.preventDefault();
    if (cooldown > 0) return;
    if (identifier.trim().length < 3) {
      toast.error(t("common.required"));
      return;
    }
    if (bot.visible && !bot.ready) {
      toast.error(t("security.required"));
      return;
    }
    setLoading(true);
    try {
      await api("/api/auth/password-reset/request", {
        method: "POST",
        body: { identifier: identifier.trim(), _bot: bot.getPayload() },
      });
      setDone(true);
      setCooldown(60);
      toast.success(t("auth.resetSent"));
    } catch (e) {
      const fe = e as FetchError;
      if (fe.status === 429 && fe.retryAfter && fe.retryAfter > 0) {
        setCooldown(Math.ceil(fe.retryAfter));
      }
      bot.handleError(fe, identifier.trim());
      toast.error(fe.message);
    } finally {
      setLoading(false);
    }
  }

  async function submitConfirm(ev: React.FormEvent) {
    ev.preventDefault();
    if (cooldown > 0) return;
    if (!token) {
      toast.error(t("auth.invalidResetLink"));
      return;
    }
    if (newPassword !== confirm) {
      toast.error("Passwords do not match");
      return;
    }
    if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
      toast.error(t("auth.passwordHint"));
      return;
    }
    if (bot.visible && !bot.ready) {
      toast.error(t("security.required"));
      return;
    }
    setLoading(true);
    try {
      await api("/api/auth/password-reset/confirm", {
        method: "POST",
        body: { token, newPassword, _bot: bot.getPayload() },
      });
      setDone(true);
      toast.success(t("auth.resetSuccess"));
      router.push("/login");
    } catch (e) {
      const fe = e as FetchError;
      if (fe.status === 429 && fe.retryAfter && fe.retryAfter > 0) {
        setCooldown(Math.ceil(fe.retryAfter));
      }
      bot.handleError(fe);
      toast.error(fe.message);
    } finally {
      setLoading(false);
    }
  }

  if (mode === "confirm" && !token) {
    return (
      <div className="space-y-4 text-center">
        <p className="text-sm text-muted-foreground">{t("auth.invalidResetLink")}</p>
        <Link href="/forgot-password" className="inline-block text-sm font-medium text-primary hover:underline">
          {t("auth.forgotTitle")}
        </Link>
      </div>
    );
  }

  if (mode === "request") {
    return (
      <form onSubmit={submitRequest} className="space-y-4" noValidate>
        <HoneypotField value={bot.hp} onChange={bot.setHp} />
        <p className="text-sm text-muted-foreground">{t("auth.forgotSubtitle")}</p>
        {done && (
          <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            <span>{t("auth.resetSent")}</span>
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="identifier">{t("auth.emailOrPhone")}</Label>
          <Input
            id="identifier"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            autoComplete="username"
          />
        </div>
        <BotProtectionWidget bot={bot} />
        {cooldown > 0 && (
          <div role="alert" className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <Clock className="size-4 shrink-0" />
            <span>{t("auth.cooldownWait", { time: formatCountdown(cooldown) })}</span>
          </div>
        )}
        <Button type="submit" className="w-full rounded-full" size="lg" disabled={loading || cooldown > 0 || (bot.visible && bot.solving)}>
          {loading && <Loader2 className="animate-spin" />}
          {cooldown > 0 ? formatCountdown(cooldown) : t("auth.sendResetLink")}
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          <Link href="/login" className="font-medium text-primary hover:underline">
            {t("auth.backToLogin")}
          </Link>
        </p>
      </form>
    );
  }

  return (
    <form onSubmit={submitConfirm} className="space-y-4" noValidate>
      <HoneypotField value={bot.hp} onChange={bot.setHp} />
      <div className="space-y-1.5">
        <Label htmlFor="newPassword">{t("account.newPassword")}</Label>
        <div className="relative">
          <Input
            id="newPassword"
            type={show ? "text" : "password"}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            className="pr-10"
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="absolute right-2.5 top-2 text-muted-foreground"
            aria-label="toggle password"
          >
            {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
        <p className="text-xs text-muted-foreground">{t("auth.passwordHint")}</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="confirmPassword">{t("account.confirmPassword")}</Label>
        <Input
          id="confirmPassword"
          type={show ? "text" : "password"}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
        />
      </div>
      <BotProtectionWidget bot={bot} />
      {cooldown > 0 && (
        <div role="alert" className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <Clock className="size-4 shrink-0" />
          <span>{t("auth.cooldownWait", { time: formatCountdown(cooldown) })}</span>
        </div>
      )}
      <Button type="submit" className="w-full rounded-full" size="lg" disabled={loading || cooldown > 0 || done || (bot.visible && bot.solving)}>
        {loading && <Loader2 className="animate-spin" />}
        {cooldown > 0 ? formatCountdown(cooldown) : t("auth.resetSubmit")}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        <Link href="/login" className="font-medium text-primary hover:underline">
          {t("auth.backToLogin")}
        </Link>
      </p>
    </form>
  );
}
