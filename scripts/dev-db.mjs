// Starts a local PostgreSQL server (real Postgres binaries via `embedded-postgres`)
// for machines without a system PostgreSQL / Docker. Usage: npm run db:start
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import path from "node:path";

if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}

function resolvePgCredentials() {
  const dbUrl = (process.env.DIRECT_URL || process.env.DATABASE_URL) ? new URL(process.env.DIRECT_URL || process.env.DATABASE_URL) : null;
  const user = process.env.PG_USER || (dbUrl ? decodeURIComponent(dbUrl.username) : "");
  const password = process.env.PG_PASSWORD || (dbUrl ? decodeURIComponent(dbUrl.password) : "");
  const port = Number(process.env.PG_PORT || dbUrl?.port || 5433);
  const dbName = process.env.PG_DB || dbUrl?.pathname?.replace(/^\//, "") || "pamarcy";
  if (!user || !password) {
    throw new Error("Missing PostgreSQL credentials. Set DATABASE_URL or PG_USER / PG_PASSWORD in .env.");
  }
  return { user, password, port, dbName };
}

const { user, password, port, dbName } = resolvePgCredentials();
const dataDir = path.resolve(process.env.PG_DATA_DIR || ".pgdata");
const firstRun = !existsSync(path.join(dataDir, "PG_VERSION"));

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user,
  password,
  port,
  authMethod: "scram-sha-256",
  persistent: true,
  onLog: () => {},
});

if (firstRun) await pg.initialise();
await pg.start();
if (firstRun) {
  await pg.createDatabase(dbName);
}
console.log(`PostgreSQL running → postgresql://${user}:****@localhost:${port}/${dbName}`);
console.log("Press Ctrl+C to stop.");

const stop = async () => { await pg.stop(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
