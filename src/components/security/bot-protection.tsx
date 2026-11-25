"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ShieldCheck, RotateCw, Loader2, Volume2, Accessibility, Eye } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/providers/i18n-provider";
import { api } from "@/lib/fetcher";
import {
  normalizeDigits,
  parseBotChallengeError,
  solveBrowserPow,
  type ChallengeResponse,
  type ClientBotAction,
  type ClientBotPayload,
} from "@/lib/bot-client";

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        opts: {
          sitekey: string;
          action?: string;
          theme?: "light" | "dark" | "auto";
          callback: (token: string) => void;
          "expired-callback"?: () => void;
          "error-callback"?: () => void;
        },
      ) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId?: string) => void;
    };
    hcaptcha?: {
      render: (
        el: HTMLElement,
        opts: {
          sitekey: string;
          theme?: "light" | "dark";
          callback: (token: string) => void;
          "expired-callback"?: () => void;
          "error-callback"?: () => void;
        },
      ) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId?: string) => void;
    };
  }
}

const scriptPromises = new Map<string, Promise<void>>();

function loadExternalScript(src: string, timeoutMs = 6000): Promise<void> {
  const existing = scriptPromises.get(src);
  if (existing) return existing;
  const p = new Promise<void>((resolve, reject) => {
    if (typeof document === "undefined") return reject(new Error("No document"));
    const timer = setTimeout(() => {
      scriptPromises.delete(src);
      reject(new Error("Script load timeout"));
    }, timeoutMs);
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.defer = true;
    el.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    el.onerror = () => {
      clearTimeout(timer);
      scriptPromises.delete(src);
      reject(new Error("Script failed to load"));
    };
    document.head.appendChild(el);
  });
  scriptPromises.set(src, p);
  return p;
}

/**
 * Autofill-safe off-screen honeypot trap.
 * Uses non-semantic field naming + explicit password-manager ignore attributes so
 * legitimate autofill tools (Chrome, Safari, 1Password, Bitwarden, LastPass) never touch it.
 */
export function HoneypotField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        left: "-10000px",
        top: "auto",
        width: "1px",
        height: "1px",
        overflow: "hidden",
        pointerEvents: "none",
      }}
    >
      <label htmlFor="pamarcy_verification_aux">Leave this field blank</label>
      <input
        id="pamarcy_verification_aux"
        name="pamarcy_verification_aux"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        tabIndex={-1}
        autoComplete="off"
        data-lpignore="true"
        data-1p-ignore="true"
        data-bwignore="true"
        data-form-type="other"
      />
    </div>
  );
}

export type BotProtectionController = {
  hp: string;
  setHp: (v: string) => void;
  challenge: ChallengeResponse | null;
  loading: boolean;
  solving: boolean;
  ready: boolean;
  visible: boolean;
  answer: string;
  setAnswer: (v: string) => void;
  fallbackUsed: boolean;
  loadChallenge: (opts?: { mode?: "auto" | "interactive" | "accessible"; fallback?: boolean; identifier?: string }) => Promise<ChallengeResponse | null>;
  ensurePayload: () => Promise<ClientBotPayload>;
  getPayload: () => ClientBotPayload;
  appendToFormData: (fd: FormData, payload?: ClientBotPayload) => void;
  handleError: (err: unknown, identifier?: string) => boolean;
  refresh: (mode?: "auto" | "interactive" | "accessible") => Promise<void>;
  externalContainerRef: React.RefObject<HTMLDivElement | null>;
};

