/**
 * PostgreSQL Least-Privilege Permissions Provisioning & Verification CLI
 *
 * Usage:
 *   npm run db:harden-permissions                    # Provision/reconcile pamarcy_app least-privilege role & SCRAM-SHA-256
 *   npm run db:harden-permissions -- --strict-audit  # Production mode: make AuditLog/StockMovement/PaymentTransaction pure append-only (SELECT, INSERT)
 *   npm run db:verify-permissions                    # Read-only live PostgreSQL permissions audit (exits non-zero on any regression)
 */
import pg from "pg";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}

const PG_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function assertIdent(name, label) {
  if (!PG_IDENT_RE.test(name)) {
    throw new Error(`Invalid PostgreSQL identifier for ${label}: "${name}"`);
  }
  return name;
}

function quoteIdent(name) {
  assertIdent(name, "identifier");
  return `"${name}"`;
}

// Explicit per-table least-privilege classification for runtime role `pamarcy_app`
const DENIED_TABLES = new Set(["_prisma_migrations"]);
const READ_ONLY_TABLES = new Set(["Role", "Permission", "RolePermission"]);
const APPEND_ONLY_TABLES = new Set(["UsedTransactionHash", "OrderStatusHistory"]);
const NO_DELETE_TABLES = new Set(["PaymentTransaction"]);
const NO_UPDATE_TABLES = new Set(["StockMovement"]);
const AUDIT_TABLES = new Set(["AuditLog"]);

function expectedPrivilegesForTable(tableName, strictAudit) {
  if (DENIED_TABLES.has(tableName)) return [];
  if (READ_ONLY_TABLES.has(tableName)) return ["SELECT"];
  if (APPEND_ONLY_TABLES.has(tableName)) return ["INSERT", "SELECT"];
  if (strictAudit && (NO_DELETE_TABLES.has(tableName) || NO_UPDATE_TABLES.has(tableName) || AUDIT_TABLES.has(tableName))) {
    return ["INSERT", "SELECT"];
  }
  if (NO_DELETE_TABLES.has(tableName)) return ["INSERT", "SELECT", "UPDATE"];
  if (NO_UPDATE_TABLES.has(tableName)) return ["DELETE", "INSERT", "SELECT"];
  return ["DELETE", "INSERT", "SELECT", "UPDATE"];
}

