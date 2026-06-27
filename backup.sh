#!/usr/bin/env sh
# Anchord backup — logical DB dump + assets tarball.
# Run from the compose project dir:  sh backup.sh
# Cron (daily 03:00):                0 3 * * * cd /opt/anchord && sh backup.sh
#
# Why pg_dump and not a copy of ./data/db: copying Postgres' data dir while the
# server is running can capture an inconsistent state. pg_dump is consistent and
# portable. Assets are static files, so a live tar is fine.
set -eu

OUT="${BACKUP_DIR:-./backups}"
KEEP="${BACKUP_KEEP:-14}"        # how many of each to retain
PGUSER="${POSTGRES_USER:-anchord}"
PGDB="${POSTGRES_DB:-anchord}"
ASSETS="${ASSETS_DATA_DIR:-./data/assets}"

mkdir -p "$OUT"
ts=$(date +%Y%m%d-%H%M%S)

# 1) Database — logical dump over the internal socket (image uses local trust, no password)
docker compose exec -T db pg_dump -U "$PGUSER" -d "$PGDB" | gzip > "$OUT/db-$ts.sql.gz"

# 2) Assets — static files
if [ -d "$ASSETS" ]; then
  tar czf "$OUT/assets-$ts.tgz" -C "$ASSETS" .
else
  echo "warn: assets dir '$ASSETS' not found, skipping (set ASSETS_DATA_DIR if it lives elsewhere)" >&2
fi

# 3) Prune old backups, keep the newest $KEEP of each kind
ls -1t "$OUT"/db-*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
ls -1t "$OUT"/assets-*.tgz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f

echo "ok: $OUT/db-$ts.sql.gz${ASSETS:+ + $OUT/assets-$ts.tgz}"
echo "push $OUT off this box (S3/rsync) — a backup on the same VM dies with the VM."

# Restore (manual):
#   gunzip -c backups/db-YYYYMMDD-HHMMSS.sql.gz | docker compose exec -T db psql -U anchord -d anchord
#   tar xzf backups/assets-YYYYMMDD-HHMMSS.tgz -C ./data/assets
