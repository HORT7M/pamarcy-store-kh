#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; source .env; set +a; fi
if [ -z "${BACKUP_ENCRYPTION_KEY:-}" ]; then
  echo "ERROR: BACKUP_ENCRYPTION_KEY must be set in .env (e.g. openssl rand -hex 32)" >&2
  exit 1
fi
mkdir -p -m 700 backups
STAMP=$(date +"%Y%m%d-%H%M%S")
if command -v pg_dump >/dev/null 2>&1; then
  OUT="backups/pamarcy-${STAMP}.sql.gz.enc"
  # Pass PostgreSQL credentials strictly via environment variables (never in CLI argv / ps aux)
  # and stream directly through gzip and AES-256-GCM encryption; never writes plaintext SQL to disk.
  node -e '
    const { spawnSync } = require("node:child_process");
    const u = new URL(process.env.DIRECT_URL || process.env.DATABASE_URL);
    const pgEnv = {
      ...process.env,
      PGHOST: u.hostname,
      PGPORT: u.port || "5432",
      PGUSER: decodeURIComponent(u.username || ""),
      PGPASSWORD: decodeURIComponent(u.password || ""),
      PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, "")),
    };
    const sslmode = u.searchParams.get("sslmode");
    if (sslmode) pgEnv.PGSSLMODE = sslmode;
    const cmd = `pg_dump --no-owner --no-privileges | gzip | node --env-file-if-exists=.env scripts/backup-encrypt.mjs encrypt sql.gz "$1"`;
    const r = spawnSync("bash", ["-euo", "pipefail", "-c", cmd, "_", process.argv[1]], { env: pgEnv, stdio: "inherit" });
    process.exit(r.status ?? 1);
  ' "$OUT"
  chmod 600 "$OUT"
  echo "✔ Encrypted pg_dump backup saved to $OUT"
else
  node --env-file-if-exists=.env scripts/backup-db.mjs
fi
# Keep last 14 encrypted backups
ls -1t backups/pamarcy*.enc 2>/dev/null | tail -n +15 | xargs -r rm -f
