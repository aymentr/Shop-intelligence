# B-002 persistence — Milestone 1: PostgreSQL foundation

Status: **Milestone 1 only.** Migration 0001 (sources, versioned rights, evidence, and the
Amendment C source controls), roles, bootstrap, migration runner and integration tests.
Not production-ready.
Specification: the frozen B-002 design (revision 2.1 + Amendment A + Amendment B + IA-1)
plus Amendment C with Revisions 1–3 (accepted 2026-10-20). Deviations are listed at the end.

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
| `si_rights_admin` | yes | Records rights versions and source controls; retires sources | only via `si.si_record_rights_version()` and `si.si_record_source_control()`; `UPDATE sources (retired_at, conflict_policy)` |
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
| Source controls are append-only, immediate-only, dense per source | `trg_source_controls_insert` (lock, then read; seq, `occurred_at`, `through_version`, attribution computed) + append-only triggers; the write function has no time parameter | CP2, CP3, CC6 |
| SUSPEND / TERMINATE_RETENTION deny at commit, whatever versions are scheduled | `rights_valid_for_publish` adds `NOT si_source_suspended(...)` and `NOT si_retention_terminated(...)` — latest committed state, no time filter | C1–C4, C6, CC1′–CC4′, CK1 |
| LIFT is compare-and-set on rights version **and** control sequence | trigger raises `SI_STALE_VIEW` | CP4, LC1–LC4, CC5′ |
| LIFT after a termination needs acknowledgement + a valid new authorization | `SI_TERMINATION_ACK_REQUIRED`, `SI_AUTHORIZATION_REQUIRED` | C6, LR1, LR2, LC2 |
| Termination is irreversible for covered versions (pending ones included) | `through_version = max(version)`; `si_retention_end` and `si_window_end` gain an unconditional termination term | C4, LR2, CC3′, parity |
| Controls only under READ COMMITTED | `SI_ISOLATION` in the function and the trigger | LI1 |
| A backward clock step never blocks a restriction and never relaxes anything | SUSPEND / TERMINATE_RETENTION record `occurred_at = greatest(clock, previous occurred_at)` and the real reading in `wall_clock_at`; LIFT is refused (`SI_CLOCK_REGRESSION`) until the clock catches up | CK1, CK4, CK5 |

### Functions

| Function | Kind | Who may call | What it answers |
| --- | --- | --- | --- |
| `si_record_rights_version(...)` | SECURITY DEFINER, VOLATILE | `si_rights_admin` | Inserts one version + its evidence in one call |
| `rights_valid_for_publish(version, at)` | INVOKER, STABLE | `si_collector` | Was this version valid at `at`, with 60 s to spare? (strict) |
| `si_window_end(version)` | INVOKER, STABLE | `si_collector` | When does this version stop applying (expiry or next version)? |
| `si_publish_margin()` | INVOKER, IMMUTABLE | `si_collector` | 60 seconds |
| `si_retention_end(source, version)` | INVOKER, STABLE | nobody (owner-only; used by M3/M4 definer functions) | Amendment B (+ C termination term): when does data collected under this version stop being retainable? |
| `si_record_source_control(source, kind, reason, reference, expected_max_version, expected_control_seq, ack_termination_seq, authorization_version)` | SECURITY DEFINER, VOLATILE | `si_rights_admin` | Records SUSPEND, LIFT or TERMINATE_RETENTION, effective at commit. The four LIFT-only arguments are ignored for restrictions. |
| `si_source_suspended(source)` | INVOKER, STABLE | `si_collector` | Is the latest committed control SUSPEND or TERMINATE_RETENTION? (enforcement) |
| `si_retention_terminated(source, version)` | INVOKER, STABLE | `si_collector` | Is this version covered by a TERMINATE_RETENTION? (enforcement) |
| `si_source_suspended_at(source, t)` | INVOKER, STABLE | nobody | Audit view by stored `occurred_at`; never used for enforcement |

## Amendment C: emergency controls (how to use and debug them)

Three distinct controls, all recorded through `si_record_source_control` and stored
append-only in `si.source_controls`:

| Control | Effect | Undo |
| --- | --- | --- |
| `SUSPEND` | Denies use of the whole source at commit, whatever versions say or are scheduled to say | `LIFT` (compare-and-set) |
| `TERMINATE_RETENTION` | Ends the retention lifetime of everything collected under versions ≤ `through_version` (the max version at that instant, **pending ones included**); also suspends | The data loss: never. The suspension: an acknowledged `LIFT` |
| retirement (`sources.retired_at`) | Final once passed (unchanged from 2.1/B) | never |

