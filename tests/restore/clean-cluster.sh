#!/usr/bin/env bash
# DR-1: independently restore B-002 roles and database into a new PostgreSQL 16 cluster.
# Disposable CI only. No shared/production clusters. The target is never bootstrapped
# or migrated: recovered objects and ACLs must come from the dump.
set -Eeuo pipefail
[[ "${CI:-}" == "true" ]] || { echo "DR-1 requires CI=true" >&2; exit 1; }
[[ "${SI_PRODUCTION:-}" != "1" ]] || { echo "DR-1 refuses production mode" >&2; exit 1; }
command -v docker >/dev/null
command -v cmp >/dev/null
command -v sha256sum >/dev/null
[[ "${SI_TEST_PGHOST:-127.0.0.1}" == "127.0.0.1" ]] || { echo "DR-1 requires 127.0.0.1 test host" >&2; exit 1; }
[[ "${SI_TEST_PGPORT:-54329}" == "54329" ]] || { echo "DR-1 requires source test port 54329" >&2; exit 1; }
[[ "${SI_TEST_DB_PASSWORD:-local-test-only}" == "local-test-only" ]] || { echo "DR-1 requires disposable CI test password" >&2; exit 1; }

image='postgres:16.15@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94'
source_id="$(docker compose ps -q db)"
[[ -n "$source_id" ]] || { echo "DR-1 source compose container not found" >&2; exit 1; }
[[ "$(docker inspect -f '{{.State.Running}}' "$source_id")" == "true" ]] || exit 1
name="si-dr1-${GITHUB_RUN_ID:-local}-$$"
tmp="$(mktemp -d)"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$tmp"
  echo 'DR-1 cleanup: target container and temporary dumps removed'
}
trap cleanup EXIT
export PGPASSWORD=local-test-only

src() { docker exec -e PGPASSWORD=local-test-only "$source_id" "$@"; }
dst() { docker exec -e PGPASSWORD=local-test-only "$name" "$@"; }
source_sql() { src psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U si_bootstrap -d si_template_test -At -c "$1"; }
target_sql() { dst psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U si_restore_admin -d si_template_test -At -c "$1"; }

# Apply D5b only to CI's disposable source after all baseline/mutation tests.
# This is a restore test fixture, NOT a production hardening decision.
docker exec -i -e PGPASSWORD=local-test-only "$source_id" \
  psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U si_bootstrap -d si_template_test \
  < db/bootstrap/optional/advisory-lock-hardening.sql > "$tmp/hardening.out"
echo 'DR-1 source D5b test fixture applied (disposable source only)'

src pg_dumpall -h 127.0.0.1 -U si_bootstrap --globals-only --no-role-passwords > "$tmp/globals.sql"
src pg_dump -h 127.0.0.1 -U si_bootstrap -d si_template_test -Fc --create > "$tmp/database.dump"
[[ -s "$tmp/globals.sql" && -s "$tmp/database.dump" ]] || { echo 'DR-1 empty backup' >&2; exit 1; }
echo 'DR-1 globals and database archive created; content and password hashes withheld'

docker run -d --name "$name" \
  -p 127.0.0.1:54330:5432 \
  --tmpfs /var/lib/postgresql/data:rw \
  -e POSTGRES_DB=postgres -e POSTGRES_USER=si_restore_admin \
  -e POSTGRES_PASSWORD=local-test-only \
  -e 'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=scram-sha-256 -E UTF8' \
  "$image" postgres -c track_commit_timestamp=on -c fsync=off >/dev/null
ready=0
for i in {1..40}; do
  if dst pg_isready -h 127.0.0.1 -U si_restore_admin -d postgres >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[[ "$ready" == "1" ]] || { echo 'DR-1 target not ready' >&2; exit 1; }

source_sysid="$(src pg_controldata /var/lib/postgresql/data | sed -n 's/^Database system identifier: *//p')"
target_sysid="$(dst pg_controldata /var/lib/postgresql/data | sed -n 's/^Database system identifier: *//p')"
[[ -n "$source_sysid" && -n "$target_sysid" && "$source_sysid" != "$target_sysid" ]] || {
  echo 'DR-1 distinct cluster system identifiers not established' >&2; exit 1;
}
echo 'DR-1 independent PostgreSQL cluster identifiers: DIFFERENT'

# A clean cluster has a different bootstrap superuser. PostgreSQL 16
# includes the original membership grantor in pg_dumpall output. Rewrite
# ONLY the expected owner-to-migrator grantor for the recovery operator;
# require exactly one matching grant and preserve all membership flags.
python3 - "$tmp/globals.sql" "$tmp/globals-restorable.sql" <<'PY'
import pathlib
import re
import sys

source = pathlib.Path(sys.argv[1]).read_text()
pattern = re.compile(
    r"^(GRANT\s+si_owner\s+TO\s+si_migrator\s+WITH\s+"
    r"INHERIT\s+FALSE\s*,\s*SET\s+TRUE\s*,\s*ADMIN\s+FALSE\s+"
    r"GRANTED\s+BY\s+)si_bootstrap(\s*;)\s*$",
    re.IGNORECASE | re.MULTILINE,
)
matches = list(pattern.finditer(source))
if len(matches) != 1:
    raise SystemExit(f"DR-1 unexpected membership grant count/format: {len(matches)}")
