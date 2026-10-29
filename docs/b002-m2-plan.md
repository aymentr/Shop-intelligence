# B-002 Milestone 2 (migration `0002_runs`) — authoritative plan, revision 2

- **Baseline:** `main` 4418b69.
- **Supersedes:** `B-002-M2-PLAN.md` and `B-002-M2-PLAN-rev1.md`, and incorporates all eight changes listed in `B-002-M2-ARCH-CHALLENGE.md`.
- **Frozen inputs:** B-002 revision 2.1, Amendments A, B and C (C including Revisions 1–3 and the H1 correction), and IA-1.

## Founder decisions (2026-10-21)

| # | Decision | Status |
| --- | --- | --- |
| Q1 | T2 publishes EMPTY runs only in 0002 (no observations, no live collection) | Approved |
| Q2 | Distinct outcome codes `SOURCE_SUSPENDED` and `RIGHTS_TERMINATED` (meanings in §3.3) | Approved |
| Q3 | T1 during a suspension throws and writes no `collection_runs` row | Approved |
| D1 | Publication only through the SECURITY DEFINER `si_complete_run`, which locks the source before the run | Approved |
| D2′ | Approach B: a controlled publication protocol. **No `current_query()` commit guard.** | Approved |
| D3 | Receipt monitor stays in 0004 | Approved |
| D4 | Consistency constraints (§5) | Approved |
| D5 | T1 foreign-key lock exception, with adversarial tests | Approved |
| D5b | Revoke advisory-lock EXECUTE from PUBLIC | Conditional. Step 2: dedicated migrator implemented; hardening script written and tested but **not applied** — founder decision needed (§7). |
| D6 | T2 failure codes and their order (§3.3) | Approved |
| D7 | Operational preconditions asserted in tests and deployment checks | Approved |
| D8 | Verified commit timestamps plus a fail-closed content-read gate | Deferred to 0004 design. **Production-release dependency** (§4). |

## Release invariant (founder instruction)

> **No production content-serving path may launch until the D8 timing gap (G3, §4) is resolved and independently tested.**

Milestone 2 serves no content. Any later PR that adds a content-reading path for a non-test role must cite the D8 resolution and its independent test evidence, or be rejected.

---

## 1. Scope

- **In:**
  - `collection_runs`, `publication_receipts`, `run_errors`;
  - T1, T3, heartbeat and the reaper;
  - T2 through `si_complete_run`, for EMPTY runs only;
  - clock-free control-sequence checks;
  - operational-precondition checks;
  - tests and mutation tests.
- **Out:**
  - `publication_gate`, `ads`, observations (0003);
  - tombstones, retention, the read function, monitors (0004);
  - live collection or scraping of any kind.
- **Dependency rule:** 0002 references only 0001 objects. Functions that 0003 or 0004 must extend are replaced there with `CREATE OR REPLACE`.

## 2. Lock acquisition order

| Rank | Lock |
| --- | --- |
| 1 | advisory key |
| 2 | gate (0003) |
| 3 | `sources` row |
| 4 | `collection_runs` row |
| 5 | `ads` |
| 6 | observations |

**Hidden locks**, verified on PostgreSQL 16:
- **Foreign-key check:** takes FOR KEY SHARE on the parent row.
- **BEFORE UPDATE/DELETE row triggers:** run after the target row is already locked.

| Transaction | Order | Cycle analysis |
| --- | --- | --- |
| T1 `si_begin_run` (step 2) | 1 (advisory) → 3 (`sources` FOR KEY SHARE, taken explicitly first) → 4 (reap the expired attempt; insert) | **No exception any more.** Step 2 takes the source lock before any run lock, so the D5 exception (rank 3 after rank 4) no longer occurs (test LO4). The KEY SHARE also serializes T1 with in-flight rights-version and control writers (FOR UPDATE), so T1 decides under committed rights, and `start_control_seq` is exact. |
| T2 `si_complete_run` | 3 (FOR SHARE) → 4 (FOR UPDATE) → receipt INSERT (FK, own rows) → COMPLETED UPDATE → COMMIT (deferred check re-locks `sources`, already held) | No inversion |
| T3, heartbeat, reaper | 4 only | — |
| Rights / controls (0001) | 3 (FOR UPDATE) | Never touch runs |
| Retirement | 3 (FOR NO KEY UPDATE) | Compatible with KEY SHARE |

