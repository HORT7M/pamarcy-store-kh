import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { prisma } from "../../src/lib/db.ts";
import {
  ALLOWED_PUBLIC_ENV_NAMES,
  assertDatabaseClientRoleSecurity,
  assertDatabaseTransportSecurity,
  assertNoPublicSecrets,
  SECRET_ENV_NAMES,
} from "../../src/lib/env.ts";

if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}

function walkSourceFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", ".pgdata", "backups", "storage", "uploads"].includes(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkSourceFiles(full, out);
    else if (/\.(ts|tsx|mts|mjs|js|jsx)$/.test(ent.name)) out.push(full);
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

function makeFakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fakesignature1234567890`;
}

async function assertPgDenied(client: pg.Client, sql: string, label: string) {
  await assert.rejects(
    () => client.query(sql),
    (err: unknown) => {
      const pgErr = err as { code?: string; message?: string };
      assert.equal(
        pgErr.code,
        "42501",
        `${label} should fail with PostgreSQL 42501 (insufficient_privilege), got code=${pgErr.code} msg=${pgErr.message}`,
      );
      return true;
    },
    `${label} unexpectedly succeeded under runtime app role!`,
  );
}

describe("Database client configuration & frontend key isolation audit", () => {
  it("enforces server-only boundaries on all database and crypto modules and keeps Prisma runtime out of frontend code", () => {
    const serverOnlyDbModules = [
      "src/lib/db.ts",
      "src/lib/db-encryption.ts",
      "src/lib/crypto.ts",
      "src/lib/env.ts",
      "src/lib/sequence.ts",
      "src/lib/order-access.ts",
      "src/lib/auth/session.ts",
    ];
    for (const file of serverOnlyDbModules) {
      const content = readFileSync(file, "utf8");
      assert.match(content, /^import\s+["']server-only["'];/m, `${file} must import "server-only"`);
    }

    // Shared money helper must use type-only Prisma import so client bundles never pull @prisma/client runtime
    const moneySrc = readFileSync("src/lib/money.ts", "utf8");
    assert.match(moneySrc, /^import\s+type\s+\{[^}]*Prisma[^}]*\}\s+from\s+["']@prisma\/client["'];/m);

    // Every "use client" module must never import DB clients, env modules, Prisma, or reference process.env / DIRECT_URL
    for (const file of walkSourceFiles("src")) {
      const content = readFileSync(file, "utf8");
      if (!/^["']use client["'];?/m.test(content)) continue;
      assert.equal(/@prisma\/client/.test(content), false, `Client module ${file} must not import @prisma/client`);
      assert.equal(/@\/lib\/(db|db-encryption|crypto|env|sequence)\b/.test(content), false, `Client module ${file} must not import server DB modules`);
      assert.equal(/process\.env/.test(content), false, `Client module ${file} must not read process.env`);
      assert.equal(/\b(DATABASE_URL|DIRECT_URL|SERVICE_ROLE|PG_PASSWORD|PG_APP_PASSWORD)\b/.test(content), false, `Client module ${file} must not reference privileged DB env vars`);
    }

    // Runtime app pages/routes must never reference privileged DIRECT_URL
    for (const file of [...walkSourceFiles("src/app"), ...walkSourceFiles("src/components")]) {
      const content = readFileSync(file, "utf8");
      assert.equal(/\bDIRECT_URL\b/.test(content), false, `Runtime route/component ${file} must never reference DIRECT_URL`);
    }
  });

  it("blocks service-role keys, privileged DB URLs, and arbitrary secret NEXT_PUBLIC_* vars while allowing only intended public/anon keys", () => {
    // 1. Explicit secret list
    for (const key of SECRET_ENV_NAMES) {
      assert.throws(
        () => assertNoPublicSecrets({ [`NEXT_PUBLIC_${key}`]: "secret-test-value" }),
        /Security violation/,
        `Expected NEXT_PUBLIC_${key} to be rejected`,
      );
    }

    // 2. Pattern-based detection blocks arbitrary privileged/secret NEXT_PUBLIC_* names
    const badNames = [
      "NEXT_PUBLIC_CUSTOM_DATABASE_URL",
      "NEXT_PUBLIC_MY_SERVICE_ROLE_KEY",
      "NEXT_PUBLIC_ADMIN_API_SECRET",
      "NEXT_PUBLIC_POSTGRES_PASSWORD",
      "NEXT_PUBLIC_APP_PRIVATE_KEY",
    ];
    for (const name of badNames) {
      assert.throws(
        () => assertNoPublicSecrets({ [name]: "some-value" }),
        /Security violation/,
        `Expected ${name} to be rejected by pattern guard`,
      );
    }

    // 3. Even allowlisted public/anon variable names reject service_role JWTs, sb_secret_ keys, DB URIs, and PEM private keys
    assert.ok(ALLOWED_PUBLIC_ENV_NAMES.has("NEXT_PUBLIC_SUPABASE_ANON_KEY"));
    const serviceRoleJwt = makeFakeJwt({ iss: "supabase", role: "service_role", ref: "demo" });
    assert.throws(
      () => assertNoPublicSecrets({ NEXT_PUBLIC_SUPABASE_ANON_KEY: serviceRoleJwt }),
      /service_role/i,
      "Must block service_role JWT pasted into NEXT_PUBLIC_SUPABASE_ANON_KEY",
    );
    assert.throws(
      () => assertNoPublicSecrets({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_secret_1234567890abcdef" }),
      /sb_secret/i,
      "Must block Supabase sb_secret_* key in NEXT_PUBLIC_*",
    );
    assert.throws(
      () => assertNoPublicSecrets({ NEXT_PUBLIC_APP_URL: "postgresql://user:pass@db.example.com:5432/app" }),
      /database connection URI/i,
      "Must block PostgreSQL URI in NEXT_PUBLIC_*",
    );
    assert.throws(
      () => assertNoPublicSecrets({ NEXT_PUBLIC_TURNSTILE_SITE_KEY: ["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" ") + "\nabc" }),
      /private key/i,
      "Must block PEM private key in NEXT_PUBLIC_*",
    );

    // 4. Intended public/anonymous keys ARE permitted
    const anonJwt = makeFakeJwt({ iss: "supabase", role: "anon", ref: "demo" });
    assert.doesNotThrow(() =>
      assertNoPublicSecrets({
        NEXT_PUBLIC_APP_URL: "https://pamarcy.com.kh",
        NEXT_PUBLIC_TURNSTILE_SITE_KEY: "0x4AAAAAAA_public_site_key",
        NEXT_PUBLIC_HCAPTCHA_SITE_KEY: "10000000-ffff-ffff-ffff-000000000001",
        NEXT_PUBLIC_SUPABASE_URL: "https://demo.supabase.co",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: anonJwt,
      }),
    );
  });

  it("enforces least-privilege role separation, strong credentials, and TLS transport rules on DATABASE_URL", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    assert.match(schema, /url\s*=\s*env\("DATABASE_URL"\)/, "schema.prisma must use DATABASE_URL for runtime url");
    assert.match(schema, /directUrl\s*=\s*env\("DIRECT_URL"\)/, "schema.prisma must separate migration directUrl");

    // Rejects superuser / privileged usernames in enforced/production mode
    for (const privUser of ["postgres", "supabase_admin", "rdsadmin", "root", "admin"]) {
      assert.throws(
        () =>
          assertDatabaseClientRoleSecurity(
            `postgresql://${privUser}:0123456789abcdef0123456789abcdef@db.example.com:5432/pamarcy?sslmode=require`,
            undefined,
            { nodeEnv: "production" },
          ),
        /least-privilege/i,
        `Should reject privileged DB user "${privUser}" in production`,
      );
    }

    // Rejects weak/default passwords
    assert.throws(
      () =>
        assertDatabaseClientRoleSecurity(
          "postgresql://pamarcy_app:password@db.example.com:5432/pamarcy?sslmode=require",
          undefined,
          { nodeEnv: "production" },
        ),
      /too weak/i,
    );

    // Rejects identical username on DATABASE_URL and DIRECT_URL
    assert.throws(
      () =>
        assertDatabaseClientRoleSecurity(
          "postgresql://pamarcy_app:0123456789abcdef0123456789abcdef@db.example.com:5432/pamarcy?sslmode=require",
          "postgresql://pamarcy_app:fedcba9876543210fedcba9876543210@db.example.com:5432/pamarcy?sslmode=require",
          { nodeEnv: "production" },
        ),
      /separate database roles/i,
    );

    // Accepts properly separated least-privilege DATABASE_URL + privileged DIRECT_URL
    assert.doesNotThrow(() =>
      assertDatabaseClientRoleSecurity(
        "postgresql://pamarcy_app:0123456789abcdef0123456789abcdef@db.example.com:5432/pamarcy?sslmode=require",
        "postgresql://pamarcy_migrator:fedcba9876543210fedcba9876543210@db.example.com:5432/pamarcy?sslmode=require",
        { nodeEnv: "production" },
      ),
    );

    // Enforces TLS on remote production databases
    assert.throws(
      () =>
        assertDatabaseTransportSecurity("postgresql://pamarcy_app:0123456789abcdef@db.example.com:5432/pamarcy", {
          nodeEnv: "production",
        }),
      /sslmode/i,
    );
    assert.doesNotThrow(() =>
      assertDatabaseTransportSecurity(
        "postgresql://pamarcy_app:0123456789abcdef@db.example.com:5432/pamarcy?sslmode=verify-full",
        { nodeEnv: "production" },
      ),
    );
  });

  it("verifies compiled frontend static bundles (.next/static) expose zero DB credentials or privileged keys", () => {
    if (!existsSync(".next/static")) return;
    const dbCreds = [
      process.env.DATABASE_URL?.trim(),
      process.env.DIRECT_URL?.trim(),
      process.env.PG_APP_PASSWORD?.trim(),
    ].filter((v): v is string => Boolean(v && v.length >= 8));
    assert.ok(dbCreds.length >= 2, "Expected active DATABASE_URL / DIRECT_URL / PG_APP_PASSWORD in .env");

    for (const file of walkAllFiles(".next/static")) {
      if (!/\.(js|css|json|map)$/.test(file)) continue;
      const chunk = readFileSync(file, "utf8");
      for (const secret of dbCreds) {
        assert.equal(chunk.includes(secret), false, `Privileged DB credential leaked into frontend bundle ${file}`);
      }
      assert.equal(/postgresql:\/\/|postgres:\/\//i.test(chunk), false, `PostgreSQL URI found in frontend bundle ${file}`);
      assert.equal(/service_role/i.test(chunk), false, `service_role string found in frontend bundle ${file}`);
    }
  });
});

