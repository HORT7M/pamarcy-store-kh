import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { assertNoPublicSecrets, getAuthSecret, getCronSecret, SECRET_ENV_NAMES } from "../../src/lib/env.ts";
import { orderAccessToken } from "../../src/lib/order-access.ts";
import { verifyUsdtTransfer } from "../../src/lib/services/payments/usdt.ts";

if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", ".pgdata", ".git", "backups", "storage", "uploads"].includes(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, out);
    else if (/\.(ts|tsx|mts|mjs|js|jsx|json|md|sh)$/.test(ent.name) && ent.name !== "package-lock.json" && ent.name !== "CREDITS.json") {
      out.push(full);
    }
  }
  return out;
}

function walkAllFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkAllFiles(full, out);
    else out.push(full);
  }
  return out;
}

describe("Secrets, environment variables & frontend isolation audit", () => {
  it("ensures .env is ignored in .gitignore, untracked in git, and properly permissioned while .env.example is preserved", () => {
    assert.equal(existsSync(".gitignore"), true, ".gitignore must exist");
    const gitignore = readFileSync(".gitignore", "utf8");
    const lines = gitignore.split(/\r?\n/).map((l) => l.trim());
    assert.ok(lines.includes(".env"), ".gitignore must explicitly include .env");
    assert.ok(lines.includes(".env*"), ".gitignore must include .env*");
    assert.ok(lines.includes("!.env.example"), ".gitignore must keep !.env.example tracked");
    assert.ok(lines.some((l) => l.includes("backups")), ".gitignore must ignore backups");
    assert.ok(lines.some((l) => l.includes(".pgdata")), ".gitignore must ignore .pgdata");
    assert.ok(lines.includes("*.pem") && lines.includes("*.key"), ".gitignore must ignore private key files");

    if (existsSync(".git")) {
      const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
      assert.equal(tracked.includes(".env"), false, ".env MUST NOT be tracked in git");
      assert.equal(tracked.some((f) => /^\.env(?!\.example$)/.test(path.basename(f))), false, "No .env secret file may be tracked in git");
      assert.equal(tracked.includes(".env.example"), true, ".env.example should be tracked in git");

      for (const secretPath of [".env", ".env.local", ".env.production", "backups/test.enc", ".pgdata/PG_VERSION", "private.pem", "server.key"]) {
        const out = execFileSync("git", ["check-ignore", secretPath], { encoding: "utf8" }).trim();
        assert.equal(out, secretPath, `git must ignore ${secretPath}`);
      }
    }

    if (existsSync(".env") && process.platform !== "win32") {
      const mode = statSync(".env").mode & 0o777;
      assert.equal(mode & 0o077, 0, `.env permissions (${mode.toString(8)}) should not be group/world readable`);
    }
  });

  it("ensures .env.example documents all secrets cleanly with empty values and zero NEXT_PUBLIC_ secret vars", () => {
    const example = readFileSync(".env.example", "utf8");
    assert.equal(/NEXT_PUBLIC_/.test(example), false, ".env.example must not define NEXT_PUBLIC_ credentials");
    assert.equal(/postgres:postgres/.test(example), false, ".env.example must not hardcode postgres:postgres");
    assert.equal(/Admin@12345|Staff@12345|Customer@123/.test(example), false, ".env.example must not contain real/seed passwords");

    const requiredEmptyKeys = [
      "AUTH_SECRET",
      "CRON_SECRET",
      "DATA_ENCRYPTION_KEY",
      "DATA_ENCRYPTION_KEYRING",
      "BACKUP_ENCRYPTION_KEY",
      "SEED_SUPERADMIN_PASSWORD",
      "SEED_STAFF_PASSWORD",
      "SEED_CUSTOMER_PASSWORD",
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
      "TURNSTILE_SECRET_KEY",
      "HCAPTCHA_SECRET_KEY",
      "SMTP_PASS",
    ];
    for (const key of requiredEmptyKeys) {
      const m = example.match(new RegExp(`^${key}="([^"]*)"`, "m"));
      assert.ok(m, `.env.example must document ${key}`);
      assert.equal(m[1], "", `${key} in .env.example must be empty`);
    }
  });

  it("rejects missing, short, or placeholder AUTH_SECRET / CRON_SECRET and blocks NEXT_PUBLIC_ secrets", () => {
    const origAuth = process.env.AUTH_SECRET;
    const origCron = process.env.CRON_SECRET;
    try {
      process.env.AUTH_SECRET = "";
      assert.throws(() => getAuthSecret(), /AUTH_SECRET/);
      assert.throws(() => orderAccessToken("ord_123"), /AUTH_SECRET/);

      process.env.AUTH_SECRET = "dev";
      assert.throws(() => getAuthSecret(), /AUTH_SECRET/);

      process.env.AUTH_SECRET = "change-me-to-a-long-random-string-at-least-32-chars";
      assert.throws(() => getAuthSecret(), /AUTH_SECRET/);

      process.env.CRON_SECRET = "";
      assert.equal(getCronSecret(), null);
      process.env.CRON_SECRET = "change-me";
      assert.equal(getCronSecret(), null);
    } finally {
      process.env.AUTH_SECRET = origAuth;
      process.env.CRON_SECRET = origCron;
    }

    assert.ok(getAuthSecret().length >= 32);
    for (const secretName of SECRET_ENV_NAMES) {
      assert.throws(
        () => assertNoPublicSecrets({ [`NEXT_PUBLIC_${secretName}`]: "leaked-secret-value" }),
        /Security violation/,
      );
    }
    // Value-inspection guards even on allowlisted NEXT_PUBLIC_ names
    const fakeServiceRoleJwt = [
      Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify({ role: "service_role", sub: "test" })).toString("base64url"),
      "signature_placeholder",
    ].join(".");
    assert.throws(
      () => assertNoPublicSecrets({ NEXT_PUBLIC_APP_URL: "postgresql://user:pass@db.example.com:5432/app" }),
      /database connection URI/i,
    );
    assert.throws(
      () => assertNoPublicSecrets({ NEXT_PUBLIC_SUPABASE_ANON_KEY: fakeServiceRoleJwt }),
      /privileged "service_role" JWT/i,
    );
    assert.throws(
      () => assertNoPublicSecrets({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_secret_abcdef1234567890" }),
      /sb_secret_/i,
    );
    assert.throws(
      () => assertNoPublicSecrets({ NEXT_PUBLIC_CUSTOM_API_SECRET: "supersecret" }),
      /restricted credential pattern/i,
    );
  });

  it("enforces server-only boundaries and forbids process.env or server secret imports in client components", () => {
    const mustBeServerOnly = [
      "src/lib/env.ts",
      "src/lib/db.ts",
      "src/lib/crypto.ts",
      "src/lib/db-encryption.ts",
      "src/lib/order-access.ts",
      "src/lib/upload.ts",
      "src/lib/auth/session.ts",
      "src/lib/auth/password.ts",
      "src/lib/auth/password-reset.ts",
      "src/lib/auth/guards.ts",
      "src/lib/security/bot-protection.ts",
      "src/lib/services/email.ts",
      "src/lib/services/payments/config.ts",
      "src/lib/services/payments/index.ts",
      "src/lib/services/payments/khqr.ts",
      "src/lib/services/payments/paypal.ts",
      "src/lib/services/payments/usdt.ts",
    ];
    for (const f of mustBeServerOnly) {
      const content = readFileSync(f, "utf8");
      assert.match(content, /^import\s+["']server-only["'];/m, `${f} must import "server-only"`);
    }

    const forbiddenClientImportRe =
      /from\s+["']@\/lib\/(env|db|crypto|db-encryption|order-access|upload|security-headers|security\/|auth\/(session|password|password-reset|guards|rate-limits)|services\/)/;

    const srcFiles = walkFiles("src");
    for (const f of srcFiles) {
      const content = readFileSync(f, "utf8");
      const isClient = /^["']use client["'];?/m.test(content);
      if (isClient) {
        assert.equal(/process\.env/.test(content), false, `Client component ${f} must not access process.env`);
        assert.equal(forbiddenClientImportRe.test(content), false, `Client component ${f} must not import server-only modules`);
      }
    }
  });

  it("ensures no exposed API keys, private keys, hardcoded passwords, or secret CLI argv leaks exist in source, scripts, or docs", () => {
    const allFiles = [
      ...walkFiles("src"),
      ...walkFiles("prisma"),
      ...walkFiles("scripts").filter((f) => !f.endsWith("security-secrets.test.mts")),
      "README.md",
      "docs/API.md",
    ];
    const forbiddenLiterals = [
      "Admin@12345",
      "Staff@12345",
      "Customer@123",
      'AUTH_SECRET ?? "dev"',
      'password: "postgres"',
    ];
    const secretPatterns = [
      { name: "Private Key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
      { name: "Cloud/API Key", re: /\b(sk_live_|sk_test_|rk_live_|rk_test_|AIza[0-9A-Za-z_-]{35}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|xox[baprs]-[0-9A-Za-z-]{10,}|cloudinary:\/\/|SG\.[A-Za-z0-9_-]{16,}|sk-ant-[0-9A-Za-z_-]+)/ },
      { name: "Hardcoded JWT", re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
    ];
    for (const f of allFiles) {
      const content = readFileSync(f, "utf8");
      for (const lit of forbiddenLiterals) {
        assert.equal(content.includes(lit), false, `Hardcoded credential/fallback "${lit}" found in ${f}`);
      }
      for (const p of secretPatterns) {
        assert.equal(p.re.test(content), false, `${p.name} pattern found in ${f}`);
      }
    }

    // Ensure pg_dump never receives DATABASE_URL password on command-line argv
    const backupSh = readFileSync("scripts/backup-db.sh", "utf8");
    assert.equal(/pg_dump\s+["']?\$\{?DATABASE_URL/.test(backupSh), false, "backup-db.sh must not pass DATABASE_URL directly as pg_dump CLI argument");
  });

  it("never leaks embedded EVM RPC API keys when upstream RPC fetch fails", async () => {
    const origRpc = process.env.ETHEREUM_RPC_URL;
    const origFetch = globalThis.fetch;
    const fakeSecretKey = "ALCHEMY_SUPER_SECRET_RPC_KEY_987654321";
    const fakeRpcUrl = `https://eth-mainnet.example.invalid/v2/${fakeSecretKey}`;
    try {
      process.env.ETHEREUM_RPC_URL = fakeRpcUrl;
      globalThis.fetch = (async () => {
        throw new TypeError(`fetch failed for ${fakeRpcUrl}`);
      }) as typeof fetch;

      await assert.rejects(
        () =>
          verifyUsdtTransfer(
            {
              code: "ERC20",
              enabled: true,
              walletAddress: "0x1111111111111111111111111111111111111111",
              contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
              decimals: 6,
              confirmations: 12,
            },
            "0x" + "a".repeat(64),
            "10.00",
            new Date(Date.now() - 60_000),
          ),
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          assert.equal(msg.includes(fakeSecretKey), false, "RPC API key leaked in error message");
          assert.equal(msg.includes("eth-mainnet.example.invalid"), false, "RPC URL leaked in error message");
          return true;
        },
      );
    } finally {
      globalThis.fetch = origFetch;
      if (origRpc === undefined) delete process.env.ETHEREUM_RPC_URL;
      else process.env.ETHEREUM_RPC_URL = origRpc;
    }
  });

  it("verifies compiled frontend static bundles (.next/static) contain zero .env secret values", () => {
    if (!existsSync(".next/static")) return;
    const secretValues = SECRET_ENV_NAMES
      .map((k) => process.env[k]?.trim())
      .filter((v): v is string => Boolean(v && v.length >= 8));
    assert.ok(secretValues.length > 0, "Expected active secrets in .env to verify bundle isolation");

    for (const f of walkAllFiles(".next/static")) {
      if (!/\.(js|css|json|map)$/.test(f)) continue;
      const chunk = readFileSync(f, "utf8");
      for (const secret of secretValues) {
        assert.equal(chunk.includes(secret), false, `Secret value leaked into frontend bundle ${f}`);
      }
    }
  });

  it("verifies live public endpoints never leak env secrets, internal key names, or credential hashes", async () => {
    const app = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
    let reachable = false;
    try {
      const probe = await fetch(`${app}/api/auth/me`, { signal: AbortSignal.timeout(2000) });
      reachable = probe.ok;
    } catch {
      reachable = false;
    }
    if (!reachable) return;

    const secretValues = SECRET_ENV_NAMES
      .map((k) => process.env[k]?.trim())
      .filter((v): v is string => Boolean(v && v.length >= 8));

    // 1. Public payment methods must not expose env variable names or secrets
    const pmRes = await fetch(`${app}/api/payment-methods`);
    assert.equal(pmRes.status, 200);
    const pmText = await pmRes.text();
    assert.equal(pmText.includes("BAKONG_API_TOKEN"), false, "/api/payment-methods leaked BAKONG_API_TOKEN name");
    assert.equal(pmText.includes("PAYPAL_CLIENT_SECRET"), false, "/api/payment-methods leaked PAYPAL_CLIENT_SECRET name");
    for (const s of secretValues) {
      assert.equal(pmText.includes(s), false, "/api/payment-methods leaked a secret value");
    }

    // 2. Bot protection challenge must never expose secret keys
    const botRes = await fetch(`${app}/api/bot-protection/challenge?action=login`);
    assert.equal(botRes.status, 200);
    const botText = await botRes.text();
    assert.equal(botText.includes("secretKey"), false);
    assert.equal(botText.includes("TURNSTILE_SECRET"), false);
    assert.equal(botText.includes("HCAPTCHA_SECRET"), false);
    for (const s of secretValues) {
      assert.equal(botText.includes(s), false, "/api/bot-protection/challenge leaked a secret value");
    }

    // 3. Cron endpoint must reject missing or wrong CRON_SECRET (401 unauthorized or 429 brute-force lockout)
    const cronUnauth = await fetch(`${app}/api/cron/maintenance`, { method: "POST" });
    assert.ok([401, 429].includes(cronUnauth.status), `Expected 401/429 for missing CRON_SECRET, got ${cronUnauth.status}`);
    const cronUnauthBody = await cronUnauth.text();
    for (const s of secretValues) assert.equal(cronUnauthBody.includes(s), false);
    const cronWrong = await fetch(`${app}/api/cron/maintenance`, {
      method: "POST",
      headers: { "x-cron-secret": "wrong-secret-value-123456" },
    });
    assert.ok([401, 429].includes(cronWrong.status), `Expected 401/429 for wrong CRON_SECRET, got ${cronWrong.status}`);
    const cronWrongBody = await cronWrong.text();
    for (const s of secretValues) assert.equal(cronWrongBody.includes(s), false);
  });
});