**R-LOCK.** In every later migration, a transaction holding `sources` FOR UPDATE or FOR NO KEY UPDATE must not request a rank-1 or rank-4 lock.

**R-PUB.** No new SECURITY DEFINER routine executable by an application role may modify `collection_runs.status`, `publication_receipts` or other publication state unless the BD1 allowlist (§6) is amended explicitly.

## 3. SQL and transaction strategy

### 3.1 Objects

**Step 1 (implemented):**
- Tables, CHECK constraints, indexes, IA-1 composite foreign keys, and read-only grants.
- Receipts carry a composite FK `(run_id, source_id, rights_version_id)` → `collection_runs`, so a receipt names exactly its own run's source and version. They also carry the IA-1-equivalent FK to `rights_versions`.

**Step 2 (implemented):**
- **`si_request_lock_key(source, key)`:** the two-key advisory form, namespace `0x5349`, plus a SHA-256-derived int4. IMMUTABLE.
- **Advisory locks are taken only as `si_owner`.** `si_lock_request_key` (which refuses NULLs, because the lock function is STRICT) is called inside `si_begin_run` and `trg_runs_insert`. No application role calls an advisory function.
- **T1 is the SECURITY DEFINER `si_begin_run`** (refinement of §3.2). It applies the whole decision table under the request-key lock, including the row-4 expiry. The collector holds **only EXECUTE on it**: no INSERT or UPDATE on run tables. The rights decision lives in `si_t1_rights_decision` (codes in §3.3 order).
- **Limitation:** evidence-kind and network-scope checks run only in `si_begin_run`. The request's scope is not stored, so the trigger cannot re-check them on a direct owner INSERT.
- **`trg_runs_insert`:**
  - refuse unless READ COMMITTED;
  - re-take the advisory lock;
  - check numbering, hash and cap;
  - refuse any insert while the source is suspended (Q3);
  - compute `start_control_seq`, `started_at` and the lease;
  - re-validate a RUNNING insert (rights with the `60 s + 5 min` margin, termination, evidence kind, network scope);
  - force the initial values of the computed columns.

**Step 3:**
- **`trg_runs_transition` — SECURITY INVOKER (required and tested).** A definer trigger would always see `current_user = si_owner` and void the boundary. It enforces:
  - the allowed transitions;
  - immutable identity and decision columns, including `rights_version_id`;
  - counts frozen once terminal;
  - `→ COMPLETED` only if `current_user = 'si_owner'`;
  - the heartbeat bound `(clock, clock + 5 min]`;
  - computed fields on → FAILED.
- **`trg_runs_no_delete`.**
- **`run_errors` checks:** append-only; errors only for FAILED runs; `count = least(error_count, 100)` at COMMIT.

**Step 4:**
- **`si_complete_run(run_id, lease_token, received, duplicate, suppressed, conflict)`** (SECURITY DEFINER, A4 contract, the only publication path):
  1. Refuse unless READ COMMITTED.
  2. Read `source_id` with no lock (it is immutable).
  3. `sources` FOR SHARE.
  4. Run FOR UPDATE; require RUNNING, a matching token and a live lease.
  5. In new statements: `publish_control_seq := max(control_seq)`; conditions (a) and (b); early rights check.
  6. **INSERT the receipt.**
  7. **Then** UPDATE to COMPLETED (EMPTY): `published = suppressed = 0`, `rights_checked_at = finished_at = clock`, `retain_until = NULL`. The publication check is therefore the last deferred event queued in T2.
  8. Return. It never commits.