Operator procedure for LIFT: read `max(version)` and `max(control_seq)` for the source and
pass them as `expected_max_version` / `expected_control_seq`. If anyone recorded a version
or control since, the LIFT fails with `SI_STALE_VIEW`: re-read and decide again.

Recovery after `TERMINATE_RETENTION` T:
1. record a new rights version V (evaluation and retain ALLOWED, evidence, unexpired);
   it must be the latest version and `V.version > T.through_version`; its `effective_from`
   still obeys the 2.1 ordering rule, so it may have to wait for a dead pending version;
2. `LIFT` with `ack_termination_seq = T.control_seq` (the latest termination since the last
   LIFT — supplying it is the explicit acknowledgement that covered data is lost for good)
   and `authorization_version = V.version`.

Data covered by T stays inaccessible (`si_retention_terminated`) and its retention end stays
at `T.occurred_at`; no version or LIFT can change that.

**Timing semantics.** Enforcement uses the latest *committed* control state, never
timestamps. A control takes effect for every statement whose snapshot starts after it
commits. Each control row stores two times, both taken after the source-row lock and
neither used for enforcement:

| Column | Meaning |
| --- | --- |
| `wall_clock_at` | the actual server clock reading when the row was recorded |
| `occurred_at` | the recorded audit time: equal to `wall_clock_at`, except after a backward clock step, when a restriction is stamped with the previous event's `occurred_at` so audit times never decrease per source |

`occurred_at > wall_clock_at` therefore marks a row recorded while the clock was behind.
Ordering is always `control_seq` (lock order); timestamps are evidence, not order. A statement whose snapshot is older (for example a
long REPEATABLE READ reader) keeps the old answer until it ends (test CK2). Durable commit
timestamps are not relied on anywhere.

**Milestone 1 scope.** There are no runs, observations or deletion yet: "denied" means
`rights_valid_for_publish` and the predicates return false. Physical erasure after a
termination (deletion obligations, the batch, the LIFT cleanup gate) arrives with
migration 0004; publication checks by control sequence arrive with 0002; read-path
checks with 0003.

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
5. **Amendment C, stricter than the text:** the READ COMMITTED check (`SI_ISOLATION`) is in
   the insert trigger as well as the function, so direct owner INSERTs are covered too; the
   LIFT checks run in the order retired → compare-and-set → not-suspended → acknowledgement →
   authorization (the design does not fix an order; compare-and-set first means a stale
   caller always learns to re-read).

## M1 finding — resolved by Amendment C

**An immediate revocation is impossible while a future-dated version is pending** (2.1
ordering rule). The rule is kept unchanged (test `FINDING (NEG)`); urgent restrictions now go
through source controls, which are outside the version sequence (test `C2`). Remaining
liveness limit: after a termination, a new authorization cannot take effect before a version
that was scheduled earlier.

## Milestone 2, step 2 — T1 preflight and the migrator (in progress)

- **T1** is `si.si_begin_run(source, key, request_sha256, evidence_kind, networks)`, SECURITY DEFINER, executable by `si_collector` only. Library: `t1Preflight` in `src/persistence/runs.ts`.
  - It takes the request-key advisory lock (two-int form, namespace 21321) and then `sources` FOR KEY SHARE.
  - It applies the 2.1 decision table: different hash, ALREADY_COMPLETED, live attempt, expired attempt, 20-attempt cap.
  - It throws while the source is suspended (no row).
  - Otherwise it inserts REJECTED (with a code) or RUNNING under the current rights.
- **`trg_runs_insert`** enforces the same per-key rules on every insert (owner included) and computes:
  - `start_control_seq`;
  - the lease;
  - the conflict-policy snapshot;
  - timestamps and counts.
- **No application role can INSERT or UPDATE run tables directly.**
- **Migrations** are run by the dedicated non-superuser `si_migrator`: `SI_DATABASE_URL` as `si_migrator` for `up`, `down` and `status`. `bootstrap` needs an administrator. Every bootstrap run also revokes any other membership in `si_owner` (any member, any grantor, with CASCADE), so a stray grant such as an application role's cannot survive a bootstrap (test MG1b).
- **`db/bootstrap/optional/advisory-lock-hardening.sql`** (D5b) is **not** applied by bootstrap; see `docs/b002-m2-plan.md` §7.

## Milestone 2, step 1 — migration 0002 schema (in progress)

