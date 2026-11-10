# B-002 Milestone 3 — design contract (migrations 0003 and later)

**Status: PROPOSED DESIGN. Not implemented. Not verified. Not approved for implementation.**
Baseline: `ccb87ed91954e11d4fa4c6c37b3a782357640595` (Milestone 2: conditional development
acceptance, D-M2-01; CI #109 green).
Authority: `docs/b002-m2-plan.md` revision 2 and the Milestone 2 closure decisions D-M2-01…D-M2-10
(`docs/b002-m2-final-acceptance.md`), which this document does not change. The B-002 revision 2.1,
Amendment A–C (incl. Revisions 1–3 and H1) and IA-1 texts remain unavailable primary sources
(D-M2-05); nothing here claims equivalence to them.

## 0. How to read this document

Every statement carries one of these labels, and none is upgraded by being written down:

| Label | Meaning |
|---|---|
| **APPROVED** | A founder decision recorded in §2. A decision is not evidence. |
| **PROPOSED** | Design text awaiting implementation and verification. |
| **VERIFIED (baseline)** | Checked against the baseline repository or its catalog, as cited. |
| **UNVERIFIED** | An assumption about PostgreSQL or library behaviour; the named test must confirm it before implementation relies on it. |
| **BLOCKED** | Cannot proceed until the stated condition is met. |

Implemented so far: **only the request-scope foundation** (migration 0003, §4.2.3), with tests SC-1…SC-14,
pending founder acceptance. Everything else in Milestone 3 (ads, observations, non-empty T2) is
PROPOSED and unimplemented; invariants in §5 and tests in §8 are PROPOSED unless marked otherwise.

## 1. Frozen scope (PROPOSED)

In (migration 0003, SYNTHETIC sources only):
- `si.ads` — per-source ad identity registry (no content).
- `si.observations` — one kept record per identity per completed run.
- `si.run_request_scope` — the request scope recorded by the scoped T1 (§4.2). **Implemented in 0003.**
- `si_begin_run_scoped` — the scoped T1 wrapper (FD7 option C). **Implemented in 0003.**
- v1 hash functions `si_canonical_json_v1`, `si_fixture_sha256_v1`, `si_request_sha256_v1`. **Implemented in 0003.**

Migration numbering: the request-scope foundation is migration **0003** (Milestone 3 part 1). The
remaining Milestone 3 objects (ads, observations, non-empty T2) follow in the next migration. The
items the M2 plan allocated to "0004" (tombstones, retention, the read function, monitors, D8) move
to the migration after that. This is a recorded numbering deviation from plan §1, not a change of
scope.
- Non-empty T2: `si_complete_run(uuid, uuid, jsonb)` replaces the counts-based signature.
- Extended `trg_runs_publish_check`; insert-scoped integrity checks; replaceable append-only guards.
- Library: `completeRun(..., rows)`, scope binding inside T1, strict diagnostics parsing.
- Logging preconditions and in-function effective-session checks (§5.1).

Out (§9): `publication_gate` (0004), suppression (S = 0), purge/deletion, the read function,
monitors, D8, cross-source identity resolution, non-SYNTHETIC evidence, live adapters, any
content read or serving.

## 2. Founder decisions

### 2.1 Milestone 3 decisions

| ID | Status | Disposition |
|---|---|---|
| FD1 | APPROVED | `publication_gate` deferred to 0004; lock rank 2 stays reserved. Recorded deviation from plan §1 line 42 (which allocates it to 0003). M3 invariant: no M3 path acquires any lock before rank 3 except T1's existing advisory lock. |
| FD2 | APPROVED | Deterministic database-derived counts; `EMPTY ⇒ C = 0` (§6.3). |
| FD3 | APPROVED, conditional | Transactional replacement of the T2 signature, conditional on the dependency and privilege verification in §7. |
| FD4 | APPROVED (proposed anchor) | `retain_until = least(finished_at + retention_days(v), si_retention_end(source, v) as of T2)` for the collected version `v`, as a static upper bound. Dynamic effective end enforced in 0004. |
| FD5 | APPROVED, provisional | Cap 500 rows and 1 MiB (octets of the `jsonb` text form), subject to M3-T14. |
| FD6 | APPROVED | FAILED runs keep every count at 0 and record bounded coded errors only. |
| FD7 | **APPROVED — option C; IMPLEMENTED (0003), acceptance pending** | The `xmin` binder (option A) is rejected on PostgreSQL 16 evidence (§4.2.2). Option C, the scoped T1 wrapper (§4.2.3), is approved and implemented. FD7 is not marked VERIFIED until the founder accepts the M3-P1 evidence. Non-empty T2 remains unimplemented. |
| FD11 | APPROVED | BD1 amendment: `si_begin_run_scoped` is added to the collector's SECURITY DEFINER allowlist (it starts runs, so R-PUB applies). `si_bind_request_scope` is withdrawn. Plain `si_begin_run` is unchanged; plain-T1 runs stay EMPTY-only. |
| FD8 | APPROVED | Synthetic-only development; no content reads; no purge; no production authorization. |
| FD9 | APPROVED, conditional | Canonical fixture hashing: preserve historical request-hash and retry compatibility; versioning policy in §4.4. |
| FD10 | APPROVED, with verification requirements | Collector logging preconditions (§5.1). No claim of absolute protection from server logging; effective-session checks and negative leakage tests (M3-T19, M3-T21) are required. |

### 2.2 Milestone 2 governance decisions (preserved, unchanged)

D-M2-01 conditional development acceptance (not historical parity, not production approval);
D-M2-02 BD1 amendment ratified (no direct app-role table writes); D-M2-03 single-statement
receipt/completion; D-M2-04 conditions (a)/(b) against the revision-2 plan only; D-M2-05
historical parity deferred (40 BLOCKED identifiers preserved); D-M2-06 unexecuted mutants remain
gaps; D-M2-07 EMPTY `conflict_count` to be revisited before non-empty collection (resolved in
design by FD2, not yet implemented); D-M2-08 heartbeat/T3 isolation and S4-8 timing are
limitations; D-M2-09 D5b production operator policy; **D-M2-10 no production content-serving path
until the G3 gap is addressed by the D8 fail-closed read gate and independently verified.**

## 3. Schema (PROPOSED; all owner-only — no application-role privilege of any kind)

`si.ads`
- `ad_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
- `source_id text NOT NULL REFERENCES si.sources`
- `network text NOT NULL CHECK (network IN ('META','TIKTOK','GOOGLE','PINTEREST','OTHER'))`
- `native_ad_id text NOT NULL` — length 1..256, no control characters, no surrounding white space
- `first_run_id uuid NOT NULL`, `created_at timestamptz NOT NULL DEFAULT clock_timestamp()`
- `UNIQUE (source_id, network, native_ad_id)`

`si.observations`
- `run_id uuid`, `source_id text`, `rights_version_id bigint`, with
  `FOREIGN KEY (run_id, source_id, rights_version_id) REFERENCES si.collection_runs (run_id, source_id, rights_version_id)` (IA-1 pattern)
- `ordinal int NOT NULL CHECK (ordinal >= 0)` — submitted row index
- `ad_id bigint NOT NULL`, with a composite FK on `(ad_id, source_id, network, native_ad_id)` to `si.ads`, `ON DELETE RESTRICT`
- content typed per B-001 `AdEvidence`: `network`, `native_ad_id`, `advertiser_name`,
  `countries text[]` (1-D, sorted, unique, `^[A-Z]{2}$`), `seen_at timestamptz`, `source_url`,
  `title`, `destination_url`, `creative_url`, `source_reported_first_seen`,
  `source_reported_last_seen` (first ≤ last when both present); http(s) URLs without user info;
  bounded text lengths
- `content_sha256 text NOT NULL` — fingerprint excluding `seen_at` (§6.3)
- `PRIMARY KEY (run_id, ordinal)`, `UNIQUE (run_id, ad_id)`

`si.run_request_scope`
- `run_id uuid PRIMARY KEY REFERENCES si.collection_runs`
- `source_id text NOT NULL`, `evidence_kind text NOT NULL`, `networks text[] NOT NULL` (sorted,
  unique, non-empty), `fixture_sha256 text NOT NULL CHECK (fixture_sha256 ~ '^[0-9a-f]{64}$')`,
  `hash_version smallint NOT NULL CHECK (hash_version = 1)` (§4.4), `bound_at timestamptz NOT NULL`

Guards are trigger functions, so that 0004 can replace them; they are never CHECK or rule objects:
- `ads`, `observations`, `run_request_scope`: UPDATE, DELETE and TRUNCATE refused for every role.
- Insert-scoped deferred checks, firing on INSERT only, so later purges never trigger them:
  - observation ⇒ its run is COMPLETED;
  - new ad ⇒ at least one observation inserted by the same transaction;
  - scope ⇒ recorded only by the scoped T1 for the RUNNING attempt it creates (§4.2.3; implemented in 0003).

Lock ranks: `run_request_scope` is run-scoped (rank 4); `ads` rank 5; `observations` rank 6.

## 4. Transaction protocols (PROPOSED)

### 4.1 Library flow (non-empty)
1. Read the offline fixture rows. Validate each with B-001 `parseAd` **without changing the rows**.
   If a row fails, continue to step 3, then T3 `VALIDATION_FAILED` with client-coded errors (no T2).
   If a row is valid but not already canonical (i.e. `parseAd(row)` ≠ the row's own values), the
   library refuses before T1 (§6.2).
2. Compute `fixtureSha256(rows)` and `requestSha256(adapterId = sourceId, evidenceKind, networks,
   fixtureSha256)` with the **unchanged** `src/persistence/request-hash.ts` (v1, §4.4). Refuse
   locally, before T1, if the rows exceed the cap or contain a NUL character.
3. T1: `BEGIN` / `si_begin_run_scoped(...)` / `COMMIT` (library `t1PreflightScoped`; implemented).
4. T2: `BEGIN` / `SELECT * FROM si.si_complete_run($run, $token, $rows::jsonb)` / `COMMIT`, sending
   **exactly the rows that were hashed**.
5. On any error at step 4: `ROLLBACK`, then T3 (§6.5).

EMPTY runs: `rows = []`. T2 needs no scope, so Milestone 2 behaviour is preserved, including for
runs started before 0003.

### 4.2 Request-scope binding (FD7 — option C: IMPLEMENTED in migration 0003, acceptance pending)

#### 4.2.1 What Milestone 2 does and does not record (VERIFIED baseline)
- `si_begin_run` evaluates `p_networks` once, through `si_t1_rights_decision`
  (`0002_runs.up.sql:388` → `:203`). It does **not** store it: the INSERT at `:389` has no
  networks column.
- T1 never compares `p_networks` with `request_sha256`; it does not receive `fixtureSha256`.
- **Consequence:** for runs started through plain `si_begin_run`, the exact network set T1
  authorized cannot be recovered or verified.

#### 4.2.2 Rejected: separate binder with an `xmin` same-transaction check (option A)
The earlier proposal (`si_bind_request_scope` with `run.xmin = pg_current_xact_id()::xid`) is
**withdrawn**. M3-P1 experiments on PostgreSQL 16.15 showed `xmin` identifies the newest row
**version**, not the creating transaction:
- **False refusals:** a run inserted inside a savepoint (even after `RELEASE`) or inside a PL/pgSQL
  `EXCEPTION` block carries the subtransaction's XID.
- **Forgery:** a run created in an earlier transaction and heartbeated in the current one reports
  `xmin = current XID`. The collector may call heartbeat, so it could make an old run look new.

Option B (replacing `si_begin_run` in 0003) was also rejected. It would overwrite the 0002 copy
that seven anchors in six Step 2 CI mutation scripts mutate, so those mutants would silently survive.

#### 4.2.3 Adopted: scoped T1 wrapper (option C — APPROVED by the founder)
`si.si_begin_run_scoped(p_source_id, p_request_key, p_request_sha256, p_evidence_kind, p_networks text[], p_fixture_sha256)`
(migration `0003_request_scope`):
- SECURITY DEFINER, `search_path = pg_catalog, pg_temp`;
- EXECUTE for `si_collector` only;
- returns the same columns as `si_begin_run`;
- one SQL statement, so the T1 attempt and its scope commit or roll back together, also under autocommit.

1. **Validate, without lock or write:** source, both hashes (64 hex), evidence kind
   `^[A-Z_]{1,40}$`, networks (non-empty, 1-D, no NULLs, `^[A-Z]{1,20}$`, no duplicates).
   Otherwise `SI_BAD_ARGUMENT` (22023).
2. **Hash check, without lock or write:**
   `si.si_request_sha256_v1(source, evidence kind, networks, fixture) = p_request_sha256`.
   Otherwise `SI_REQUEST_HASH_MISMATCH` (22023). A refusal consumes no attempt.
3. **Call the unchanged `si.si_begin_run`** with the **same** `p_networks`. Its locks
   (advisory → `sources` KEY SHARE → run), decision table, Q3 and REJECTED codes are unchanged.
4. **Record the scope only if the outcome is RUNNING.** That is always a row `si_begin_run` has
   just inserted: a live attempt raises `SI_RUN_IN_PROGRESS`, and a COMPLETED one returns
   ALREADY_COMPLETED. The scope row holds the same network array (sorted `COLLATE "C"`), the
   fixture hash and `hash_version = 1`.

`si.run_request_scope`:
- **Binding:** one row per run (PK); composite FK `(run_id, source_id)` → `collection_runs`, so
  the scope names exactly its run's source.
- **Immutable:** UPDATE, DELETE and TRUNCATE refused for every role.
- **Insert guard** (every inserter):
  - admits only the wrapper's transaction-local binding marker for the run it has just created;
  - requires the run to be RUNNING;
  - requires sorted, unique networks.

  The marker is defence in depth against a direct **owner** INSERT. It is not a boundary against
  the owner. Application roles have **no privilege** on the table at all.

**What this proves.** For every scoped run, the stored network set **is exactly the argument T1
evaluated** (the same variable within one invocation), it satisfied T1's rules, and it is bound,
together with the fixture hash, to the run's immutable v1 `request_sha256`.

**What it does not prove.** Anything about runs started through plain `si_begin_run`. Those
record no scope and stay EMPTY-only. Plain T1 remains callable for Milestone 2 compatibility
(founder decision).

**Residual:** the owner can still change `sources.supported_networks` directly. Non-empty T2 must
re-check the current networks, so narrowing fails closed.

**FD7 status:** implemented in migration 0003; **not yet accepted.** Acceptance requires the M3-P1
evidence (tests SC-1…SC-14 in `tests/db/m3-scope.test.mjs`, the existing suite, CI) and founder
review. The checks that non-empty T2 performs against the scope (§4.3 phase C) are not
implemented and remain part of M3-T08.

### 4.3 T2 `si_complete_run(p_run_id, p_lease_token, p_rows jsonb DEFAULT '[]')`

Phase A — no locks, no writes:
- isolation check;
- logging check (§5.1);
- `jsonb_typeof(p_rows) = 'array'`, at most 500 elements, `octet_length(p_rows::text) ≤ 1048576`,
  otherwise `SI_BAD_ARGUMENT`;
- read `source_id` and `conflict_policy` without a lock (both immutable after T1);
- per row:
  - strict shape: an object whose values are strings, arrays of strings, booleans or null; any
    number is `INVALID_SHAPE`;
  - the 11 `AdEvidence` keys are validated by the canonical grammar (§6.2); other keys are
    ignored for content (as in B-001) but included in the hash;
  - compute the identity and the fingerprint;
- compute R, U, D, C, the conflicting ordinals and the error list;
- compute the v1 fixture hash in SQL (§4.4).

Phase B — locks, in rank order:
- `sources` FOR SHARE (rank 3), then the run FOR UPDATE (rank 4);
- NOT_OWNER / LEASE_EXPIRED; then the plan §3.3 control and rights order (unchanged).

Phase C — payload refusals, in this order, each a RAISE (§6.1):
- if R > 0:
  - a scope exists (`REQUEST_SCOPE_MISSING`);
  - the SQL fixture hash equals `scope.fixture_sha256` (`REQUEST_HASH_MISMATCH`);
  - every row's network is in `scope.networks` and in the current `supported_networks`
    (`NETWORK_NOT_AUTHORIZED`);
- any row error → `VALIDATION_FAILED`;
- `conflict_policy = 'FAIL_RUN'` and C > 0 → `DUPLICATE_CONFLICT`.

Phase D — writes, only after phases A–C pass:
- `INSERT INTO si.ads … ON CONFLICT DO NOTHING`, ordered by `(network, native_ad_id COLLATE "C")`;
- resolve every `ad_id` in a new statement;
- `INSERT` the observations (the kept row for each identity is the lowest ordinal);
- receipt INSERT and COMPLETED UPDATE as one statement (D-M2-03), with:
  - `received = R`, `duplicate = D`, `conflict = C`, `published = U`, `suppressed = 0`;
  - `retention_state = 'EMPTY'` if R = 0, otherwise `'RETAINED'`;
  - `retain_until` per FD4 (NULL if and only if EMPTY).

Return the derived counts only, never content.

COMMIT — deferred, read-only checks:
- the existing publication check, extended: `published_count = count(observations of the run)`,
  `received = published + duplicate`, `conflict ≤ duplicate`;
- the existing receipt ⇒ COMPLETED check;
- the insert-scoped observation, ad and scope checks.

### 4.4 Request-hash compatibility and versioning (FD9)

- **v1 is frozen.** `src/persistence/request-hash.ts` is not modified by Milestone 3. The algorithm:
  - `request_sha256 = sha256(canonicalJson({adapterId, evidenceKind, networks sorted, fixtureSha256}))`;
  - `fixtureSha256 = sha256(canonicalJson(rows in input order))`;
  - canonical JSON: keys sorted by code point, no white space, strings and keys NFC-normalized.
- **Historical compatibility:**
  - Pre-0003 runs and request keys keep their hashes. A retry of a pre-0003 key computes the
    identical v1 hash, so T1 behaves exactly as in Milestone 2 (ALREADY_COMPLETED, a new attempt,
    or IDEMPOTENCY_KEY_REUSED as before).
  - Pre-0003 RUNNING runs have no scope, so they can only complete EMPTY.
- **Database recomputation of v1 (IMPLEMENTED in 0003 as `si_canonical_json_v1`, `si_fixture_sha256_v1`
  and `si_request_sha256_v1`; parity tested by SC-1 on Node 22 / PostgreSQL 16.15; use by T2 still
  PROPOSED):** the database rebuilds the canonical JSON of the
  submitted rows in SQL:
  - `normalize(value, NFC)` for strings and keys;
  - keys ordered `COLLATE "C"` (UTF-8 byte order, which equals code-point order);
  - `to_json(text)` for string escaping;
  - booleans and null literally; arrays in order;
  - numbers are refused (`INVALID_SHAPE`), because PostgreSQL and JavaScript number formatting differ.
- **Known parity hazards:** the Unicode version of Node's ICU versus PostgreSQL's NFC tables, and
  JSON escaping of control characters, U+2028/U+2029 and non-BMP characters. Any difference makes
  T2 fail closed with `REQUEST_HASH_MISMATCH`; it never stores mismatched data. M3-T18 must measure
  the parity.
- **Future versions:** any change to the hashed object or the fixture encoding requires:
  - a new version with an explicit `"hv": <n>` member inside the hashed object;
  - `hash_version` recorded in `run_request_scope`;
  - a request key keeps the version it was created with for its whole life;
  - the library chooses the version from the key's history, never silently;
  - the v1 algorithm stays available for v1 keys.

  Milestone 3 introduces no version 2.

## 5. Security invariants (PROPOSED; C = clock-free, T = clock-dependent)

| # | Invariant | Kind |
|---|---|---|
| S1 | Source isolation: observations are bound to the run's `(source_id, rights_version_id)`; ads are keyed by source | C |
| S2 | G1 (control interval) and G2 (no rights, control or retirement commit during T2) extend unchanged | C |
| S3 | Rights valid at the last check with a 60 s margin (G3). Not durable; D8 remains a blocker (D-M2-10). | T |
| S4 | Atomicity: ads, observations, receipt and COMPLETED all commit or none do, including refusals at COMMIT | C |
| S5 | Database-derived counts: `R = P + D + S`, `S = 0`, `C ≤ D`, `R = 0 ∨ D < R`; hence EMPTY ⇔ R = 0 and EMPTY ⇒ C = 0 | C |
| S6 | Lock order: (1 advisory, in T1) → 3 → 4 → 5 (sorted) → 6; no deadlock between concurrent T2s | C |
| S7 | Least privilege: no application-role privilege on the new tables; the definer allowlist grows only by `si_begin_run_scoped` (BD1 amendment FD11); T2 returns no content | C |
| S8 | Append-only for every role, with guards 0004 can replace | C |
| S9 | Request scope recorded by the scoped T1 in the same statement as the attempt, equal to T1's network argument, and bound to the immutable `request_sha256` (FD7 option C; implemented, acceptance pending; §4.2.3 states the limits) | C |
| S10 | Logging protections within the boundary of §5.1 | C |
| S11 | Retention: `retain_until` is a static upper bound; the effective end is dynamic (0004); **not enforced in M3** | T |
| S12 | No serving: no read function; a catalog check that no `si` function returns or outputs content columns; SYNTHETIC-only CHECK unchanged | C |
| S13 | Lease checks (T1, T2, T3, reaper) | T |

D5b (D-M2-09) and D8/G3 (D-M2-10) remain production-release blockers.

### 5.1 Logging protections (FD10)

**In scope** (what Milestone 3 controls):
- PostgreSQL logging of `si_collector` bind parameters, through statement logging
  (`log_statement`), duration logging (`log_min_duration_statement`, `log_min_duration_sample`,
  `log_transaction_sample_rate`) and error logging of parameters
  (`log_parameter_max_length_on_error`);
- error messages and DETAIL text produced by Milestone 3 code;
- library logging.

**Out of scope** (not protected, and not claimed):
- a superuser or the `si_owner`/migrator changing settings at session, database or system level
  after the checks run;
- extensions such as `pgaudit` or `auto_explain`;
- debug log levels;
- WAL, backups and replicas (they hold stored data by design);
- network capture;
- client-driver debug output;
- core dumps;
- monitoring tools that read live query parameters.

**Proposed controls:**
1. **Bootstrap (superuser):** `ALTER ROLE si_collector SET log_parameter_max_length = 0` and
   `ALTER ROLE si_collector SET log_parameter_max_length_on_error = 0`.
2. **Effective-session check inside T2** (phase A, the same session that carries the payload).
   For a non-empty `p_rows`, T2 refuses with `SI_UNSAFE_LOGGING` (SQLSTATE 55000) unless
   `current_setting(...)` reports all of:
   - `log_parameter_max_length = 0` and `log_parameter_max_length_on_error = 0`;
   - `log_statement` in (`none`, `ddl`);
   - `log_min_duration_statement = -1` and `log_min_duration_sample = -1`;
   - `log_transaction_sample_rate = 0`.

   The check reads what the server will actually apply to this session at this moment. It cannot
   detect a later system-level change made mid-transaction.
3. **D7 preflight** connects **as `si_collector`** and checks the same effective values; it fails
   closed.
4. **No payload text in errors produced by Milestone 3 code:**
   - RAISE messages and DETAIL carry codes, row indices and field-enum names only (§6.4);
   - phase A must reject every row that a table CHECK would reject, so that a CHECK violation (whose
     standard DETAIL can include the failing row's values) is never reachable from collector input;
   - the library refuses NUL characters before sending, because a `jsonb` input error can quote
     part of the input.

   These are **UNVERIFIED** PostgreSQL behaviours, to be confirmed by M3-T21.
5. **Library:** never logs rows, payloads or error DETAIL values; logs the code, run id and counts only.

**Required negative tests:** M3-T19 (configuration) and M3-T21 (leakage canary).

## 6. Failure handling (PROPOSED)

### 6.1 Codes and SQLSTATE

| Raised message prefix | SQLSTATE | Library result | T3 outcome code | `run_errors` |
|---|---|---|---|---|
| `SI_ISOLATION` | 25000 | `T2Refused` | none | — |
| `SI_UNSAFE_LOGGING` | 55000 | `T2Refused` | none (run stays RUNNING → reaper) | — |
| `SI_BAD_ARGUMENT` (cap, shape of `p_rows`) | 22023 | `T2Refused` | none (run stays RUNNING → reaper) | — |
| `SI_T2_NOT_OWNER` | 23514 | `NOT_OWNER` | none | — |
| `SI_T2_LEASE_EXPIRED`, `…RIGHTS_TERMINATED`, `…SOURCE_SUSPENDED`, `…SOURCE_RETIRED`, `…RIGHTS_CHANGED`, `…RIGHTS_EXPIRING` | 23514 | FAILED | the same code | none |
| `SI_T2_VALIDATION_FAILED` | 23514 | FAILED | `VALIDATION_FAILED` | from DETAIL |
| `SI_T2_DUPLICATE_CONFLICT` | 23514 | FAILED | `DUPLICATE_CONFLICT` | from DETAIL |
| lock timeout | 55P03 | FAILED | `LOCK_TIMEOUT` | none |
| statement timeout 57014, deadlock 40P01, anything else | — | FAILED | `PERSISTENCE_ERROR` | none |
| connection lost | — | no T3 possible | reaper → `LEASE_EXPIRED` | none |

Row-level codes (fit the existing `run_errors.code` regex):
- `INVALID_SHAPE`, `INVALID_NETWORK`, `INVALID_NATIVE_AD_ID`, `INVALID_TEXT`, `INVALID_COUNTRIES`,
  `INVALID_TIMESTAMP`, `INVALID_URL`, `SEEN_ORDER`, `NON_CANONICAL`, `NETWORK_NOT_AUTHORIZED`,
  `DUPLICATE_CONFLICT`.

Payload-level codes (row and field NULL):
- `REQUEST_SCOPE_MISSING`, `REQUEST_HASH_MISMATCH`.

These map to FAILED `VALIDATION_FAILED`; the 0002 FAILED-code CHECK is not altered.

### 6.2 Strict canonical input
The database never normalizes; it rejects anything that is not already in B-001 canonical form:
- strings with no surrounding white space (the JavaScript `trim` set);
- `countries` sorted and unique;
- instants exactly `YYYY-MM-DDTHH:MM:SS.mmmZ` and valid;
- URLs `^https?://` with no user info, matching a conservative grammar;
- no NUL characters.

The database cannot reproduce WHATWG URL normalization, so a value B-001 would normalize (for
example a missing trailing slash) is `NON_CANONICAL`. The library refuses such rows before T1
(§4.1). This is deliberately **stricter than B-001**: B-001 accepts and normalizes such rows.

### 6.3 Fingerprint and counts
- `content_sha256` = SHA-256 of the canonical JSON of the 11 fields without `seenAt`.
- A conflict = a duplicate whose fingerprint differs from the kept (lowest-ordinal) row's. This is
  B-001's relation (`src/ingest.ts`).
- R = rows; U = distinct identities `(network, native_ad_id)` within the run; D = R − U;
  C = conflicting duplicates; P = U; S = 0.
- The same identity in a later run is a new observation, not a conflict.

### 6.4 Diagnostics (DETAIL) — bounded and structured
- Format: `{"v":1,"n":<int 0..1000000>,"e":[{"c":"<CODE>","r":<int|null>,"f":"<field>|null"}, …]}`.
- `e` has length `min(n, 100)` and is ordered by row, then code.
- At most 8 KiB.
- Codes, row indices and field-enum names only — never payload values.

The library parses with `JSON.parse` inside try/catch and validates exactly:
- `v === 1`; `n` an integer in range; `e.length === min(n, 100)`;
- every `c` matches `^[A-Z][A-Z_]{2,40}$`;
- every `r` is null or an integer in `[0, rows.length)`;
- every `f` is null or one of the 11 fields;
- no extra keys anywhere.

**Fallback** — any deviation, or missing DETAIL: T3 with the prefix-mapped code, `error_count = 0`
and no records. Malformed diagnostics are never trusted or logged.

### 6.5 Rollback and T3
- Any error at T2: `ROLLBACK` (a no-op after a failed COMMIT). Everything written in phase D is
  discarded.
- Then one autocommit `si_fail_run(run, token, code, n, codes, rows, fields, correlationId)`.
- If T3 raises, for example because a record is invalid, retry once with no records. If it returns
  false (lease expired, not owner), report `failRecorded = false`; the reaper later records
  `LEASE_EXPIRED` and the specific cause is lost. That is a diagnostic loss, not an integrity loss.
- **Argument that nothing partial survives** (PROPOSED; proven only by M3-T05, T06, T12, T13):
  1. writes happen only in phase D, after every check;
  2. any RAISE or COMMIT failure aborts the whole transaction;
  3. the insert-scoped deferred checks make orphan observations, ads and scopes impossible for any role;
  4. T3 writes only `collection_runs` and `run_errors`.

## 7. Migration strategy (PROPOSED)

**Catalog verification on the baseline** (VERIFIED baseline, local PostgreSQL 16.15 template migrated to 0002):
- `si.si_complete_run(uuid,uuid,integer,integer,integer,integer)` is the only overload;
- it has no `pg_depend` dependents;
- no `si` routine's source references it;
- its shared dependencies are the owner (`si_owner`) and the `si_collector` ACL.

`DROP` without `CASCADE` is therefore sufficient, and the grant must be re-issued.

**0003 up** (one transaction; `src/persistence/migrate.ts` wraps each migration):
1. Create the tables, guards and insert-scoped checks.
2. (Done in 0003: `run_request_scope`, the v1 hash functions and `si_begin_run_scoped`.)
3. `DROP FUNCTION si.si_complete_run(uuid,uuid,int,int,int,int)`, then
   `CREATE FUNCTION si.si_complete_run(uuid, uuid, jsonb DEFAULT '[]')`.
4. `CREATE OR REPLACE` `trg_runs_publish_check` (same signature).
5. `REVOKE ALL … FROM PUBLIC` on every new routine; `GRANT EXECUTE` only on
   `si_complete_run(uuid,uuid,jsonb)` to `si_collector` (`si_begin_run_scoped` is already granted by 0003).

Bootstrap: the two `ALTER ROLE si_collector SET log_parameter_max_length…` settings (§5.1).

**0003 down:**
- drop the new T2;
- recreate the 0002 `si_complete_run` **byte for byte** from `0002_runs.up.sql` and re-grant it to
  `si_collector`;
- `CREATE OR REPLACE` the 0002 `trg_runs_publish_check` body byte for byte;
- drop the checks, guards and tables of that migration (0003's scope objects are reversed by 0003's own down file).

Verified by catalog fingerprint: up → down equals the 0002-only catalog, and up → down → up is identical.

**Required assertions:**
- exactly one `si_complete_run`, with identity arguments `p_run_id uuid, p_lease_token uuid, p_rows jsonb`;
- the 6-argument integer call fails with `42883`;
- `prosecdef`, pinned `search_path`, grantees exactly `{si_collector}`;
- BD1 allowlist = Milestone 2 routines + `si_begin_run_scoped` (FD11);
- the G1 exact privilege matrix covers the three new tables, with no application-role privilege;
- no view or rule depends on `observations`;
- no non-trigger `si` function exposes content columns.

**Existing tests:**
- S4-2's 6-argument call is rewritten to assert `42883`;
- the privilege and scope tests gain the new names;
- 0001 and 0002 stay byte-identical (frozen-checksum test);
- the Step 2 CI mutants remain valid only while `si_begin_run` is not replaced (option C does not replace it; §4.2.2).

## 8. Risk-based acceptance tests (PROPOSED; M3-T07 and the scope-binding parts of M3-T08 and M3-T18 executed as SC-1…SC-14)

Timing thresholds are acceptance gates measured on the CI PostgreSQL 16.15 image (median of 20
runs; p95 reported). They are evidence for that host class only, not guarantees.

| ID | Test | Pass criterion | Risk |
|---|---|---|---|
| M3-T01 | Valid non-empty T2, KEEP_FIRST | Derived counts; P observations; receipt; RETAINED; `retain_until` per FD4 | High |
| M3-T02 | EMPTY T2 (`rows = []`) on pre- and post-0003 runs | Milestone 2 results unchanged; C = 0 | High |
| M3-T03 | Duplicates with identical content, both policies | C = 0; lowest ordinal kept | High |
| M3-T04 | Conflicts under KEEP_FIRST; reordered payload | Lowest ordinal kept; C counted; a different order gives a different hash | High |
| M3-T05 | Conflicts under FAIL_RUN | FAILED `DUPLICATE_CONFLICT`; ≤ 100 coded rows; zero ads, observations or receipts | High |
| M3-T06 | Each row-level code; NUL; non-canonical URL; oversize payload | Exact code and SQLSTATE; nothing written; `SI_BAD_ARGUMENT` triggers no T3 | High |
| M3-T07 | Scoped T1: hash-unbound networks, source, fixture or evidence kind; malformed and hostile input; T1 decisions; no attachment to an existing run; no second or modified scope; retries; concurrency; savepoints; autocommit atomicity; privileges and catalog | Each refused or as specified; no scope row on refusal; no attempt consumed by a refusal. **Executed: SC-2…SC-14 pass (M3-P1).** | **Critical (FD7)** |
| M3-T08 | Row network ∉ bound scope; missing scope with R > 0; `REQUEST_HASH_MISMATCH` at T2 | FAILED `VALIDATION_FAILED`; nothing stored. **Not executable until non-empty T2 exists**; the scope-binding prerequisites are covered by SC-8/SC-9. | **Critical (FD7)** |
| M3-T09 | Concurrent T2s with overlapping identities, both orders (two sessions, blocking proven) | Both complete or one fails cleanly; no 40P01; ads unique | High |
| M3-T10 | Maximum-size T2 + concurrent SUSPEND | SUSPEND waits then records (never 55P03); the run is either COMPLETED with publish seq < suspend seq, or FAILED `SOURCE_SUSPENDED` with nothing stored | **Critical** |
| M3-T11 | Maximum-size T2 + concurrent TERMINATE | As M3-T10, with `RIGHTS_TERMINATED` | **Critical** |
| M3-T12 | Refusal at COMMIT (S4-8 / S4-9 patterns) at maximum size | No ads, observations, receipts or scope changes | High |
| M3-T13 | Connection loss (backend terminated) after the T2 function returns and before COMMIT; and after ROLLBACK, before T3 | Nothing persisted; run RUNNING; reaper → `LEASE_EXPIRED` | High |
| M3-T14 | Benchmark at the cap | Source-lock hold (T2 lock acquired → COMMIT end) median ≤ 2 s and p95 ≤ 5 s; SUSPEND wait p95 ≤ 5 s. Otherwise lower the cap or adopt staged batches. | High |
| M3-T15 | Diagnostics parser: malformed, oversize, extra keys, wrong lengths, missing | Fallback path; no records; nothing logged | Med |
| M3-T16 | Catalog and privileges (§7 assertions) | All hold | High |
| M3-T17 | Migration up/down/up fingerprints; 0001/0002 checksums | Identical | High |
| M3-T18 | JS ↔ SQL parity: `requestSha256` reconstruction (§4.2.3, implemented; corpus in SC-1); v1 fixture hash over a corpus (escapes, control characters, non-BMP, U+2028/2029, NFC edge cases, booleans, null, unknown keys); `ingestOffline` vs database counts on canonical fixtures; a retry of a pre-0003 request key | Equal, or the database fails closed with `REQUEST_HASH_MISMATCH` / `NON_CANONICAL` (never a silent difference); the retry hash is identical | **High (FD9)** |
| M3-T19 | Logging configuration: each §5.1 setting violated in turn, for the collector session (role and session level as applicable) | T2 refuses with `SI_UNSAFE_LOGGING` before any lock; D7 preflight run as `si_collector` fails | High (FD10) |
| M3-T20 | Full existing suite, three passes plus CI; Step 2 mutant scripts | Green | High |
| M3-T21 | **Leakage canary.** Disposable cluster with server logging captured; payloads carry a unique canary string; run successful, validation-failure, conflict, cap-refusal, CHECK-backstop (forced in a test-only path) and NUL cases; then switch on statement and duration logging to confirm T2 refuses | Canary absent from the server log and the library output in every protected case; any presence is a failure that blocks FD10 | High (FD10) |

One targeted mutant only: unsorted ad insertion, which M3-T09 must detect.

## 9. Deferred functionality (0004 or later)

- `publication_gate` (rank 2) and its purpose (FD1).
- Suppression semantics; S stays 0.
- Purge and deletion: `deletion_requests`, the LIFT cleanup gate, and the RETAINED →
  PARTIALLY_PURGED → PURGED transitions. `trg_runs_transition` already allows retention columns to
  change on terminal rows; historical counts stay frozen.
- **Identity lifecycle:**
  - Milestone 3's guards are trigger functions that 0004 replaces to admit only a definer purge routine.
  - Purge deletes observations first (FK `RESTRICT`), then deletes an ad identity when no
    observation references it.
  - Milestone 3's "ad ⇒ observation" check fires on INSERT only, so it never blocks lawful
    deletion or retention cleanup.
  - Whether 0004 tombstones keep a non-reversible identity digest is a 0004 decision.
- **Dynamic retention:** effective end = `least(retain_until, si_retention_end(source, v))`,
  evaluated at purge time and at read time (D8). Termination and retain revocation shorten it
  immediately. `cleanup_within` bounds purge latency, never permission.
- The read function; monitors (receipt `commit_ts`, `within_validity`); D8; cross-source identity
  resolution (`si_resolve_identities`).
- Non-SYNTHETIC evidence; staged-batch T2 if M3-T14 fails.

## 10. Remaining blockers

Implementation blockers:
1. **FD7 acceptance pending:** option C is implemented (0003) and its tests pass. The founder must
   accept the M3-P1 evidence before FD7 is marked VERIFIED. The T2-side scope checks (M3-T08) are
   verified only when non-empty T2 is implemented.
2. **FD9 conditional:** M3-T18 must show v1 hash parity (or deterministic fail-closed behaviour)
   and retry compatibility.
3. **FD10 conditional:** M3-T19 and M3-T21 must pass. No claim of absolute protection from server
   logging is made (§5.1).
4. **FD5 provisional:** M3-T14 must pass on CI hardware.

Production-release blockers (unchanged from Milestone 2):
5. **D8 / G3 (D-M2-10).**
6. **D5b (D-M2-09):** applied and verified on each production database; production preflight must
   fail closed without it.
7. A production host able to perform D5b (`docs/b002-d5b-production-hardening.md`), and an
   independent security review.
8. Retention not enforced in Milestone 3 (FD8). Re-measure M3-T14 on the production host.

Unverified historical requirements:
9. The 2.1, Amendment A–C and IA-1 texts are unavailable. Suppression, the gate and Amendment B
   retention semantics remain unverified (D-M2-05).

### Unverified design assumptions (summary)
- (resolved) the `xmin` mechanism was tested and rejected (§4.2.2);
- SQL v1 hash parity beyond the tested corpus, and on Node/PostgreSQL versions other than Node 22 /
  PostgreSQL 16.15 (unreproducible inputs fail closed: non-ASCII keys, numbers);
- that phase A pre-empts every table CHECK, and that PostgreSQL error text never carries payload
  under the §5.1 controls;
- that the 500-row / 1 MiB cap meets the timing gates (§8, M3-T14);
- that sorted ad insertion prevents deadlock between concurrent T2s (M3-T09).
