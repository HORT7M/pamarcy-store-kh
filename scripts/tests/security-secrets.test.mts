import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { assertNoPublicSecrets, getAuthSecret, getCronSecret, SECRET_ENV_NAMES } from "../../src/lib/env.ts";
import { orderAccessToken } from "../../src/lib/order-access.ts";

if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", ".pgdata", "backups", "storage", "uploads"].includes(ent.name)) continue;
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
  it("ensures .env is ignored in .gitignore while .env.example is preserved", () => {
    assert.equal(existsSync(".gitignore"), true, ".gitignore must exist");
    const gitignore = readFileSync(".gitignore", "utf8");
    const lines = gitignore.split(/\r?\n/).map((l) => l.trim());
    assert.ok(lines.includes(".env"), ".gitignore must explicitly include .env");
    assert.ok(lines.includes(".env*"), ".gitignore must include .env*");
    assert.ok(lines.includes("!.env.example"), ".gitignore must keep !.env.example tracked");
    assert.ok(lines.some((l) => l.includes("backups")), ".gitignore must ignore backups");
    assert.ok(lines.some((l) => l.includes(".pgdata")), ".gitignore must ignore .pgdata");
    if (existsSync(".env") && process.platform !== "win32") {
      const mode = statSync(".env").mode & 0o777;
      assert.equal(mode & 0o077, 0, `.env permissions (${mode.toString(8)}) should not be group/world readable`);
    }
  });

  it("ensures .env.example has no real secrets, hardcoded passwords, or NEXT_PUBLIC_ secret vars", () => {
    const example = readFileSync(".env.example", "utf8");
    assert.equal(/NEXT_PUBLIC_/.test(example), false, ".env.example must not define NEXT_PUBLIC_ credentials");
    assert.equal(/postgres:postgres/.test(example), false, ".env.example must not hardcode postgres:postgres");
    assert.equal(/Admin@12345|Staff@12345|Customer@123/.test(example), false, ".env.example must not contain real/seed passwords");
    for (const key of ["AUTH_SECRET", "CRON_SECRET", "BAKONG_API_TOKEN", "PAYPAL_CLIENT_SECRET", "CLOUDINARY_API_SECRET", "TRONGRID_API_KEY", "SMTP_PASS"]) {
      const m = example.match(new RegExp(`^${key}="([^"]*)"`, "m"));
      assert.ok(m, `.env.example should document ${key}`);
      assert.equal(m[1], "", `${key} in .env.example should be empty`);
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
  });

  it("enforces server-only boundaries and forbids process.env or server secret imports in client components", () => {
    const mustBeServerOnly = [
      "src/lib/env.ts",
      "src/lib/db.ts",
      "src/lib/order-access.ts",
      "src/lib/upload.ts",
      "src/lib/auth/session.ts",
      "src/lib/auth/password.ts",
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

    const srcFiles = walkFiles("src");
    for (const f of srcFiles) {
      const content = readFileSync(f, "utf8");
      const isClient = /^["']use client["'];?/m.test(content);
      if (isClient) {
        assert.equal(/process\.env/.test(content), false, `Client component ${f} must not access process.env`);
        assert.equal(/from\s+["']@\/lib\/(env|db|order-access|upload|auth\/session|auth\/password|services\/)/.test(content), false, `Client component ${f} must not import server-only modules`);
      }
    }
  });

  it("ensures no hardcoded passwords or secret fallbacks exist in source, scripts, or docs", () => {
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
    for (const f of allFiles) {
      const content = readFileSync(f, "utf8");
      for (const lit of forbiddenLiterals) {
        assert.equal(content.includes(lit), false, `Hardcoded credential/fallback "${lit}" found in ${f}`);
      }
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
});