export function useBotProtection(
  action: ClientBotAction,
  opts: { autoLoad?: boolean; identifier?: string } = {},
): BotProtectionController {
  const [hp, setHp] = useState("");
  const [challenge, setChallenge] = useState<ChallengeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [solving, setSolving] = useState(false);
  const [powNonce, setPowNonce] = useState<string | null>(null);
  const [externalToken, setExternalToken] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [fallbackUsed, setFallbackUsed] = useState(false);

  const externalContainerRef = useRef<HTMLDivElement | null>(null);
  const externalWidgetIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const latestStateRef = useRef({
    challenge: null as ChallengeResponse | null,
    powNonce: null as string | null,
    externalToken: null as string | null,
    answer: "",
    hp: "",
  });

  latestStateRef.current = { challenge, powNonce, externalToken, answer, hp };

  const loadChallenge = useCallback(
    async (loadOpts: { mode?: "auto" | "interactive" | "accessible"; fallback?: boolean; identifier?: string } = {}) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      setLoading(true);
      setPowNonce(null);
      setExternalToken(null);
      setAnswer("");

      try {
        const sp = new URLSearchParams({ action });
        if (loadOpts.mode) sp.set("mode", loadOpts.mode);
        if (loadOpts.fallback) sp.set("fallback", "1");
        const idVal = loadOpts.identifier ?? opts.identifier;
        if (idVal) sp.set("identifier", idVal);

        const data = await api<ChallengeResponse>(`/api/bot-protection/challenge?${sp.toString()}`);
        if (ctrl.signal.aborted) return null;

        setChallenge(data);
        if (loadOpts.fallback) setFallbackUsed(true);

        if (data.provider === "builtin" && data.required && data.salt && typeof data.difficulty === "number") {
          setSolving(true);
          try {
            const nonce = await solveBrowserPow(data.salt, data.difficulty, ctrl.signal);
            if (!ctrl.signal.aborted) {
              setPowNonce(nonce);
              latestStateRef.current.challenge = data;
              latestStateRef.current.powNonce = nonce;
            }
          } finally {
            if (!ctrl.signal.aborted) setSolving(false);
          }
        }
        return data;
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return null;
        return null;
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    },
    [action, opts.identifier],
  );

  // Auto-load challenge on mount for public forms that always require verification (e.g. register, guest checkout)
  useEffect(() => {
    if (!opts.autoLoad) return;
    void loadChallenge({ mode: "auto" });
    return () => abortRef.current?.abort();
  }, [opts.autoLoad, loadChallenge]);

  // Mount Cloudflare Turnstile or hCaptcha widget when external provider is active & required
  useEffect(() => {
    if (!challenge || !challenge.required || challenge.provider === "builtin") return;
    const el = externalContainerRef.current;
    if (!el) return;

    let cancelled = false;
    const provider = challenge.provider;
    const siteKey = challenge.siteKey;
    const allowFallback = challenge.allowFallback;

    const triggerFallback = () => {
      if (!cancelled && allowFallback) {
        void loadChallenge({ mode: "interactive", fallback: true });
      }
    };

    const mount = async () => {
      try {
        if (provider === "turnstile") {
          await loadExternalScript("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
          if (cancelled || !window.turnstile || !el) return;
          el.replaceChildren();
          externalWidgetIdRef.current = window.turnstile.render(el, {
            sitekey: siteKey,
            action,
            theme: "light",
            callback: (tok) => !cancelled && setExternalToken(tok),
            "expired-callback": () => !cancelled && setExternalToken(null),
            "error-callback": () => triggerFallback(),
          });
        } else if (provider === "hcaptcha") {
          await loadExternalScript("https://js.hcaptcha.com/1/api.js?render=explicit");
          if (cancelled || !window.hcaptcha || !el) return;
          el.replaceChildren();
          externalWidgetIdRef.current = window.hcaptcha.render(el, {
            sitekey: siteKey,
            theme: "light",
            callback: (tok) => !cancelled && setExternalToken(tok),
            "expired-callback": () => !cancelled && setExternalToken(null),
            "error-callback": () => triggerFallback(),
          });
        }
      } catch {
        triggerFallback();
      }
    };

    void mount();

    return () => {
      cancelled = true;
      const wid = externalWidgetIdRef.current;
      externalWidgetIdRef.current = null;
      if (wid) {
        try {
          if (provider === "turnstile") window.turnstile?.remove(wid);
          if (provider === "hcaptcha") window.hcaptcha?.remove(wid);
        } catch {
          /* ignore */
        }
      }
    };
  }, [challenge, action, loadChallenge]);

  const getPayload = useCallback((): ClientBotPayload => {
    const s = latestStateRef.current;
    const base: ClientBotPayload = s.hp ? { hp: s.hp } : {};
    if (!s.challenge || !s.challenge.required) return base;
    if (s.challenge.provider === "builtin") {
      return {
        ...base,
        provider: "builtin",
        token: s.challenge.token,
        nonce: s.powNonce ?? undefined,
        answer: s.challenge.mode === "silent" ? undefined : normalizeDigits(s.answer).trim(),
      };
    }
    return {
      ...base,
      provider: s.challenge.provider,
      token: s.externalToken ?? undefined,
    };
  }, []);

  /** Ensure a silent token is fetched & solved on demand (used for seamless guest Rx upload). */
  const ensurePayload = useCallback(async (): Promise<ClientBotPayload> => {
    const s = latestStateRef.current;
    if (s.challenge && s.challenge.required) {
      if (s.challenge.provider === "builtin") {
        const expired = s.challenge.expiresAt && s.challenge.expiresAt <= Date.now() + 5000;
        if (!expired && s.powNonce) return getPayload();
      } else if (s.externalToken) {
        return getPayload();
      }
    }
    const fresh = await loadChallenge({ mode: "auto" });
    if (!fresh || !fresh.required) return getPayload();
    return getPayload();
  }, [getPayload, loadChallenge]);

  const appendToFormData = useCallback(
    (fd: FormData, explicit?: ClientBotPayload) => {
      const p = explicit ?? getPayload();
      if (p.provider) fd.set("_botProvider", p.provider);
      if (p.token) fd.set("_botToken", p.token);
      if (p.nonce) fd.set("_botNonce", p.nonce);
      if (p.answer) fd.set("_botAnswer", p.answer);
      if (p.hp) fd.set("_hp", p.hp);
    },
    [getPayload],
  );

  const refresh = useCallback(
    async (mode?: "auto" | "interactive" | "accessible") => {
      const currentMode: "auto" | "interactive" | "accessible" =
        mode ??
        (challenge?.provider === "builtin" && challenge.mode === "accessible"
          ? "accessible"
          : challenge?.provider === "builtin" && challenge.mode === "interactive"
            ? "interactive"
            : "auto");
      await loadChallenge({ mode: currentMode, fallback: fallbackUsed });
    },
    [challenge, fallbackUsed, loadChallenge],
  );

  const handleError = useCallback(
    (err: unknown, identifier?: string): boolean => {
      const sig = parseBotChallengeError(err);
      if (sig.required) {
        const nextMode: "auto" | "interactive" | "accessible" =
          sig.mode === "accessible" ? "accessible" : sig.mode === "interactive" ? "interactive" : "auto";
        void loadChallenge({ mode: nextMode, fallback: fallbackUsed, identifier });
        return true;
      }
      // If a single-use token was already attached and consumed on a non-bot failure, silently refresh for next submit
      if (challenge?.required) {
        if (challenge.provider === "builtin") {
          void loadChallenge({
            mode: challenge.mode === "silent" ? "auto" : challenge.mode,
            fallback: fallbackUsed,
            identifier,
          });
        } else if (externalWidgetIdRef.current) {
          setExternalToken(null);
          try {
            if (challenge.provider === "turnstile") window.turnstile?.reset(externalWidgetIdRef.current);
            if (challenge.provider === "hcaptcha") window.hcaptcha?.reset(externalWidgetIdRef.current);
          } catch {
            /* ignore */
          }
        }
      }
      return false;
    },
    [challenge, fallbackUsed, loadChallenge],
  );

  const visible = Boolean(challenge?.required);
  const ready =
    !visible ||
    (challenge?.provider === "builtin"
      ? Boolean(
          powNonce &&
            (challenge.mode === "silent" || normalizeDigits(answer).trim().length > 0),
        )
      : Boolean(externalToken));

  return {
    hp,
    setHp,
    challenge,
    loading,
    solving,
    ready,
    visible,
    answer,
    setAnswer,
    fallbackUsed,
    loadChallenge,
    ensurePayload,
    getPayload,
    appendToFormData,
    handleError,
    refresh,
    externalContainerRef,
  };
}

/**
 * Friction-minimized human verification UI widget.
 * - Hidden completely when risk is low and verification is not required.
 * - Shows a compact non-intrusive badge for invisible PoW checks.
 * - Displays an accessible, bilingual SVG math / text challenge or Turnstile/hCaptcha when needed.
 */
export function BotProtectionWidget({ bot, compact }: { bot: BotProtectionController; compact?: boolean }) {
  const { t, bcp47 } = useI18n();
  const { challenge, loading, solving, ready, visible, answer, setAnswer, fallbackUsed, refresh, externalContainerRef } = bot;

  if (!visible && !loading) return null;

  const speakPrompt = (text: string) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = bcp47;
      window.speechSynthesis.speak(utter);
    } catch {
      /* speechSynthesis optional */
    }
  };

  if (loading && !challenge) {
    return (
      <div className="flex items-center gap-2 rounded-xl border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin text-primary" />
        <span>{t("security.verifying")}</span>
      </div>
    );
  }

  if (!challenge || !challenge.required) return null;

  // External Turnstile / hCaptcha managed container
  if (challenge.provider !== "builtin") {
    return (
      <div className="space-y-2 rounded-xl border bg-muted/20 p-3">
        <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <ShieldCheck className="size-3.5 text-primary" />
            {t("security.title")}
          </span>
        </div>
        <div ref={externalContainerRef} className="min-h-[65px]" />
      </div>
    );
  }

  // Built-in silent mode: invisible PoW (zero clicks for legitimate users)
  if (challenge.mode === "silent") {
    return (
      <div className="flex items-center justify-between gap-2 rounded-xl border border-emerald-200/70 bg-emerald-50/50 px-3 py-2 text-xs text-emerald-900">
        <span className="flex items-center gap-1.5">
          {solving ? <Loader2 className="size-3.5 animate-spin text-primary" /> : <ShieldCheck className="size-3.5 text-primary" />}
          <span>{solving ? t("security.verifying") : t("security.verified")}</span>
        </span>
        {ready && <span className="text-[10px] font-medium text-emerald-700">✓</span>}
      </div>
    );
  }

  // Built-in interactive (vector SVG math) or accessible (localized word math) mode
  const isAccessible = challenge.mode === "accessible";
  const safeCaptchaDataUri =
    typeof challenge.imageDataUri === "string" &&
    /^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/.test(challenge.imageDataUri)
      ? challenge.imageDataUri
      : null;
  return (
    <div className={compact ? "space-y-2 rounded-xl border border-primary/25 bg-secondary/40 p-3" : "space-y-3 rounded-2xl border border-primary/25 bg-secondary/40 p-4"}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <ShieldCheck className="size-4 text-primary" />
          <span>{t("security.title")}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={() => void refresh(isAccessible ? "interactive" : "accessible")}
            disabled={loading}
            title={isAccessible ? t("security.visual") : t("security.accessible")}
          >
            {isAccessible ? <Eye className="mr-1 size-3.5" /> : <Accessibility className="mr-1 size-3.5" />}
            <span>{isAccessible ? t("security.visual") : t("security.accessible")}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={() => void refresh(isAccessible ? "accessible" : "interactive")}
            disabled={loading}
            aria-label={t("security.refresh")}
          >
            <RotateCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {fallbackUsed && <p className="text-[11px] text-muted-foreground">{t("security.fallbackNotice")}</p>}

      {isAccessible && challenge.prompt ? (
        <div className="flex items-center justify-between gap-2 rounded-xl border bg-white px-3 py-2.5 text-sm font-medium text-foreground">
          <span>{challenge.prompt}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 shrink-0 px-2 text-xs"
            onClick={() => speakPrompt(challenge.prompt!)}
            aria-label={t("security.listen")}
          >
            <Volume2 className="size-3.5" />
          </Button>
        </div>
      ) : (
        safeCaptchaDataUri && (
          <div className="flex items-center justify-center rounded-xl border bg-white p-1.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={safeCaptchaDataUri}
              alt={t("security.captchaAlt")}
              width={220}
              height={64}
              className="h-14 w-auto select-none"
              draggable={false}
            />
          </div>
        )
      )}

      <div className="flex items-center gap-2">
        <Input
          type="text"
          inputMode="numeric"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder={t("security.answerPlaceholder")}
          aria-label={t("security.solvePrompt")}
          autoComplete="off"
          maxLength={8}
          className="bg-white text-center font-mono text-base tracking-wider"
        />
      </div>
      <p className="text-[11px] text-muted-foreground">
        {solving ? t("security.verifying") : t("security.solvePrompt")}
      </p>
    </div>
  );
}