Plan: `docs/b002-m2-plan.md` (authoritative, revision 2). Step 1 adds only the tables
`collection_runs`, `publication_receipts` and `run_errors`, their CHECK constraints (2.1 shapes,
Amendment A2 EMPTY rules, D4 consistency rules, outcome codes per status, control-sequence
columns), the IA-1 composite foreign keys (runs and receipts), indexes, and **read-only** grants.

Not yet enforced (steps 2–4): attempt numbering and the request-key lock, computed columns,
allowed transitions, the publication path (`si_complete_run`), receipts only for COMPLETED runs,
errors only for FAILED runs. Until then **no application role can write to these tables**.

`cli.js preflight` checks the operational preconditions (D7): PostgreSQL 16,
`max_prepared_transactions = 0`, `track_commit_timestamp = on`, no synchronous standby,
`default_transaction_isolation = read committed`.

**Publication timing (M2 plan §4).** Control events (G1) and rights-version/source-row
serialization (G2) are enforced by row locks held to the end of the publishing transaction.
Clock-based validity (G3) holds only at the last check instant: at that check the rights version
was valid with at least 60 s to spare; PostgreSQL does not bound the time from that check to the
durable commit.

> **Release invariant:** no production content-serving path may launch until the D8 timing gap
> (G3) is resolved and independently tested (planned for 0004).

## Limitations (Milestone 1)

- Amendment C: no physical deletion exists yet. After `TERMINATE_RETENTION` covered data is
  denied by the predicates; erasure, deletion obligations and the LIFT cleanup gate come with
  0004. Run/observation checks (0002/0003) are not implemented.
- Amendment C: reads with a snapshot older than a control's commit keep the old answer until
  they end (G-R2). `occurred_at` and `si_source_suspended_at` depend on the server clock and
  are audit-only.
- `si_rights_admin` now has `idle_in_transaction_session_timeout = 10s`: a session left idle
  inside a transaction (for example while holding a control's source-row lock) is terminated
  and its uncommitted control rolls back. This is a role **default**: the session itself can
  `SET idle_in_transaction_session_timeout = 0`, so it bounds well-behaved callers only.
  Concurrency tests verify that every lock holder really committed on a live backend
  (`holderCommit`), so a terminated holder can never pass for a serialized one (test IT1).
- After a backward clock step, restrictions are recorded at once (final-review H1) but
  their `occurred_at` is held at the previous event's, so it overstates when they were
  recorded; `wall_clock_at` keeps the real reading. LIFT stays refused until the clock
  passes the source's latest `occurred_at`, which can delay re-enabling by the size of
  the step (tests CK1, CK4).
- A single transaction may record TERMINATE_RETENTION, a new authorization and an
  acknowledged LIFT together; other sessions then never observe the suspension. Covered data
  stays terminated. The 0004 cleanup gate will prevent this (cleanup cannot complete first).
- A rights version recorded after a backward clock step can have an `effective_from` earlier
  than a preceding termination's `occurred_at`. The termination term has no supersession
  test, so covered data stays terminated (test CK3).

- A PostgreSQL superuser or the table owner can disable triggers, set
  `session_replication_role = replica`, or drop constraints. That access is reserved for migrations.
- `DROP TABLE` is not blocked by the append-only triggers (they guard data, not DDL).
- The dev password in `compose.yaml` and the test helpers is a placeholder for local/CI use only.
- The server clock is trusted (NTP with slewing is an operational requirement).
- Nothing here collects, reads or deletes ad content yet; those paths and their guarantees
  arrive in Milestones 2–4.

## D5b production advisory-lock hardening (operator-controlled)

Founder decision: separate privileged operator operation, not part of routine bootstrap.
After database bootstrap and before any production deployment, an operator with
ownership privileges over the PostgreSQL built-in advisory-lock functions must
apply `db/bootstrap/optional/advisory-lock-hardening.sql` **to each database**.
The script runs in a transaction and rejects residual PUBLIC or effective
application-role access; failure rolls back its changes. It preserves the
migrator's bigint transaction lock and the owner's two-integer transaction lock.

Then run `node dist/persistence/cli.js preflight --production` using
`SI_DATABASE_URL`. Unlike ordinary development `preflight`, this requires
zero PUBLIC and application-role advisory-lock exposures and verifies both
required privileged lock capabilities. A nonzero exit blocks production
deployment. Re-run after database creation, restore or privilege changes.
Managed services unable to perform the operator step are **not approved**
for production under this design.

This check is not a substitute for validating cluster-level role membership,
backup/restore behavior, the D8 commit-time read gate, or independent security
review. No production content-serving release is authorized before D8 is
resolved and independently tested.