function resolveAdminUrl() {
  if (process.env.DIRECT_URL?.trim()) return process.env.DIRECT_URL.trim();
  const user = process.env.PG_USER?.trim();
  const password = process.env.PG_PASSWORD?.trim();
  const port = process.env.PG_PORT?.trim() || "5433";
  const db = process.env.PG_DB?.trim() || "pamarcy";
  if (user && password) {
    return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@localhost:${port}/${db}?schema=public`;
  }
  if (process.env.DATABASE_URL?.trim()) return process.env.DATABASE_URL.trim();
  throw new Error("Missing DIRECT_URL or PG_USER/PG_PASSWORD in .env.");
}

function resolveAppRoleConfig() {
  const dbUrl = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
  const appUser = assertIdent(
    process.env.PG_APP_USER?.trim() || (dbUrl ? decodeURIComponent(dbUrl.username) : "pamarcy_app"),
    "app role",
  );
  const appPassword = process.env.PG_APP_PASSWORD?.trim() || (dbUrl ? decodeURIComponent(dbUrl.password) : "");
  const dbName = assertIdent(
    process.env.PG_DB?.trim() || dbUrl?.pathname?.replace(/^\//, "") || "pamarcy",
    "database",
  );
  if (appUser === "postgres" || appUser === "root" || appUser === "admin") {
    throw new Error(`Refusing to configure privileged/superuser role "${appUser}" as the least-privilege application role.`);
  }
  return { appUser, appPassword, dbName };
}

function hardenLocalPgHba(adminUser) {
  const hbaPath = path.resolve(process.env.PG_DATA_DIR || ".pgdata", "pg_hba.conf");
  if (!existsSync(hbaPath)) return false;

  const orig = readFileSync(hbaPath, "utf8");
  const lines = orig.split(/\r?\n/);
  let changed = false;

  const updated = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;

    let next = line;
    // Upgrade cleartext `password` authentication to SCRAM-SHA-256
    if (/\bpassword\s*$/.test(next)) {
      next = next.replace(/\bpassword(\s*)$/, "scram-sha-256$1");
    }
    // Restrict replication connections strictly to the admin/superuser role (not `all`)
    if (/^(local|host)\s+replication\s+all\b/.test(trimmed)) {
      next = next.replace(/(replication\s+)all\b/, `$1${adminUser}`);
    }
    if (next !== line) changed = true;
    return next;
  });

  if (changed) {
    writeFileSync(hbaPath, updated.join("\n"), { mode: 0o600 });
  }
  return changed;
}

async function applyPermissions(client, { adminUser, appUser, appPassword, dbName, strictAudit }) {
  if (!appPassword || appPassword.length < 16) {
    throw new Error("PG_APP_PASSWORD (or DATABASE_URL password for app role) must be at least 16 random characters.");
  }

  await client.query(`SET password_encryption = 'scram-sha-256'`);

  // 1. Provision / reconcile least-privilege runtime role with SCRAM-SHA-256 password
  const roleRes = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [appUser]);
  const roleIdent = quoteIdent(appUser);

  const roleAction = roleRes.rowCount === 0 ? "CREATE" : "ALTER";
  await client.query("BEGIN");
  try {
    // Bind parameters safely into transaction-local settings (automatically cleared on COMMIT/ROLLBACK)
    await client.query(
      "SELECT set_config('pamarcy.role_name', $1, true), set_config('pamarcy.role_pw', $2, true)",
      [appUser, appPassword],
    );
    await client.query(`
      DO $$
      BEGIN
        EXECUTE format(
          '${roleAction} ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD %L',
          current_setting('pamarcy.role_name'),
          current_setting('pamarcy.role_pw')
        );
      END $$;
    `);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }

  // Session guardrails on the application role
  await client.query(`ALTER ROLE ${roleIdent} SET statement_timeout = '30s'`);
  await client.query(`ALTER ROLE ${roleIdent} SET idle_in_transaction_session_timeout = '60s'`);
  await client.query(`ALTER ROLE ${roleIdent} SET lock_timeout = '10s'`);
  await client.query(`ALTER ROLE ${roleIdent} SET search_path = 'public'`);

  // 2. Revoke all default PUBLIC privileges
  const dbIdent = quoteIdent(dbName);
  const adminIdent = quoteIdent(adminUser);
  await client.query(`REVOKE ALL ON DATABASE ${dbIdent} FROM PUBLIC`);
  await client.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
  await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC`);
  await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC`);
  await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC`);

  // 3. Grant minimal database & schema access (CONNECT only, USAGE only — NO CREATE, NO TEMPORARY)
  await client.query(`REVOKE ALL ON DATABASE ${dbIdent} FROM ${roleIdent}`);
  await client.query(`GRANT CONNECT ON DATABASE ${dbIdent} TO ${roleIdent}`);
  await client.query(`REVOKE ALL ON SCHEMA public FROM ${roleIdent}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${roleIdent}`);

  // 4. Reset & apply explicit per-table privileges (never TRUNCATE, REFERENCES, TRIGGER)
  await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${roleIdent}`);
  await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${roleIdent}`);
  await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${roleIdent}`);

  const tablesRes = await client.query(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);

  for (const row of tablesRes.rows) {
    const tbl = assertIdent(row.tablename, "table");
    const privs = expectedPrivilegesForTable(tbl, strictAudit);
    if (privs.length > 0) {
      await client.query(`GRANT ${privs.join(", ")} ON TABLE public.${quoteIdent(tbl)} TO ${roleIdent}`);
    }
  }

  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${roleIdent}`);

  // 5. Lock down default privileges for future migrations created by adminUser
  await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${adminIdent} IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC`);
  await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${adminIdent} IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC`);
  await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${adminIdent} IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC`);
  await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${adminIdent} IN SCHEMA public REVOKE ALL ON TABLES FROM ${roleIdent}`);
  await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${adminIdent} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${roleIdent}`);
  await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${adminIdent} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${roleIdent}`);

  // 6. Harden local pg_hba.conf (cleartext password -> scram-sha-256) & reload live PostgreSQL
  const hbaUpdated = hardenLocalPgHba(adminUser);
  if (hbaUpdated) {
    await client.query(`SELECT pg_reload_conf()`);
    console.log("✔ Upgraded .pgdata/pg_hba.conf to scram-sha-256 & reloaded PostgreSQL config");
  }
}

