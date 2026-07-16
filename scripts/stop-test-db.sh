#!/usr/bin/env bash
set -euo pipefail
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PGDATA=/tmp/eventreg-pg/data
if sudo -u postgres "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
  sudo -u postgres "$PGBIN/pg_ctl" -D "$PGDATA" -w stop
fi
echo "Postgres stopped"
