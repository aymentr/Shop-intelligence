# B-002 persistence — Milestone 1: PostgreSQL foundation

Status: **Milestone 1 only.** Migration 0001 (sources, versioned rights, evidence),
roles, bootstrap, migration runner and integration tests. Not production-ready.
Specification: the frozen B-002 design (revision 2.1 + Amendment A + Amendment B + IA-1).
Deviations are listed at the end.

## How the pieces fit

```
operator / CI ──► cli.js bootstrap ──► db/bootstrap/roles.sql      (cluster: 5 roles + session limits)
                                  └──► db/bootstrap/database.sql   (this DB: schema si, ACLs, default privileges)
              ──► cli.js up/down  ──► src/persistence/migrate.ts ──► db/migrations/NNNN_*.sql
application   ──► assertSchemaVersion() (refuses to run against the wrong schema version)
```

### Roles (who can do what)

| Role | Login | Purpose in M1 | Can write |
| --- | --- | --- | --- |
| `si_owner` | no | Owns every object in schema `si`. Migrations `SET ROLE` to it. | everything (DDL) — never used by the app |
| `si_collector` | yes | Reads sources/rights; calls `rights_valid_for_publish` | nothing yet (runs/observations arrive in M2/M3) |
| `si_rights_admin` | yes | Records rights versions; retires sources | only via `si.si_record_rights_version()`; `UPDATE sources (retired_at, conflict_policy)` |
| `si_retention` | yes | Reads metadata (deletion procedures arrive in M4) | nothing yet |
| `si_monitor` | yes | Reads schema version (health functions arrive in M4) | nothing |

Nothing is granted to `PUBLIC`: no CONNECT, no TEMP, no CREATE on `public` or `si`, and no
EXECUTE on any function. Every privilege is listed in `tests/db/privileges.test.mjs` and the
test fails if the database has one more or one fewer.

### Why roles are created outside migrations

Roles are cluster-wide, and hosted PostgreSQL often denies `CREATEROLE` to the migration
user. Bootstrap is idempotent: running it twice changes nothing (test M5).

### The migration runner (`src/persistence/migrate.ts`)

- **One transaction per migration**, holding `pg_advisory_xact_lock` (key `0x5349004d49470001`).
  Two runners started together: one applies, the other waits, then finds nothing to do (test M3).
- **Runs as `si_owner`** (`SET LOCAL ROLE`), so the app roles never own anything.
- **`search_path = pg_catalog, pg_temp`** while migrating: an unqualified `CREATE TABLE foo`
  fails instead of landing in an unexpected schema (test "unqualified object names").
- **Checksums**: `si.schema_migrations` stores SHA-256 of both the up and down file. Editing an
  applied file, deleting one, or a gap in history stops everything (tests M2, "order").
- **Atomic**: a migration that fails half-way leaves nothing behind, not even its history row.
- **Down** requires `--allow-destructive` and refuses while any non-SYNTHETIC source exists (M4).
- **`assertSchemaVersion()`** is for application start-up (M2+): refuses a database whose
  version differs from the code's.

## Migration 0001 — what the database itself enforces

| Rule | Mechanism | Test |
| --- | --- | --- |
| Only synthetic sources | `CHECK (evidence_kind IN ('SYNTHETIC'))` | R3 |
| Networks from a fixed list, no NULLs, 1-D | `CHECK` on `supported_networks` | CHECK test |
| Customer actions (subscriber display, media mirror, export) can never be ALLOWED | `CHECK` on three columns | R4 |
| Rights are append-only (incl. TRUNCATE, incl. owner and superuser sessions) | `trg_append_only` row + statement triggers | R1 |
| Versions dense (1, 2, 3 …) per source | `trg_rights_insert` under a `FOR UPDATE` lock on the source row + `UNIQUE (source_id, version)` | R6, concurrency |
| No backdating; effective_from never earlier than the previous version's | `trg_rights_insert` reads `clock_timestamp()` *after* taking the source lock | A8, ordering |
| Any ALLOWED cites evidence; synthetic needs a `SYNTHETIC_DECLARATION` | deferred constraint trigger, checked at COMMIT | R2, R3 |
| Attribution cannot be forged | triggers overwrite `recorded_by` with `session_user` | attribution |
| Retirement is final once passed | `trg_sources_retire_final` | RR8 |
| Rights writes only through one audited function | no INSERT grant; `si_record_rights_version` is SECURITY DEFINER | G1, SD1, SD3 |
| IA-1 (prepared) | `UNIQUE (rights_version_id, source_id)` — the target the M2 composite FK will reference | IA-1 prerequisite |