async function verifyPermissions(client, { appUser, dbName, strictAudit }) {
  const failures = [];

  // 1. Role flags
  const roleRes = await client.query(
    `SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls
     FROM pg_roles WHERE rolname = $1`,
    [appUser],
  );
  if (roleRes.rowCount !== 1) {
    failures.push(`Application role "${appUser}" does not exist.`);
  } else {
    const r = roleRes.rows[0];
    if (!r.rolcanlogin) failures.push(`Role "${appUser}" cannot login.`);
    if (r.rolsuper) failures.push(`Role "${appUser}" has SUPERUSER privilege.`);
    if (r.rolcreatedb) failures.push(`Role "${appUser}" has CREATEDB privilege.`);
    if (r.rolcreaterole) failures.push(`Role "${appUser}" has CREATEROLE privilege.`);
    if (r.rolreplication) failures.push(`Role "${appUser}" has REPLICATION privilege.`);
    if (r.rolbypassrls) failures.push(`Role "${appUser}" has BYPASSRLS privilege.`);
    if (r.rolinherit) failures.push(`Role "${appUser}" has INHERIT enabled.`);
  }

  // 2. SCRAM-SHA-256 password hash & pg_hba_file_rules
  const shadowRes = await client.query(`SELECT usename, left(passwd, 14) AS prefix FROM pg_shadow WHERE usename = $1`, [appUser]);
  if (shadowRes.rows[0]?.prefix !== "SCRAM-SHA-256$") {
    failures.push(`Role "${appUser}" password is not hashed with SCRAM-SHA-256.`);
  }
  const hbaRes = await client.query(`SELECT type, database, user_name, auth_method FROM pg_hba_file_rules WHERE error IS NULL`);
  for (const rule of hbaRes.rows) {
    if (rule.auth_method === "password" || rule.auth_method === "trust") {
      failures.push(`pg_hba.conf rule (${rule.type} ${rule.database} ${rule.user_name}) uses insecure auth_method="${rule.auth_method}".`);
    }
    if (Array.isArray(rule.database) && rule.database.includes("replication") && Array.isArray(rule.user_name) && rule.user_name.includes("all")) {
      failures.push(`pg_hba.conf replication rule (${rule.type}) allows user "all" instead of restricting to the privileged role.`);
    }
  }

  // 3. PUBLIC pseudo-role has zero database / schema access
  const pubChecks = await client.query(
    `SELECT
       has_database_privilege('public', $1, 'CONNECT') AS pub_db_connect,
       has_database_privilege('public', $1, 'TEMPORARY') AS pub_db_temp,
       has_database_privilege('public', $1, 'CREATE') AS pub_db_create,
       has_schema_privilege('public', 'public', 'USAGE') AS pub_schema_usage,
       has_schema_privilege('public', 'public', 'CREATE') AS pub_schema_create,
       has_database_privilege($2, $1, 'CONNECT') AS app_db_connect,
       has_database_privilege($2, $1, 'TEMPORARY') AS app_db_temp,
       has_database_privilege($2, $1, 'CREATE') AS app_db_create,
       has_schema_privilege($2, 'public', 'USAGE') AS app_schema_usage,
       has_schema_privilege($2, 'public', 'CREATE') AS app_schema_create`,
    [dbName, appUser],
  );
  const pc = pubChecks.rows[0];
  if (pc.pub_db_connect || pc.pub_db_temp || pc.pub_db_create) failures.push("PUBLIC still holds privileges on database.");
  if (pc.pub_schema_usage || pc.pub_schema_create) failures.push("PUBLIC still holds privileges on schema public.");
  if (!pc.app_db_connect) failures.push(`Role "${appUser}" lacks CONNECT on database.`);
  if (pc.app_db_temp || pc.app_db_create) failures.push(`Role "${appUser}" has excessive DB privileges (TEMPORARY/CREATE).`);
  if (!pc.app_schema_usage) failures.push(`Role "${appUser}" lacks USAGE on schema public.`);
  if (pc.app_schema_create) failures.push(`Role "${appUser}" has DDL CREATE privilege on schema public.`);

  // 4. Table ownership & exact table privileges
  const tablesRes = await client.query(`
    SELECT c.relname AS table_name, pg_get_userbyid(c.relowner) AS owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND n.nspname = 'public'
    ORDER BY c.relname
  `);
  const grantsRes = await client.query(
    `SELECT table_name, array_agg(privilege_type::text ORDER BY privilege_type) AS privs
     FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND grantee = $1
     GROUP BY table_name`,
    [appUser],
  );
  const grantsMap = new Map(grantsRes.rows.map((r) => [r.table_name, r.privs]));

  const pubTableGrants = await client.query(
    `SELECT table_name, privilege_type FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND grantee = 'PUBLIC'`,
  );
  if (pubTableGrants.rowCount > 0) {
    failures.push(`PUBLIC still has grants on ${pubTableGrants.rowCount} table(s) in schema public.`);
  }

  for (const { table_name, owner } of tablesRes.rows) {
    if (owner === appUser) {
      failures.push(`Table "${table_name}" is owned by application role "${appUser}" (must be owned by migration/admin role).`);
    }
    const actual = (grantsMap.get(table_name) ?? []).slice().sort();
    const expected = expectedPrivilegesForTable(table_name, strictAudit).slice().sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures.push(`Table "${table_name}" privileges mismatch: expected [${expected.join(", ")}], got [${actual.join(", ")}].`);
    }
  }

  if (failures.length > 0) {
    console.error("✖ PostgreSQL permissions verification FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log(`✔ PostgreSQL permissions verification PASSED (role="${appUser}", tables=${tablesRes.rowCount}, strictAudit=${strictAudit})`);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const verifyOnly = args.has("--verify");
  const strictAudit = args.has("--strict-audit");

  const adminUrl = resolveAdminUrl();
  const parsedAdmin = new URL(adminUrl);
  const adminUser = assertIdent(decodeURIComponent(parsedAdmin.username), "admin role");
  const { appUser, appPassword, dbName } = resolveAppRoleConfig();

  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    if (!verifyOnly) {
      await applyPermissions(client, { adminUser, appUser, appPassword, dbName, strictAudit });
    }
    await verifyPermissions(client, { appUser, dbName, strictAudit });
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("✖ Database permissions error:", err.message);
  process.exit(1);
});
