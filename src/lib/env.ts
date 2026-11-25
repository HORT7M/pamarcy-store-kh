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
  "DIRECT_URL",
  "SHADOW_DATABASE_URL",
  "MIGRATION_DATABASE_URL",
  "DATABASE_ADMIN_URL",
  "PRISMA_DATABASE_URL",
  "PRISMA_ACCELERATE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SERVICE_ROLE_KEY",
  "AUTH_SECRET",
  "CRON_SECRET",
  "DATA_ENCRYPTION_KEY",
  "DATA_ENCRYPTION_KEYRING",
  "BACKUP_ENCRYPTION_KEY",
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
  "PG_USER",
  "PG_PASSWORD",
  "PG_APP_USER",
  "PG_APP_PASSWORD",
] as const;

/**
 * Explicit allowlist of non-secret public/anonymous client variables permitted with NEXT_PUBLIC_.
 * Even allowlisted keys are value-inspected to prevent pasting service-role tokens or DB URLs.
 */
export const ALLOWED_PUBLIC_ENV_NAMES = new Set<string>([
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
  "NEXT_PUBLIC_HCAPTCHA_SITE_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_PAYPAL_CLIENT_ID",
]);

const FORBIDDEN_PUBLIC_NAME_RE =
  /(?:SERVICE_ROLE|DATABASE|DIRECT_URL|SHADOW_DATABASE|POSTGRES|PG_PASS|PG_USER|PG_APP|PRIVATE_KEY|SECRET|PASSWORD|PASSWD|ENCRYPTION_KEY|MASTER_KEY|ADMIN_KEY|ADMIN_TOKEN|API_TOKEN|AUTH_TOKEN|WEBHOOK_SECRET|WEBHOOK_ID|SMTP_PASS|ACCESS_KEY|CREDENTIAL)/i;

const DB_CONNECTION_URI_RE = /^(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|sqlserver):\/\//i;
const PEM_PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const SUPABASE_SECRET_KEY_RE = /^sb_secret_[A-Za-z0-9_-]+/;
const JWT_SHAPE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const PRIVILEGED_JWT_ROLES = new Set(["service_role", "supabase_admin", "postgres", "admin", "superuser"]);

