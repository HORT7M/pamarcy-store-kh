"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Loader2, Eye, EyeOff, Clock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/components/providers/i18n-provider";
import { BotProtectionWidget, HoneypotField, useBotProtection } from "@/components/security/bot-protection";
import { api, FetchError } from "@/lib/fetcher";
import { isKhPhone } from "@/lib/phone";
import { safeInternalPath } from "@/lib/sanitize";

function safeNext(n: string | null, fallback: string) {
  return safeInternalPath(n, fallback);
}

function formatCountdown(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function AuthForm({ mode, scope = "customer" }: { mode: "login" | "register"; scope?: "customer" | "admin" }) {
  const { t, tError } = useI18n();
  const router = useRouter();
  const sp = useSearchParams();
  const [form, setForm] = useState({ name: "", email: "", phone: "", identifier: "", password: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [show, setShow] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const botAction = mode === "register" ? "register" : scope === "admin" ? "admin_login" : "login";
  const bot = useBotProtection(botAction, { autoLoad: mode === "register" });
  const validatedNext = safeInternalPath(sp.get("next"));

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown((c) => (c <= 1 ? 0 : c - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  function validate() {
    const e: Record<string, string> = {};
    if (mode === "register") {
      if (form.name.trim().length < 2) e.name = t("common.required");
      if (!/^\S+@\S+\.\S+$/.test(form.email)) e.email = t("common.invalidEmail");
      if (!isKhPhone(form.phone)) e.phone = t("checkout.invalidPhone");
      if (form.password.length < 8 || !/[A-Za-z]/.test(form.password) || !/\d/.test(form.password)) e.password = t("auth.passwordHint");
    } else {
      if (form.identifier.trim().length < 3) e.identifier = t("common.required");
      if (!form.password) e.password = t("common.required");
    }
    if (bot.visible && !bot.ready) {
      e.bot = t("security.required");
    }
    setErrors(e);
    return !Object.keys(e).length;
  }

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (cooldown > 0 || !validate()) return;
    setLoading(true);
    try {
      const _bot = bot.getPayload();
      if (mode === "register") {
        await api("/api/auth/register", {
          method: "POST",
          body: { name: form.name, email: form.email, phone: form.phone, password: form.password, _bot },
        });
        toast.success(t("common.success"));
        router.replace(safeNext(sp.get("next"), "/account"));
        router.refresh();
      } else {
        const r = await api<{ user: { isStaff: boolean } }>("/api/auth/login", {
          method: "POST",
          body: { identifier: form.identifier, password: form.password, scope, _bot },
        });
        const target = safeNext(sp.get("next"), r.user.isStaff ? "/admin" : "/account");
        router.replace(target);
        if (scope !== "admin" || !target.startsWith("/admin")) {
          router.refresh();
        }
      }
    } catch (e) {
      const fe = e as FetchError;
      if (fe.status === 429 && fe.retryAfter && fe.retryAfter > 0) {
        setCooldown(Math.ceil(fe.retryAfter));
      }
      bot.handleError(fe, mode === "register" ? form.email : form.identifier);
      toast.error(tError(fe.message));
      setLoading(false);
    }
  }

  const f = (k: string, label: string, input: React.ReactNode) => (
    <div className="space-y-1.5"><Label htmlFor={k}>{label}</Label>{input}{errors[k] && <p className="text-xs text-red-600">{errors[k]}</p>}</div>
  );

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <HoneypotField value={bot.hp} onChange={bot.setHp} />
      {mode === "register" && <>
        {f("name", t("checkout.fullName"), <Input id="name" maxLength={100} value={form.name} onChange={set("name")} autoComplete="name" aria-invalid={!!errors.name} />)}
        {f("email", t("common.email"), <Input id="email" type="email" maxLength={254} value={form.email} onChange={set("email")} autoComplete="email" aria-invalid={!!errors.email} />)}
        {f("phone", t("checkout.phone"), <Input id="phone" type="tel" maxLength={25} placeholder="012 345 678" value={form.phone} onChange={set("phone")} autoComplete="tel" aria-invalid={!!errors.phone} />)}
      </>}
      {mode === "login" && f("identifier", t("auth.emailOrPhone"), <Input id="identifier" maxLength={200} value={form.identifier} onChange={set("identifier")} autoComplete="username" aria-invalid={!!errors.identifier} />)}
      {f("password", t("auth.password"), (
        <div className="relative">
          <Input id="password" type={show ? "text" : "password"} maxLength={128} value={form.password} onChange={set("password")} autoComplete={mode === "login" ? "current-password" : "new-password"} aria-invalid={!!errors.password} className="pr-10" />
          <button type="button" onClick={() => setShow((s) => !s)} className="absolute right-2.5 top-2 text-muted-foreground" aria-label={t("auth.togglePassword")}>{show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button>
        </div>
      ))}
      {mode === "login" && scope === "customer" && (
        <div className="flex justify-end">
          <Link href="/forgot-password" className="text-xs font-medium text-primary hover:underline">
            {t("auth.forgotPassword")}
          </Link>
        </div>
      )}
      {mode === "register" && <p className="text-xs text-muted-foreground">{t("auth.passwordHint")}</p>}
      <BotProtectionWidget bot={bot} />
      {errors.bot && <p className="text-xs text-red-600">{errors.bot}</p>}
      {cooldown > 0 && (
        <div role="alert" className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <Clock className="size-4 shrink-0" />
          <span>{t("auth.cooldownWait", { time: formatCountdown(cooldown) })}</span>
        </div>
      )}
      <Button type="submit" className="w-full rounded-full" size="lg" disabled={loading || cooldown > 0 || (bot.visible && bot.solving)}>
        {loading && <Loader2 className="animate-spin" />}
        {cooldown > 0 ? formatCountdown(cooldown) : mode === "login" ? t("common.login") : t("common.register")}
      </Button>
      {scope === "customer" && (
        <p className="text-center text-sm text-muted-foreground">
          {mode === "login" ? <>{t("auth.noAccount")} <Link href={`/register${validatedNext ? `?next=${encodeURIComponent(validatedNext)}` : ""}`} className="font-medium text-primary hover:underline">{t("common.register")}</Link></> : <>{t("auth.haveAccount")} <Link href="/login" className="font-medium text-primary hover:underline">{t("common.login")}</Link></>}
        </p>
      )}
    </form>
  );
}
