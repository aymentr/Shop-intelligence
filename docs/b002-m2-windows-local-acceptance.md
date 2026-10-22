# B-002 M2 Step 2 — Windows local acceptance and D5b decision guide

This guide is **not** evidence that the commands have been executed. The frozen plan (`docs/b002-m2-plan.md` §8) requires **three consecutive local PostgreSQL 16 runs AND CI**. CI cannot substitute for the local runs without an explicit amendment.

## Windows prerequisites

- Windows 10/11 with PowerShell 7 or Windows PowerShell 5.1.
- Node.js 22 LTS, Git, and Docker Desktop with WSL2 backend (Linux containers).
- Docker Desktop running; sufficient disk space for disposable PostgreSQL volumes.
- Work in a fresh checkout of `codex/b002-m2-acceptance`; no shared PostgreSQL credentials.
- Confirm `docker compose version`, `node --version`, `npm --version` and `git rev-parse HEAD`.

The repository's `compose.yaml` exposes PostgreSQL on loopback and `tests/db/run.mjs` refuses non-loopback or non-`*_test` targets. Nevertheless, use a dedicated Docker context, ensure the compose project name is unique, and do **not** reuse existing volumes.

## Local run protocol (PowerShell)

```powershell
git switch codex/b002-m2-acceptance
git pull --ff-only
git rev-parse HEAD
node --version
docker compose version
$env:COMPOSE_PROJECT_NAME = "si_m2_acceptance_local"
docker compose up -d --wait db
try {
  npm ci
  npm run typecheck
  npm test
  npm run demo
  for ($i = 1; $i -le 3; $i++) {
    $started = Get-Date -Format o
    Write-Host "LOCAL PASS $i START $started"
    npm run test:db
    if ($LASTEXITCODE -ne 0) { throw "Local database acceptance pass $i failed" }
    Write-Host "LOCAL PASS $i FINISH $(Get-Date -Format o)"
  }
} finally {
  docker compose down -v
  Remove-Item Env:COMPOSE_PROJECT_NAME -ErrorAction SilentlyContinue
}
```

Save the terminal transcript (e.g. `Start-Transcript .\step2-local-acceptance.log` before starting, `Stop-Transcript` after). Record Docker image digest, PostgreSQL version via `docker compose exec db psql -U <configured-user> -d postgres -c "SHOW server_version;"`, commit SHA, three independent pass counts and timestamps. Never upload passwords or connection strings in logs.

**Do not run `docker compose down -v` against an existing or shared compose project.** The dedicated project name is intended to make cleanup safe, but verify the target before executing.

## D5b: hosting compatibility and founder authorization

Proposed policy: production is blocked unless PUBLIC and application roles have **no effective EXECUTE** on the 21 PostgreSQL advisory-lock functions, while `si_owner` and `si_migrator` retain only the intended lock capabilities. This is not yet authorized.

Ask the chosen PostgreSQL hosting provider:

1. Is PostgreSQL **16** available with `track_commit_timestamp=on`, `max_prepared_transactions=0`, `synchronous_standby_names=''` and default READ COMMITTED?
2. Can a trusted operator **own or alter privileges** of all relevant `pg_catalog.pg_(try_)advisory*` functions? A typical managed-service pseudo-superuser may **not**.
3. Can the operator revoke PUBLIC EXECUTE, remove explicit grants, and verify effective access including inherited memberships **in each database**?
4. Can bootstrap/migration use separate `si_migrator` and `si_owner` roles with tightly scoped `SET ROLE`?
5. Can every API, worker and migration entry point be made to fail closed by deployment policy **without depending on an optional environment variable**?
6. Can the platform support independently restoring cluster-global roles, membership options and required PostgreSQL configuration in disaster recovery?

**Founder decision required:** Approve D5b as mandatory, fail-closed policy *only after* provider capability is verified; alternatively select infrastructure with the required permissions, or explicitly commission a redesigned advisory-lock architecture and new acceptance testing. Do not silently weaken the policy. Do not apply the optional hardening script on a shared or production cluster without explicit approval.

## Clean-cluster restoration requirement (still unexecuted)

A fresh PostgreSQL 16 **cluster** is required, not merely `CREATE DATABASE` in an existing cluster. The test must independently restore `pg_dumpall --globals-only`-equivalent roles and membership options, database dump, pg_catalog ACLs and PostgreSQL configuration. Re-run bootstrap/migrations and compare sanitized `pg_roles`, `pg_auth_members`, `pg_namespace`, `pg_proc`, `pg_default_acl` and `pg_init_privs` catalogs. Restore must be performed in a second disposable cluster with isolated data directory and container/volume identity, and cleanup must target only those disposable resources. No such end-to-end result is yet claimed.