function inspectPublicValueForPrivilegedSecrets(pubKey: string, rawValue: string): void {
  const val = rawValue.trim();
  if (!val) return;
  if (DB_CONNECTION_URI_RE.test(val)) {
    throw new Error(`Security violation: "${pubKey}" contains a database connection URI and must never be exposed to frontend code.`);
  }
  if (PEM_PRIVATE_KEY_RE.test(val)) {
    throw new Error(`Security violation: "${pubKey}" contains a private key and must never be exposed to frontend code.`);
  }
  if (SUPABASE_SECRET_KEY_RE.test(val)) {
    throw new Error(`Security violation: "${pubKey}" contains a privileged secret key (sb_secret_*) and must never be exposed to frontend code.`);
  }
  if (JWT_SHAPE_RE.test(val)) {
    try {
      const payloadB64 = val.split(".")[1]!;
      const json = Buffer.from(payloadB64, "base64url").toString("utf8");
      const payload = JSON.parse(json) as { role?: unknown };
      if (typeof payload.role === "string" && PRIVILEGED_JWT_ROLES.has(payload.role.toLowerCase())) {
        throw new Error(
          `Security violation: "${pubKey}" contains a privileged "${payload.role}" JWT token. Only anonymous/public keys may be exposed to frontend code.`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Security violation:")) throw err;
    }
  }
}

/** Fail fast if any sensitive secret, service-role key, or database credential is exposed via NEXT_PUBLIC_. */
export function assertNoPublicSecrets(envObj: NodeJS.ProcessEnv = process.env): void {
  for (const key of SECRET_ENV_NAMES) {
    const pubKey = `NEXT_PUBLIC_${key}`;
    if (envObj[pubKey]?.trim()) {
      throw new Error(`Security violation: "${pubKey}" must not be set. Keep "${key}" server-only without NEXT_PUBLIC_.`);
    }
  }

  for (const [key, value] of Object.entries(envObj)) {
    if (!key.startsWith("NEXT_PUBLIC_")) continue;
    if (!value || !value.trim()) continue;
    inspectPublicValueForPrivilegedSecrets(key, value);
    if (!ALLOWED_PUBLIC_ENV_NAMES.has(key) && FORBIDDEN_PUBLIC_NAME_RE.test(key)) {
      throw new Error(
        `Security violation: "${key}" matches a restricted credential pattern and must not use the NEXT_PUBLIC_ prefix.`,
      );
    }
  }
}

assertNoPublicSecrets();

/** Returns true if a hostname refers strictly to the local loopback interface. */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/**
 * Enforce TLS (HTTPS) on outbound sensitive service URLs (payment gateways, blockchain RPCs,
 * webhooks, and production APP_URL). Never includes URL query/path secrets in error messages.
 */
export function assertSecureHttpsUrl(
  rawUrl: string,
  label: string,
  opts: { allowHttpLocalhost?: boolean } = {},
): string {
  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Security configuration error: ${label} is not a valid URL.`);
  }
  if (parsed.protocol === "https:") {
    return trimmed;
  }
  if (parsed.protocol === "http:" && opts.allowHttpLocalhost && isLoopbackHostname(parsed.hostname)) {
    return trimmed;
  }
  throw new Error(
    `Transport security violation: ${label} must use https:// (refusing insecure "${parsed.protocol}" transport).`,
  );
}

const VALID_PG_TLS_MODES = new Set(["require", "verify-ca", "verify-full"]);

/**
 * Enforce TLS encryption in transit for PostgreSQL connections (`sslmode=require|verify-ca|verify-full`)
 * whenever `DATABASE_SSL_REQUIRE=true` OR when running in production against any non-loopback host.
 * Never logs or echoes DATABASE_URL credentials.
 */
export function assertDatabaseTransportSecurity(
  databaseUrl: string | undefined = process.env.DATABASE_URL,
  opts: { nodeEnv?: string; sslRequireEnv?: string } = {},
): void {
  const raw = databaseUrl?.trim();
  if (!raw) return;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Database configuration error: DATABASE_URL is not a valid PostgreSQL connection URL.");
  }

  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error(`Database configuration error: unsupported DATABASE_URL protocol "${parsed.protocol}".`);
  }

  const nodeEnv = opts.nodeEnv ?? process.env.NODE_ENV ?? "development";
  const sslFlag = (opts.sslRequireEnv ?? process.env.DATABASE_SSL_REQUIRE ?? "").trim().toLowerCase();
  const explicitRequire = sslFlag === "true" || sslFlag === "1";
  const isLocalHost = isLoopbackHostname(parsed.hostname) || parsed.searchParams.get("host")?.startsWith("/") === true;
  const requireTls = explicitRequire || (nodeEnv === "production" && !isLocalHost);

  if (!requireTls) return;

  const sslmode = (parsed.searchParams.get("sslmode") ?? "").trim().toLowerCase();
  if (!VALID_PG_TLS_MODES.has(sslmode)) {
    throw new Error(
      `Database transport security violation: DATABASE_URL must enforce TLS (set ?sslmode=require, verify-ca, or verify-full; current sslmode="${sslmode || "unset"}").`,
    );
  }
}

const PRIVILEGED_DB_USERS = new Set([
  "postgres",
  "supabase_admin",
  "rdsadmin",
  "cloudsqlsuperuser",
  "azure_pg_admin",
  "root",
  "admin",
  "pamarcy_admin",
  "pamarcy_migrator",
]);

const WEAK_DB_PASSWORDS = new Set([
  "postgres",
  "password",
  "admin",
  "root",
  "123456",
  "changeme",
  "change-me",
  "db_password",
  "secret",
]);

/**
 * Enforce least-privilege PostgreSQL runtime credentials on DATABASE_URL:
 *  - Rejects superuser/admin usernames (e.g. postgres, supabase_admin, rdsadmin) when in production
 *    or when DATABASE_ENFORCE_LEAST_PRIVILEGE=true.
 *  - Rejects weak/default passwords and empty credentials.
 *  - Verifies role separation between runtime DATABASE_URL and privileged migration DIRECT_URL.
 * Never logs or echoes credentials in error messages.
 */