- **`trg_runs_publish_check`:** DEFERRABLE INITIALLY DEFERRED, **SECURITY DEFINER and read-only** (no INSERT, UPDATE or DELETE; tested).
  1. READ COMMITTED only.
  2. Re-lock `sources` FOR SHARE (already held).
  3. In new statements: `max(control_seq) = publish_control_seq`; condition (b); `rights_valid_for_publish(v, clock_timestamp())`; M2 forms `published_count = 0` and `suppressed_count = 0`; receipt exists and matches.
  4. **No commit-time `current_query()` guard (D2′).**
- **Receipt checks:** a deferred check that the run is COMPLETED, plus `trg_receipts_guard` (no UPDATE except NULL→value once for the monitor's columns; no DELETE or TRUNCATE).

### 3.2 Transactions (all READ COMMITTED)

- **T1:** `BEGIN` → `SELECT * FROM si.si_begin_run(source, key, sha256, evidence_kind, networks)` → `COMMIT` (library `t1Preflight`).
  - Inside: advisory lock → `sources` FOR KEY SHARE → decision-table rows 1–5 (row 4 may reap) → if suspended, throw `SI_SOURCE_SUSPENDED` (the whole T1 rolls back, including the reap; no attempt is consumed) → rights decision → INSERT.
  - Thrown outcomes map to `T1Refused` codes: `IDEMPOTENCY_KEY_REUSED`, `RUN_IN_PROGRESS`, `ATTEMPT_LIMIT_EXCEEDED`, `SOURCE_SUSPENDED`.
  - The request hash comes from `src/persistence/request-hash.ts` (canonical JSON; test C7).
- **T2 (controlled protocol, D2′):**
  - The library sends exactly `BEGIN`, `SELECT si.si_complete_run(...)`, `COMMIT`.
  - A static check forbids `SET CONSTRAINTS` and `PREPARE TRANSACTION` under `src/`.
  - On error: `ROLLBACK`, then T3 with the mapped code.
- **T3, heartbeat, reaper:** rank 4 only.

### 3.3 Outcome codes (Q2, D6)

- **`SOURCE_SUSPENDED`** (FAILED, T2): the run's control interval contains a SUSPEND or TERMINATE_RETENTION, or the state at `start_control_seq` is suspending, and no termination covers the run's version. A later LIFT does not clear it.
- **`RIGHTS_TERMINATED`**:
  - REJECTED at T1: the source is not suspended, but the current version is covered by a TERMINATE_RETENTION.
  - FAILED at T2: a TERMINATE_RETENTION with `control_seq ≤ publish_control_seq` covers the run's version.
- **T2 failure order:**
  1. `LEASE_EXPIRED`
  2. `RIGHTS_TERMINATED`
  3. `SOURCE_SUSPENDED`
  4. `SOURCE_RETIRED`
  5. `RIGHTS_CHANGED`
  6. `RIGHTS_EXPIRING`
  7. `LOCK_TIMEOUT`
  8. `PERSISTENCE_ERROR`
- **Codes allowed per status** (enforced by CHECKs in step 1):

| Status | Allowed codes |
| --- | --- |
| REJECTED | NO_RIGHTS, RIGHTS_EXPIRED, RIGHTS_EXPIRING, EVALUATION_NOT_ALLOWED, RETAIN_NOT_ALLOWED, SOURCE_RETIRED, EVIDENCE_KIND_MISMATCH, NETWORK_SCOPE_MISMATCH, RIGHTS_TERMINATED |
| FAILED | SOURCE_ERROR, VALIDATION_FAILED, DUPLICATE_CONFLICT, LEASE_EXPIRED, RIGHTS_TERMINATED, SOURCE_SUSPENDED, SOURCE_RETIRED, RIGHTS_CHANGED, RIGHTS_EXPIRING, LOCK_TIMEOUT, PERSISTENCE_ERROR, INTERNAL |

A REJECTED `SOURCE_SUSPENDED` row is impossible (Q3).

## 4. Guarantees (exact wording; no durable commit-time claim)

| Class | Statement | Enforced by | Holds under `SET CONSTRAINTS IMMEDIATE`, delays, waits on other sessions? |
| --- | --- | --- | --- |
| **G1. Control events (clock-free)** | No SUSPEND or TERMINATE_RETENTION has a `control_seq` in `(start_control_seq, publish_control_seq]`. Every control either committed before the check or acquires the source lock after T2 ends. | `sources` FOR SHARE, held by `si_complete_run` until the transaction ends | **Yes** |
| **G2. Serialization of rights versions and the source row** | No rights version, control or retirement for the source commits while T2 is open | Same lock; `trg_rights_insert` locks before reading the clock | **Yes** ("starts after T2" also assumes a monotonic clock) |
| **G3. Clock-based validity** | At the last check instant `c`, the version was valid with `c + 60 s < window_end` | The deferred check (normally during COMMIT) and the early check in the function | **No.** PostgreSQL does not bound the time from `c` to the durable commit (evidence Y3: 2,007 ms added by another session's lock after a passing check). |

**Wording for all documentation:** "At the last check, the rights version was valid with at least 60 s to spare. PostgreSQL does not bound the time from that check to the durable commit. Commits outside the window are detectable from commit timestamps; D8 (0004) must make content from such runs unservable before any production content-serving path launches."

## 5. Consistency constraints (D4), implemented in step 1

- **EMPTY (A2):**
  - `EMPTY ⇔ COMPLETED ∧ published = 0 ⇔ COMPLETED ∧ retain_until IS NULL`;
  - EMPTY is final;
  - **duplicates alone cannot produce zero** (`received = 0 ∨ duplicate < received` for COMPLETED).
- **Conflicts:** FAIL_RUN never completes with `conflict_count > 0`.
- **Errors:** `error_count = 0` unless FAILED. `count(run_errors) = least(error_count, 100)` is checked at COMMIT (step 3).
- **Codes per status** (§3.3).
- **Control sequences:** `publish_control_seq` is set iff COMPLETED, and is ≥ `start_control_seq`.
- **IA-1:** the run's version belongs to its source; NULL is allowed only for REJECTED/NO_RIGHTS. Receipts name exactly their run's source and version.
- **Retry:**
  - decision-table rows 1–5 take priority over the suspension throw;
  - REJECTED `RIGHTS_TERMINATED` consumes an attempt;
  - a suspension throw does not;
  - a retry after `ALREADY_COMPLETED` returns EMPTY.

## 6. Tests

**Implemented in step 1:**

| Test file | Tests |
| --- | --- |
| `runs-schema.test.mjs` | S1–S10 and the step-1 scope check |
| `preconditions.test.mjs` | D7 |
| `migrations.test.mjs` | M1 and M1b fingerprints; frozen 0001 checksums |
| `privileges.test.mjs` | G1 with the 0002 tables; column-level write privileges absent |

**Later steps:**

| Group | Tests |
| --- | --- |
| Lock order | LO1 (adversarial two-session test; mutant LO1-M must deadlock); LO1-ref; LO2; LO3; LO4; **LO4b** (real-object version of Y6: T1 reaping, T2, R); **LO4c** (deliberate advisory cycle gives `40P01` with no partial state); LO5–LO7 |
| Boundary | **BD1** (catalog allowlist of definer routines × grantees: collector = {`si_begin_run`, `si_heartbeat_run`, `si_fail_run`, `si_reap_expired_runs`, `si_complete_run`}; rights admin = {`si_record_rights_version`, `si_record_source_control`}; no grantee: the read-only commit-time check `trg_run_errors_count`. Step 3 amendment under R-PUB: heartbeat, T3 and the reaper are the only status writers besides T1 and T2; they lock only the run row, never reach COMPLETED (`trg_runs_transition`), and give the collector no table write privilege); **BD2** (`trg_runs_transition` not definer; `trg_runs_publish_check` contains no DML); **BD3** (hostile `search_path`); **BD4** (rights and control routines leave runs untouched); **BD5** (`SET ROLE si_owner` refused for application roles; the only member of `si_owner` is `si_migrator`, with SET and without INHERIT or ADMIN) |
| Protocol | **CR-IMM** (`SET CONSTRAINTS ALL IMMEDIATE`, then a SUSPEND attempted before COMMIT waits until T2 ends; COMPLETED, and `publish_control_seq < suspend.control_seq`: G1 without deferral); **PB1** (library sends exactly BEGIN / function / COMMIT); **PB2** (static: no `SET CONSTRAINTS` or `PREPARE TRANSACTION` in `src/`); **PB3** (forensic: IMMEDIATE plus a pause records `commit_ts − rights_checked_at`; documents G3); **PB4** (receipt queued before the publication check) |
| Frozen and amendment tests | C1–C10, L1/L2/L4/L6–L8, LS1/LS2, IA1/IA1b/IA1c (behavioural), A2–A7/A10/A11, E1/E3/E6/E7, CR1–CR7, CR4b, CK-R, LI-R, EC1–EC5, I4′ teardown, H2 forensic |

**Mutants for later steps:**

| Mutant | Must be killed by |
| --- | --- |
| Trigger-based source locking, or COMPLETED reachable outside the function | LO1, LO2 |
| The function locks the run before the source | LO1 |
| `trg_runs_transition` declared SECURITY DEFINER | BD2, LO2 |
| Update before receipt | PB4 |
| A second collector-executable definer routine that updates runs | BD1 |
| `si_complete_run` without the `sources` lock | CR-IMM, LO1 |

The previous plan's mutants (control interval, rights at publication, idempotency, lifecycle, IA-1, EMPTY, privileges) still apply.

## 7. D5b audit (2026-10-21; no privilege changed)

**Functions concerned.** All 21 advisory-lock functions in `pg_catalog` have the default ACL (NULL, meaning PUBLIC EXECUTE). No `pg_init_privs` entries. Only the `plpgsql` extension is installed.
- `pg_advisory_lock` / `_shared`, `pg_try_advisory_lock` / `_shared`, `pg_advisory_unlock` / `_shared` — each in `(bigint)` and `(integer, integer)` forms;
- `pg_advisory_unlock_all()`;
- `pg_advisory_xact_lock` / `_shared`, `pg_try_advisory_xact_lock` / `_shared` — each in `(bigint)` and `(integer, integer)` forms.

**Current and planned callers:**
- The migration runner calls `pg_advisory_xact_lock(bigint)` as the **migrator login** (today the bootstrap superuser in tests and CI). Planned step 2 has T1 call `pg_advisory_xact_lock(integer, integer)` as `si_collector`.
- Test M3 only reads `pg_locks`.
- `DISCARD ALL` releases advisory locks internally, so a SQL privilege does not affect it.

**Incompatibilities and conditions** (none blocks Step 1):
1. **Migrator role undefined.** The production migrator is not specified yet (an M1 limitation). If it is not a superuser, it needs an explicit `GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_xact_lock(bigint)`, or the runner fails, though it fails closed.
2. **Per-database.** `pg_proc` ACLs are per database. The REVOKE/GRANT must run in every database through `bootstrapDatabase` (which already runs per database). A database created from `template0` without re-running bootstrap would revert to PUBLIC.
3. **Poolers and tools.** Anything issuing `SELECT pg_advisory_unlock_all()` (or advisory-based leader election, migration tools, job schedulers) under a revoked role would break. None is in use.
4. **Dump/restore.** Expected to preserve ACL changes on system functions via `pg_init_privs` comparison. **Not yet verified here**; this belongs in the D5b test.
5. **Scope of benefit.** D5b removes the deliberate-cycle path for `si_rights_admin`, `si_retention` and `si_monitor`. The collector keeps exactly the two-key transaction form, and it cannot hold `sources` FOR UPDATE, so it cannot form the cycle.

**Step 2 results** (`tests/db/migrator.test.mjs`, MG0–MG8):

- **Dedicated migrator `si_migrator` (implemented in bootstrap):**
  - LOGIN; NOSUPERUSER, NOCREATEROLE, NOCREATEDB, NOREPLICATION, NOBYPASSRLS, NOINHERIT; `lock_timeout = 30s`.
  - Its only membership is `si_owner`, `WITH INHERIT FALSE, SET TRUE, ADMIN FALSE`.
  - Database CONNECT, USAGE on `si`, SELECT on `si.schema_migrations`.
  - Verified: it applies, reports and rolls back 0001 and 0002, with a catalog identical to an administrator-migrated database (MG2). It cannot bootstrap, create roles or grant `si_owner` onward (MG3). Outside `SET ROLE` it has no data access and no application paths (MG4). It takes the migration lock as itself (MG5).
  - Bootstrap remains an administrator task.
- **Hardening script `db/bootstrap/optional/advisory-lock-hardening.sql`** (written and tested; **not run by bootstrap**):
  - Revokes all 21 functions from PUBLIC and grants `pg_advisory_xact_lock(bigint)` to `si_migrator` and `pg_advisory_xact_lock(integer, integer)` to `si_owner`; then verifies.
  - Applied by the `pg_catalog` owner: migrations and T1 still work, and every other role gets `42501` on all 21 functions (MG6).
- **Compatibility findings requiring a founder decision:**
  1. **A non-owner administrator cannot apply it, and PostgreSQL does not fail.** `REVOKE` on a `pg_catalog` function by a non-owner only warns ("no privileges could be revoked") and reports success. On managed hosts where the administrator does not own `pg_catalog`, D5b would silently do nothing. The script therefore verifies and raises `SI_HARDENING_INCOMPLETE` (MG7).
  2. **Per database.** Clones of a hardened database keep it; databases created from `template0` do not. `pg_dump --schema-only` records the REVOKE/GRANT (MG8, PostgreSQL 16.15 client).
- **Options:**
  - (a) Run the hardening script from `bootstrapDatabase`, failing bootstrap where it cannot apply (blocks deployment on such hosts).
  - (b) Run it where possible and record the result in the deployment preflight.
  - (c) Leave it optional.

  Today no application role needs advisory functions, so the residual risk without D5b is only the deliberate-deadlock path (detected, `40P01`).

**Original proposal** (superseded by the step 2 results above): apply D5b in Step 2, together with T1's grant, as a `bootstrap/database.sql` change.
- REVOKE all 21 from PUBLIC.
- GRANT `pg_advisory_xact_lock(integer, integer)` to `si_collector`.
- Migrator: a founder decision (keep a superuser migrator, or create one and grant it `pg_advisory_xact_lock(bigint)`).
- Tests: every other app role gets `42501` on all 21; the collector is refused the other 20; M5 idempotency is extended to these ACLs; a dump/restore check.

## 8. Implementation sequence (branch `claude/b002-m2-runs`)

1. **Done:** schema, CHECKs, IA-1 FKs, down migration, privilege, fingerprint and precondition tests, and the `cli.js preflight` deployment check.
2. **Done:** `si_request_lock_key`, `trg_runs_insert`, `si_begin_run` (T1, including the row-4 expiry), library `t1Preflight`, request hash, `si_migrator`, and the hardening script (not applied). Tests: T1-1 to T1-6, C5/C6, C7, C8–C10, EC5, DS1–DS7, CC-R, CC-C, LO4 (revised), LK, LI-T1, MG0–MG8.
3. `trg_runs_transition` (INVOKER), heartbeat, T3, reaper, `run_errors` checks; L, LS, EC3 and BD2 tests.
4. `si_complete_run`, `trg_runs_publish_check`, receipt checks, the library T2 protocol and the PB2 static check; A, E, CR, CR-IMM, LO, BD and PB tests; I4′.
5. Parity extension, all mutation sets, docs.
6. Three full runs, the CLI cycle, CI, then the PR (not merged).

## 9. Acceptance criteria

- Every test passes in three consecutive local runs on PostgreSQL 16 and in CI.
- Every non-equivalent mutant is killed; every survivor has an argument or a counterexample.
- No correctness assertion depends on clocks or commit timestamps.
- 0001 is byte-identical (frozen-checksum test).
- No path to COMPLETED except `si_complete_run`.
- LO1 passes, and LO1-M deadlocks.
- BD1 and BD2 hold.
- CR-IMM proves G1 without deferral.
- Documentation uses the §4 wording.
- The release invariant is stated in the README and in the persistence docs.