### Functions

| Function | Kind | Who may call | What it answers |
| --- | --- | --- | --- |
| `si_record_rights_version(...)` | SECURITY DEFINER, VOLATILE | `si_rights_admin` | Inserts one version + its evidence in one call |
| `rights_valid_for_publish(version, at)` | INVOKER, STABLE | `si_collector` | Was this version valid at `at`, with 60 s to spare? (strict) |
| `si_window_end(version)` | INVOKER, STABLE | `si_collector` | When does this version stop applying (expiry or next version)? |
| `si_publish_margin()` | INVOKER, IMMUTABLE | `si_collector` | 60 seconds |
| `si_retention_end(source, version)` | INVOKER, STABLE | nobody (owner-only; used by M3/M4 definer functions) | Amendment B: when does data collected under this version stop being retainable? |

Every function: owner `si_owner`, `SET search_path = pg_catalog, pg_temp`, EXECUTE revoked
from PUBLIC (test SD1 checks all of these in the catalog).

## Running it

```bash
docker compose up -d --wait db     # PostgreSQL 16.15 on 127.0.0.1:54329, tmpfs, dev-only password
npm ci
npm run test:db                    # bootstrap roles, rebuild template DB, run tests/db/*.test.mjs
```

The test runner refuses to touch anything except a loopback server and databases whose names
end in `_test`. Each test file gets its own database (cloned from a migrated template, or built
from scratch for migration tests) and drops it afterwards. Concurrency tests use separate
connections and prove blocking with `pg_blocking_pids()` from a third connection.

Operator commands (connection string only from `SI_DATABASE_URL`):

```bash
npm run build
SI_ROLE_PASSWORD=... npm run db:bootstrap
npm run db:migrate
npm run db:status
node dist/persistence/cli.js down --to 0 --allow-destructive
```

## Deviations from the frozen design (recorded, not silently applied)

1. **Default privileges statement (Amendment A4 item 4).** The frozen text
   `ALTER DEFAULT PRIVILEGES FOR ROLE si_owner IN SCHEMA si REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`
   is accepted by PostgreSQL but has **no effect**: schema-scoped default privileges can only add
   to the global defaults. Test SD5 failed with it. Implemented as the role-wide form
   (`ALTER DEFAULT PRIVILEGES FOR ROLE si_owner REVOKE …`), which achieves the intent. The test
   fails again if the frozen form is restored (verified by mutation).
2. **Schema comparison for M1 uses a catalog fingerprint, not `pg_dump --schema-only`.**
   Same coverage plus owners and ACLs, without coupling CI to a `pg_dump` binary version.
3. **Bootstrap is run by the test runner / CLI, not via `/docker-entrypoint-initdb.d`.**
   Login passwords come from the environment, not from the container image.
4. **Hardening beyond the text** (stricter, no rule weakened): TEMP and CONNECT revoked from
   PUBLIC; attribution columns overwritten from `session_user` by triggers rather than only
   defaulted; `schema_migrations` also stores the down-file checksum.

## Finding for a founder decision (not changed)

**An immediate revocation is impossible while a future-dated version is pending.** 2.1 requires
each version's `effective_from` to be no earlier than the previous version's. Once, say, a
re-grant is scheduled for next week, any new version (including an urgent revocation) must take
effect no earlier than next week. Source retirement (immediate, final) still stops all use.
Test `FINDING: …` documents the current behaviour.

## Limitations (Milestone 1)

- A PostgreSQL superuser or the table owner can disable triggers, set
  `session_replication_role = replica`, or drop constraints. That access is reserved for migrations.
- `DROP TABLE` is not blocked by the append-only triggers (they guard data, not DDL).
- The dev password in `compose.yaml` and the test helpers is a placeholder for local/CI use only.
- The server clock is trusted (NTP with slewing is an operational requirement).
- Nothing here collects, reads or deletes ad content yet; those paths and their guarantees
  arrive in Milestones 2–4.