export function assertDatabaseClientRoleSecurity(
  databaseUrl: string | undefined = process.env.DATABASE_URL,
  directUrl: string | undefined = process.env.DIRECT_URL,
  opts: { nodeEnv?: string; enforceLeastPrivilegeEnv?: string } = {},
): void {
  const raw = databaseUrl?.trim();
  if (!raw) return;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Database configuration error: DATABASE_URL is not a valid PostgreSQL connection URL.");
  }

  const nodeEnv = opts.nodeEnv ?? process.env.NODE_ENV ?? "development";
  const flag = (opts.enforceLeastPrivilegeEnv ?? process.env.DATABASE_ENFORCE_LEAST_PRIVILEGE ?? "").trim().toLowerCase();
  const enforced = nodeEnv === "production" || flag === "true" || flag === "1";
  if (!enforced) return;

  const username = decodeURIComponent(parsed.username || "").trim().toLowerCase();
  const password = decodeURIComponent(parsed.password || "").trim();

  if (!username || !password) {
    throw new Error("Database security violation: DATABASE_URL must specify an authenticated least-privilege database user and password.");
  }
  if (PRIVILEGED_DB_USERS.has(username)) {
    throw new Error(
      `Database security violation: DATABASE_URL must use a dedicated least-privilege application role, not privileged/superuser role "${username}". Use DIRECT_URL strictly for migrations.`,
    );
  }
  if (WEAK_DB_PASSWORDS.has(password.toLowerCase()) || password.length < 16) {
    throw new Error(
      "Database security violation: DATABASE_URL password is too weak or uses a default value (minimum 16 random characters required).",
    );
  }

  const rawDirect = directUrl?.trim();
  if (rawDirect) {
    let parsedDirect: URL;
    try {
      parsedDirect = new URL(rawDirect);
    } catch {
      throw new Error("Database configuration error: DIRECT_URL is not a valid PostgreSQL connection URL.");
    }
    const directUser = decodeURIComponent(parsedDirect.username || "").trim().toLowerCase();
    if (directUser && directUser === username) {
      throw new Error(
        "Database security violation: DATABASE_URL (runtime app role) and DIRECT_URL (migration/admin role) must use separate database roles.",
      );
    }
  }
}

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
  get enforceHttps() {
    const v = process.env.ENFORCE_HTTPS?.trim().toLowerCase();
    return v === "1" || v === "true";
  },
  get appUrl() {
    const raw = process.env.APP_URL?.trim() || "http://localhost:3000";
    return assertSecureHttpsUrl(raw, "APP_URL", { allowHttpLocalhost: true });
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
      const raw = process.env.BAKONG_API_BASE?.trim() || "https://api-bakong.nbc.gov.kh";
      return assertSecureHttpsUrl(raw, "BAKONG_API_BASE", { allowHttpLocalhost: process.env.NODE_ENV !== "production" });
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
      const raw = process.env.TRONGRID_API_BASE?.trim() || "https://api.trongrid.io";
      return assertSecureHttpsUrl(raw, "TRONGRID_API_BASE", { allowHttpLocalhost: process.env.NODE_ENV !== "production" });
    },
    get apiKey() {
      return process.env.TRONGRID_API_KEY?.trim() || "";
    },
  },
  evmRpcUrl(envVarName: "ETHEREUM_RPC_URL" | "BSC_RPC_URL" | "POLYGON_RPC_URL"): string {
    const raw = process.env[envVarName]?.trim() || "";
    if (!raw) return "";
    return assertSecureHttpsUrl(raw, envVarName, { allowHttpLocalhost: process.env.NODE_ENV !== "production" });
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
    get allowInsecureLocal() {
      const v = process.env.SMTP_ALLOW_INSECURE_LOCAL?.trim().toLowerCase();
      return process.env.NODE_ENV !== "production" && (v === "1" || v === "true");
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
