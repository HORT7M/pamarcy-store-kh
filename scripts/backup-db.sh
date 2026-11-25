#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; source .env; set +a; fi
mkdir -p -m 700 backups
STAMP=$(date +"%Y%m%d-%H%M%S")
if command -v pg_dump >/dev/null 2>&1; then
  OUT="backups/pamarcy-${STAMP}.sql.gz"
  pg_dump "${DATABASE_URL%\?*}" --no-owner --no-privileges | gzip > "$OUT"
  chmod 600 "$OUT"
  echo "✔ pg_dump backup saved to $OUT"
else
  node --env-file-if-exists=.env scripts/backup-db.mjs
fi
# Keep last 14 backups
ls -1t backups/pamarcy* 2>/dev/null | tail -n +15 | xargs -r rm -f
