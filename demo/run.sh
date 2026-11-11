#!/usr/bin/env bash
# Shop Intelligence M3-P3D: run the synthetic lifecycle demonstration against a fresh disposable
# PostgreSQL 16.15 container (the pinned image of compose.yaml), then remove it.
#   bash demo/run.sh                         full demonstration (includes the ~7.5 min real-deadline scenario)
#   DEMO_SKIP_DEADLINE=1 bash demo/run.sh    quick run without the real-deadline INVALID scenario
#   DEMO_MUTANT=grant|retention|verdict ...  negative control: the demonstration must FAIL
# The report (counts, codes, timings only) is written to $DEMO_REPORT (default: ./demo-report.json).
#   DEMO_PROGRAM=demo/intelligence.mjs bash demo/run.sh   M4-P1 synthetic advertiser intelligence demonstration
# No production credentials: the superuser and role passwords are random per run and never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
img='postgres:16.15@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94'
name="si-demo-${GITHUB_RUN_ID:-local}-$$-${RANDOM}"
admin_pw="$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"
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
echo "DEMO environment: PostgreSQL $(docker exec -e PGPASSWORD="$admin_pw" "$name" psql -h 127.0.0.1 -U si_bootstrap -d postgres -Atc 'SHOW server_version'), container ${name} (removed on exit)"
DEMO_PGPORT="$port" DEMO_ADMIN_PASSWORD="$admin_pw" DEMO_CONTAINER="$name" \
  DEMO_REPORT="${DEMO_REPORT:-$PWD/demo-report.json}" DEMO_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)" \
  node "${DEMO_PROGRAM:-demo/lifecycle.mjs}"
