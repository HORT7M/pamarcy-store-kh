import "server-only";

if (typeof window !== "undefined") {
  throw new Error("Security violation: src/lib/env.ts must never be imported in browser code.");
}

const INSECURE_PLACEHOLDERS = new Set([
  "dev",
  "secret",
  "changeme",
  "change-me",
  "change-me-to-a-long-random-string-at-least-32-chars",
]);

export const SECRET_ENV_NAMES = [
  "DATABASE_URL",
  "AUTH_SECRET",
  "CRON_SECRET",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
  "BAKONG_API_TOKEN",
  "TRONGRID_API_KEY",
  "ETHEREUM_RPC_URL",
  "BSC_RPC_URL",
  "POLYGON_RPC_URL",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_WEBHOOK_ID",
  "SMTP_USER",
  "SMTP_PASS",
  "TURNSTILE_SECRET_KEY",
  "HCAPTCHA_SECRET_KEY",
  "SEED_SUPERADMIN_PASSWORD",
  "SEED_STAFF_PASSWORD",
  "SEED_CUSTOMER_PASSWORD",
  "PG_PASSWORD",
] as const;

/** Fail fast if any sensitive secret is accidentally configured with a NEXT_PUBLIC_ prefix. */
export function assertNoPublicSecrets(envObj: NodeJS.ProcessEnv = process.env): void {
  for (const key of SECRET_ENV_NAMES) {
    const pubKey = `NEXT_PUBLIC_${key}`;
    if (envObj[pubKey]?.trim()) {
      throw new Error(`Security violation: "${pubKey}" must not be set. Keep "${key}" server-only without NEXT_PUBLIC_.`);
    }
  }
}

assertNoPublicSecrets();

/** Validated secret for session token hashing and HMAC guest order access tokens. Never falls back to a hardcoded default. */
export function getAuthSecret(): string {
  const secret = process.env.AUTH_SECRET?.trim() ?? "";
  if (!secret || secret.length < 32 || INSECURE_PLACEHOLDERS.has(secret.toLowerCase())) {
    throw new Error(
      "AUTH_SECRET environment variable must be set to a random string of at least 32 characters in .env (e.g. `openssl rand -hex 32`).",
    );
  }
  return secret;
}

/** Validated secret for authenticating /api/cron/* requests. Returns null when unset or placeholder. */
export function getCronSecret(): string | null {
  const secret = process.env.CRON_SECRET?.trim() ?? "";
  if (!secret || secret.length < 16 || INSECURE_PLACEHOLDERS.has(secret.toLowerCase())) {
    return null;
  }
  return secret;
}

export const serverEnv = {
  get nodeEnv() {
    return process.env.NODE_ENV ?? "development";
  },
  get isProduction() {
    return process.env.NODE_ENV === "production";
  },
  get appUrl() {
    return process.env.APP_URL?.trim() || "http://localhost:3000";
  },
  get allowLocalUploads() {
    const v = process.env.ALLOW_LOCAL_UPLOADS?.trim().toLowerCase();
    return v === "1" || v === "true";
  },
  cloudinary: {
    get cloudName() {
      return process.env.CLOUDINARY_CLOUD_NAME?.trim() || "";
    },
    get apiKey() {
      return process.env.CLOUDINARY_API_KEY?.trim() || "";
    },
    get apiSecret() {
      return process.env.CLOUDINARY_API_SECRET?.trim() || "";
    },
    get configured() {
      return Boolean(this.cloudName && this.apiKey && this.apiSecret);
    },
  },
  bakong: {
    get apiBase() {
      return process.env.BAKONG_API_BASE?.trim() || "https://api-bakong.nbc.gov.kh";
    },
    get apiToken() {
      return process.env.BAKONG_API_TOKEN?.trim() || "";
    },
    get accountId() {
      return process.env.BAKONG_ACCOUNT_ID?.trim() || "";
    },
  },
  trongrid: {
    get apiBase() {
      return process.env.TRONGRID_API_BASE?.trim() || "https://api.trongrid.io";
    },
    get apiKey() {
      return process.env.TRONGRID_API_KEY?.trim() || "";
    },
  },
  evmRpcUrl(envVarName: "ETHEREUM_RPC_URL" | "BSC_RPC_URL" | "POLYGON_RPC_URL"): string {
    return process.env[envVarName]?.trim() || "";
  },
  paypal: {
    get env(): "live" | "sandbox" {
      return process.env.PAYPAL_ENV?.trim() === "live" ? "live" : "sandbox";
    },
    get apiBase() {
      return this.env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
    },
    get clientId() {
      return process.env.PAYPAL_CLIENT_ID?.trim() || "";
    },
    get clientSecret() {
      return process.env.PAYPAL_CLIENT_SECRET?.trim() || "";
    },
    get webhookId() {
      return process.env.PAYPAL_WEBHOOK_ID?.trim() || "";
    },
    get configured() {
      return Boolean(this.clientId && this.clientSecret);
    },
  },
  smtp: {
    get host() {
      return process.env.SMTP_HOST?.trim() || "";
    },
    get port() {
      return Number(process.env.SMTP_PORT || 587);
    },
    get user() {
      return process.env.SMTP_USER?.trim() || "";
    },
    get pass() {
      return process.env.SMTP_PASS ?? "";
    },
    get from() {
      return process.env.SMTP_FROM?.trim() || "Pamarcy Store <no-reply@pamarcy.com.kh>";
    },
    get configured() {
      return Boolean(this.host);
    },
  },
  botProtection: {
    get provider(): "auto" | "builtin" | "turnstile" | "hcaptcha" {
      const v = (process.env.BOT_PROTECTION_PROVIDER ?? "auto").trim().toLowerCase();
      if (v === "builtin" || v === "turnstile" || v === "hcaptcha") return v;
      return "auto";
    },
    get turnstileSiteKey() {
      return process.env.TURNSTILE_SITE_KEY?.trim() || "";
    },
    get turnstileSecretKey() {
      return process.env.TURNSTILE_SECRET_KEY?.trim() || "";
    },
    get turnstileConfigured() {
      return Boolean(this.turnstileSiteKey && this.turnstileSecretKey);
    },
    get hcaptchaSiteKey() {
      return process.env.HCAPTCHA_SITE_KEY?.trim() || "";
    },
    get hcaptchaSecretKey() {
      return process.env.HCAPTCHA_SECRET_KEY?.trim() || "";
    },
    get hcaptchaConfigured() {
      return Boolean(this.hcaptchaSiteKey && this.hcaptchaSecretKey);
    },
    get powDifficulty() {
      const raw = Number(process.env.BOT_PROTECTION_POW_DIFFICULTY);
      return Number.isFinite(raw) && raw >= 8 && raw <= 20 ? Math.floor(raw) : 13;
    },
    get minSubmitMs() {
      const raw = Number(process.env.BOT_PROTECTION_MIN_SUBMIT_MS);
      return Number.isFinite(raw) && raw >= 0 && raw <= 10_000 ? Math.floor(raw) : 800;
    },
    get allowedHostnames(): string[] {
      const raw = process.env.BOT_PROTECTION_ALLOWED_HOSTNAMES?.trim();
      if (!raw) return [];
      return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    },
    get allowBuiltinFallback(): boolean {
      const raw = process.env.BOT_PROTECTION_ALLOW_FALLBACK?.trim().toLowerCase();
      return raw !== "false" && raw !== "0";
    },
  },
} as const;
