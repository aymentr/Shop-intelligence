#!/usr/bin/env bash
# Shop Intelligence DEMO-V1: the local interface on a fresh disposable PostgreSQL 16.15 container (the pinned image of
# compose.yaml). The container lives in tmpfs and is removed when the app stops (Ctrl+C). SYNTHETIC DATA ONLY.
#   npm run app                      build, start the container, seed, serve http://127.0.0.1:4173/
#   SI_APP_PORT=8080 npm run app     another HTTP port (still 127.0.0.1 only)
# The superuser and role passwords are random per run and never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
img='postgres:16.15@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94'
name="si-demo-app-$$-${RANDOM}"
admin_pw="$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"
command -v docker >/dev/null || { echo 'DEMO-V1 needs Docker (for the disposable PostgreSQL container)' >&2; exit 1; }
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name "$name" -p 127.0.0.1::5432 --tmpfs /var/lib/postgresql/data:rw \
  -e POSTGRES_DB=postgres -e POSTGRES_USER=si_bootstrap -e POSTGRES_PASSWORD="$admin_pw" \
  -e 'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=scram-sha-256 -E UTF8' \
  "$img" postgres -c track_commit_timestamp=on >/dev/null
port="$(docker port "$name" 5432/tcp | sed -n '1s/.*://p')"
[[ "$port" =~ ^[0-9]+$ ]] || { echo 'DEMO port not assigned' >&2; exit 1; }
for i in $(seq 1 60); do
  docker exec -e PGPASSWORD="$admin_pw" "$name" psql -h 127.0.0.1 -U si_bootstrap -d postgres -Atc 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done
echo "DEMO-V1: PostgreSQL $(docker exec -e PGPASSWORD="$admin_pw" "$name" psql -h 127.0.0.1 -U si_bootstrap -d postgres -Atc 'SHOW server_version' | cut -d' ' -f1) in disposable container ${name} (removed on exit)"
SI_APP_PGHOST=127.0.0.1 SI_APP_PGPORT="$port" SI_APP_ADMIN_PASSWORD="$admin_pw" node app/dist/main.js