describe("Live PostgreSQL least-privilege permissions & privilege-escalation verification", () => {
  const appClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const adminClient = new pg.Client({ connectionString: process.env.DIRECT_URL });

  after(async () => {
    await appClient.end().catch(() => {});
    await adminClient.end().catch(() => {});
    await prisma.$disconnect();
  });

  it("confirms runtime PrismaClient connects as least-privilege pamarcy_app (never postgres superuser) with SCRAM-SHA-256", async () => {
    const [identity] = await prisma.$queryRaw<{ current_user: string; session_user: string }[]>`
      SELECT current_user, session_user
    `;
    assert.equal(identity.current_user, "pamarcy_app");
    assert.equal(identity.session_user, "pamarcy_app");

    await adminClient.connect();
    const roleRow = (
      await adminClient.query(
        `SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls
         FROM pg_roles WHERE rolname = $1`,
        ["pamarcy_app"],
      )
    ).rows[0];
    assert.ok(roleRow, "pamarcy_app role must exist");
    assert.equal(roleRow.rolcanlogin, true);
    assert.equal(roleRow.rolsuper, false);
    assert.equal(roleRow.rolcreatedb, false);
    assert.equal(roleRow.rolcreaterole, false);
    assert.equal(roleRow.rolreplication, false);
    assert.equal(roleRow.rolbypassrls, false);
    assert.equal(roleRow.rolinherit, false);

    // SCRAM-SHA-256 password hash + pg_hba_file_rules free of cleartext password / trust
    const shadow = (await adminClient.query(`SELECT left(passwd, 14) AS prefix FROM pg_shadow WHERE usename = $1`, ["pamarcy_app"])).rows[0];
    assert.equal(shadow?.prefix, "SCRAM-SHA-256$");

    const hbaRules = (await adminClient.query(`SELECT type, database, user_name, auth_method FROM pg_hba_file_rules WHERE error IS NULL`)).rows;
    assert.ok(hbaRules.length > 0);
    for (const rule of hbaRules) {
      assert.notEqual(rule.auth_method, "password", "pg_hba.conf must not use cleartext password authentication");
      assert.notEqual(rule.auth_method, "trust", "pg_hba.conf must not use unauthenticated trust authentication");
    }

    // PUBLIC pseudo-role has zero DB / schema / table grants
    const pubPrivs = (
      await adminClient.query(`
        SELECT
          has_database_privilege('public', current_database(), 'CONNECT') AS db_connect,
          has_database_privilege('public', current_database(), 'TEMPORARY') AS db_temp,
          has_schema_privilege('public', 'public', 'USAGE') AS schema_usage,
          has_schema_privilege('public', 'public', 'CREATE') AS schema_create
      `)
    ).rows[0];
    assert.equal(pubPrivs.db_connect, false);
    assert.equal(pubPrivs.db_temp, false);
    assert.equal(pubPrivs.schema_usage, false);
    assert.equal(pubPrivs.schema_create, false);

    const pubTableGrants = await adminClient.query(
      `SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee = 'PUBLIC'`,
    );
    assert.equal(pubTableGrants.rowCount, 0);
  });

  it("empirically blocks DDL, temp tables, _prisma_migrations, RBAC writes, ledger tampering, TRUNCATE, and superuser ops under pamarcy_app", async () => {
    await appClient.connect();

    // Positive sanity: authorized runtime reads work
    const catRes = await appClient.query(`SELECT count(*)::int AS n FROM "Category"`);
    assert.ok(catRes.rows[0].n > 0);
    const roleRes = await appClient.query(`SELECT count(*)::int AS n FROM "Role"`);
    assert.ok(roleRes.rows[0].n >= 6);

    // Negative enforcement: ALL privileged or disallowed actions fail with PostgreSQL 42501
    await assertPgDenied(appClient, `CREATE TABLE public._evil_probe (id int)`, "DDL CREATE TABLE");
    await assertPgDenied(appClient, `ALTER TABLE public."Category" ADD COLUMN _evil text`, "DDL ALTER TABLE");
    await assertPgDenied(appClient, `CREATE TEMP TABLE _evil_temp (id int)`, "CREATE TEMP TABLE");
    await assertPgDenied(appClient, `SELECT * FROM public."_prisma_migrations" LIMIT 1`, "Read _prisma_migrations");
    await assertPgDenied(appClient, `INSERT INTO public."Role" (id, key, name, "updatedAt") VALUES ('evil', 'EVIL', 'Evil', now())`, "Insert into Role");
    await assertPgDenied(appClient, `UPDATE public."Role" SET name = 'Hacked' WHERE key = 'CUSTOMER'`, "Update Role");
    await assertPgDenied(appClient, `DELETE FROM public."Permission" WHERE key = 'nonexistent'`, "Delete Permission");
    await assertPgDenied(appClient, `DELETE FROM public."RolePermission" WHERE "roleId" = 'nonexistent'`, "Delete RolePermission");
    await assertPgDenied(appClient, `UPDATE public."UsedTransactionHash" SET "txHash" = 'x' WHERE id = 'nonexistent'`, "Update UsedTransactionHash");
    await assertPgDenied(appClient, `DELETE FROM public."UsedTransactionHash" WHERE id = 'nonexistent'`, "Delete UsedTransactionHash");
    await assertPgDenied(appClient, `UPDATE public."OrderStatusHistory" SET note = 'x' WHERE id = 'nonexistent'`, "Update OrderStatusHistory");
    await assertPgDenied(appClient, `DELETE FROM public."OrderStatusHistory" WHERE id = 'nonexistent'`, "Delete OrderStatusHistory");
    await assertPgDenied(appClient, `DELETE FROM public."PaymentTransaction" WHERE id = 'nonexistent'`, "Delete PaymentTransaction");
    await assertPgDenied(appClient, `UPDATE public."StockMovement" SET quantity = 999 WHERE id = 'nonexistent'`, "Update StockMovement");
    await assertPgDenied(appClient, `TRUNCATE TABLE public."Banner"`, "TRUNCATE table");
    await assertPgDenied(appClient, `CREATE ROLE _evil_admin SUPERUSER`, "CREATE ROLE");
    await assertPgDenied(appClient, `SELECT * FROM pg_shadow LIMIT 1`, "Read pg_shadow");
  });
});