updated = pattern.sub(r"\\g<1>si_restore_admin\\g<2>", source, count=1)
pathlib.Path(sys.argv[2]).write_text(updated)
print("DR-1 normalized exactly one membership grantor for recovery")
PY
docker exec -i -e PGPASSWORD=local-test-only "$name" \
  psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U si_restore_admin -d postgres \
  < "$tmp/globals-restorable.sql" > "$tmp/globals-restore.out"
echo 'DR-1 global roles/settings/memberships restored'
docker exec -i -e PGPASSWORD=local-test-only "$name" \
  pg_restore --exit-on-error -h 127.0.0.1 -U si_restore_admin -d postgres --create \
  < "$tmp/database.dump" > "$tmp/db-restore.out"
echo 'DR-1 database archive restored without bootstrap or migrations'

for role in si_collector si_rights_admin si_retention si_monitor si_migrator; do
  dst psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U si_restore_admin -d postgres \
    -c "ALTER ROLE $role PASSWORD 'local-test-only'" > /dev/null
done
echo 'DR-1 test-only login passwords re-provisioned (not restored from dump)'

for mode in source target; do
  if [[ "$mode" == source ]]; then sql=source_sql; else sql=target_sql; fi
  [[ "$($sql 'SHOW server_version_num')" == 16* ]] || { echo "DR-1 $mode wrong PG major" >&2; exit 1; }
  [[ "$($sql 'SHOW track_commit_timestamp')" == on ]] || { echo "DR-1 $mode commit timestamps disabled" >&2; exit 1; }
done
echo 'DR-1 both servers PostgreSQL 16, track_commit_timestamp=on'

# Cluster-level attributes and membership; exclude target's independent operator.
role_inventory="SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls, coalesce(array_to_string(rolconfig, ','),'') FROM pg_roles WHERE rolname LIKE 'si_%' AND rolname <> 'si_restore_admin' ORDER BY rolname"
member_inventory="SELECT pg_get_userbyid(roleid), pg_get_userbyid(member), admin_option, inherit_option, set_option FROM pg_auth_members WHERE roleid='si_owner'::regrole ORDER BY 1,2,3,4,5"
source_sql "$role_inventory" > "$tmp/source-roles"
target_sql "$role_inventory" > "$tmp/target-roles"
cmp "$tmp/source-roles" "$tmp/target-roles"
source_sql "$member_inventory" > "$tmp/source-members"
target_sql "$member_inventory" > "$tmp/target-members"
cmp "$tmp/source-members" "$tmp/target-members"
[[ "$(target_sql "$member_inventory")" == 'si_owner|si_migrator|f|f|t' ]] || {
  echo 'DR-1 unexpected owner membership' >&2; exit 1;
}
echo 'DR-1 cluster roles, session settings and exclusive owner membership MATCH'

# Dump the restored schema again and compare schema/ACL serialization.
# Avoid owner SQL because target's recovery superuser is intentionally different.
src pg_dump -h 127.0.0.1 -U si_bootstrap -d si_template_test \
  --schema-only --no-owner > "$tmp/source-schema.sql"
dst pg_dump -h 127.0.0.1 -U si_restore_admin -d si_template_test \
  --schema-only --no-owner > "$tmp/target-schema.sql"
# Ignore non-semantic pg_dump guard tokens, if present in newer client versions.
sed -i '/^\\restrict /d; /^\\unrestrict /d; /^-- Dumped on /d' "$tmp/source-schema.sql" "$tmp/target-schema.sql"
if ! cmp -s "$tmp/source-schema.sql" "$tmp/target-schema.sql"; then
  echo 'DR-1 restored schema / ACL dump mismatch' >&2
  diff -u "$tmp/source-schema.sql" "$tmp/target-schema.sql" | head -70 >&2 || true
  exit 1
fi
echo 'DR-1 schema, migration objects, grants, default ACLs and D5b function ACLs MATCH'

# Actual restored-cluster operational preflight and role privilege probes.
SI_DATABASE_URL='postgresql://si_restore_admin:local-test-only@127.0.0.1:54330/si_template_test' \
  node dist/persistence/cli.js preflight --production
echo 'DR-1 restored production-mode D5b/D7 preflight PASS (disposable target only)'
SI_TEST_PGHOST=127.0.0.1 SI_TEST_PGPORT=54330 SI_TEST_ADMIN_USER=si_restore_admin \
  SI_TEST_ADMIN_PASSWORD=local-test-only SI_TEST_ROLE_PASSWORD=local-test-only \
  SI_TEST_TEMPLATE=si_template_test \
  node --test tests/db/privileges.test.mjs
echo 'DR-1 restored role privileges regression PASS'
echo 'DR-1 RESULT: PASS (fresh-cluster logical restore and security checks)'
