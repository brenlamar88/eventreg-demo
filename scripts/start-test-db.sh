#!/usr/bin/env bash
# Start a throwaway local PostgreSQL 16 cluster for tests.
# Postgres refuses to run as root, so the cluster runs as the `postgres` OS user.
# CI can skip this and point DATABASE_URL_ADMIN at a service container instead.
set -euo pipefail

PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
ROOT=/tmp/eventreg-pg
PGDATA="$ROOT/data"
PGSOCK="$ROOT/sock"
PGPORT="${PGPORT:-55432}"

mkdir -p "$ROOT"
chown -R postgres:postgres "$ROOT"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  sudo -u postgres "$PGBIN/initdb" -D "$PGDATA" -A trust -U postgres >"$ROOT/initdb.log" 2>&1
fi

if ! sudo -u postgres "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
  mkdir -p "$PGSOCK"; chown postgres:postgres "$PGSOCK"
  sudo -u postgres "$PGBIN/pg_ctl" -D "$PGDATA" \
    -o "-p $PGPORT -k $PGSOCK -c listen_addresses=127.0.0.1" \
    -l "$ROOT/server.log" -w start
fi

echo "Postgres 16 up on 127.0.0.1:$PGPORT"
echo "  admin url: postgres://postgres@127.0.0.1:$PGPORT/postgres"
