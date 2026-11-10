#!/usr/bin/env bash
# M3-P3B VR-12: on a disposable PostgreSQL 16.15 server started with track_commit_timestamp = off,
# the verifier refuses without recording anything and the gates fail closed. Bound to 127.0.0.1 on a
# Docker-assigned port; tmpfs data; removed on exit. Test-only passwords, as in compose.yaml.
set -euo pipefail
cd "$(dirname "$0")/../.."
img='postgres:16.15@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94'
name="si-commit-ts-off-${GITHUB_RUN_ID:-local}-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$name" -p 127.0.0.1::5432 --tmpfs /var/lib/postgresql/data:rw \
  -e POSTGRES_DB=si_test -e POSTGRES_USER=si_bootstrap -e POSTGRES_PASSWORD=local-test-only \
  -e 'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=scram-sha-256 -E UTF8' \
  "$img" postgres -c track_commit_timestamp=off -c fsync=off >/dev/null
port="$(docker port "$name" 5432/tcp | sed -n '1s/.*://p')"
[[ "$port" =~ ^[0-9]+$ ]] || { echo 'VR-12 port not assigned' >&2; exit 1; }
for i in $(seq 1 60); do
  docker exec -e PGPASSWORD=local-test-only "$name" psql -h 127.0.0.1 -U si_bootstrap -d si_test -Atc 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done
SI_TEST_PGPORT="$port" SI_EXPECT_COMMIT_TS_OFF=1 node tests/db/run.mjs tests/slow/commit-ts-off.test.mjs
echo 'VR-12 RESULT: PASS (verification refuses with commit timestamps disabled)'
