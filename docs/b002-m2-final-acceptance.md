# B-002 Milestone 2 — final engineering acceptance matrix (Step 5)

Date: 2026-10-29
Branch: `claude/b002-m2-step5-acceptance`, from Step 4 `3a9c863f3e8062b951213531576b4400fc215aa0`
(CI #107 green on that exact SHA).
Authority: `docs/b002-m2-plan.md` revision 2. Supporting: `docs/b002-persistence.md`,
`docs/b002-m2-step2-acceptance.md`, `docs/b002-m2-step3-lean.md`, `docs/b002-m2-step4-contract.md`.

This matrix is an engineering review. The founder's decisions on it are recorded in the next
section; they do **not** change any evidence status below.

## Status: CONDITIONAL DEVELOPMENT ACCEPTANCE (D-M2-01, 2026-10-29)

Steps 1–5 have been implemented or reviewed against the available revision-2 plan. This is
**not** full historical-contract parity and **not** production approval. Review baseline:
`23fa7ba0bb9b49aecdc54e230339ba2ab5499685` (CI #108 green).

## Founder decisions — Milestone 2 governance closure (2026-10-29)

| Decision | Content | Effect on this matrix |
|---|---|---|
| D-M2-01 | **Conditional development acceptance** of Milestone 2. Not historical-contract parity; not production approval. | None; statuses unchanged |
| D-M2-02 | **BD1 amendment ratified** (Step 3, commit `22df3c3`): `si_collector` may execute `si_heartbeat_run`, `si_fail_run` and `si_reap_expired_runs`, in addition to `si_begin_run` and `si_complete_run`. **No direct application-role table write is authorized.** | Closes F-6. R-PUB stays PARTIAL as evidence (ratification is a policy decision, not new evidence) |
| D-M2-03 | **T2 mechanism approved:** receipt INSERT and COMPLETED UPDATE in one SQL statement, as required for compatibility with immediate constraint checking (CR-IMM). | PB4 stays PARTIAL (queue order inferred, not observed) |
| D-M2-04 | **Conditions (a)/(b) accepted** as documented in `docs/b002-m2-step4-contract.md` C4, against the available revision-2 plan. **No equivalence to the unavailable original Amendment C is claimed.** | Historical equivalence stays UNVERIFIED |
| D-M2-05 | **Historical parity DEFERRED** — neither demonstrated nor waived as satisfied. The 40 BLOCKED identifiers and every PARTIAL and NOT TESTED entry are preserved. | None |
| D-M2-06 | **No additional mutation campaign** is required for closure. Unexecuted mutants (MUT-1…MUT-6, LO1-M) remain recorded verification gaps. | AC2, AC6 stay PARTIAL; MUT rows stay NOT TESTED |
| D-M2-07 | **EMPTY `conflict_count`:** current non-negative behaviour accepted under the frozen contract. **Revisit the semantics before enabling non-empty collection.** | Closes F-1 as a decision; open item before non-empty collection |
| D-M2-08 | **Isolation and timing recorded as limitations**, not proven security failures: heartbeat/T3 accept non-READ COMMITTED callers (correct or fail-closed with 40001 in the Step 5 probe; F-2); S4-8 is timing-sensitive (F-3). | TX-RC, AC3 stay PARTIAL |
| D-M2-09 | **D5b production policy approved** (confirms founder decision A of 2026-10-26, `docs/b002-m2-step2-acceptance.md` "Founder decision A"): advisory-lock EXECUTE hardening is an explicit production operator step; ordinary bootstrap does not apply it; **it has not been applied to production**; production preflight must fail closed without verified hardening. No privilege or bootstrap behaviour changed. | Closes F-5 (texts reconciled); D5b row stays PARTIAL as evidence |
| D-M2-10 | **Absolute release restriction preserved:** no production content-serving path may launch until the G3 clock-to-commit gap is addressed by the D8 fail-closed read gate **and independently verified**. | D8 stays BLOCKED |

### What each category means at closure

- **Implemented:** migration 0002 Steps 1–4 (T1, lifecycle trigger, heartbeat, T3, reaper,
  `run_errors` checks, T2 for EMPTY runs, publication check, receipt guards) and the
  `src/persistence/runs.ts` library; the D5b script and production preflight (not applied).
- **Tested:** the PASS rows below with their cited tests (CI #108: three DB passes, Step 2
  mutant scripts, DR-1). PARTIAL rows are tested only to the extent stated.
- **Accepted design decisions:** D-M2-02, -03, -04, -07, -09. A decision is not evidence and
  does not upgrade any status.
- **Unverified historical requirements:** the 40 BLOCKED identifiers; historical equivalence of
  (a), (b), C-S2′ and the G1 wording (D-M2-04, D-M2-05).
- **Production-release blockers:** D8 / G3 (D-M2-10); D5b applied and verified on the actual
  production databases (D-M2-09); production host capability per
  `docs/b002-d5b-production-hardening.md`; independent security review. Non-empty collection
  additionally requires D-M2-07 to be revisited.

## How to read this

- **PASS** — behaviour verified by the cited test(s) or by a cited catalog/inspection check.
- **PARTIAL** — part verified; the gap is stated.
- **NOT TESTED** — requirement known, no evidence produced.
- **BLOCKED** — the requirement's definition lives only in an unavailable primary source, so no
  test can be shown to prove it. A same-named test is **not** assumed to be equivalent.
- **FAIL** — demonstrated violation. (None found.)
- "UNVERIFIED (historical)" — matches the in-repo restatement; equivalence to the unavailable
  original text cannot be established.

Paths: `0002` = `db/migrations/0002_runs.up.sql`; tests in `tests/db/` unless noted. Catalog
audit A1–A9 = the Step 5 queries recorded under §H.

### Totals (counted mechanically from the tables in §A–§H)

| | PASS | PARTIAL | NOT TESTED | BLOCKED | FAIL | Total |
|---|---|---|---|---|---|---|
| Requirement identifiers | 62 | 28 | 10 | 40 | 0 | 140 |
| Table rows (grouped IDs share a row) | 62 | 21 | 10 | 13 | 0 | 106 |

### Unavailable primary sources (documentation gap, not an implementation defect)

The frozen inputs named in plan line 5 — B-002 revision 2.1, Amendments A and B, **Amendment C
with Revisions 1–3 and the H1 correction**, IA-1 — and the superseded `B-002-M2-PLAN.md`,
`B-002-M2-PLAN-rev1.md` and `B-002-M2-ARCH-CHALLENGE.md` are not in this repository or any of
its 111 commits on 11 branches (searched by path and full text). Most legacy test identifiers in
plan §6 are defined only there. They are therefore BLOCKED below. They are **not** reconstructed here.

Retained interpretations (accepted in Steps 3–4; historical equivalence UNVERIFIED):
- **Condition (b)** = a TERMINATE_RETENTION with `control_seq ≤ publish_control_seq` covers the
  run's version (plan §3.3 `RIGHTS_TERMINATED`). `0002` `si_t2_control_outcome`.
- **Condition (a)** = a SUSPEND/TERMINATE in `(start_control_seq, publish_control_seq]`, or a
  non-LIFT state at `start_control_seq` (plan §3.3 `SOURCE_SUSPENDED`, §4 G1). Same function.
  The commit-time check re-verifies both (stricter than plan line 120, which names only (b)).
- **C-S2′** = clock-free capture of `start_control_seq` (insert trigger) and `publish_control_seq`
  (computed by `si_complete_run` per plan line 113, verified by `trg_runs_publish_check`). The
  `0002:52` column comment says "computed by triggers, steps 2/4"; that comment is inaccurate for
  `publish_control_seq` (finding F-4).
- **Single-statement receipt + completion** (`0002` `WITH receipt AS (INSERT …) UPDATE …`):
  approved mechanism; satisfies the deferred receipt check, CR-IMM and PB4 together.

## A. Founder decisions (plan table)

| ID | Expected behaviour | Implementation | Evidence | Status | Residual risk |
|---|---|---|---|---|---|
| Q1 | T2 publishes EMPTY runs only | `0002` `si_complete_run` refuses non-zero received/duplicate/suppressed | S4-1, S4-2 | PASS | — |
| Q2 | Distinct `SOURCE_SUSPENDED` / `RIGHTS_TERMINATED` codes | CHECKs `runs_rejected_codes`, `runs_failed_codes`; T2 codes | runs-schema S5; S4-5, S4-6 | PASS | — |
| Q3 | T1 during suspension throws, no row | `si_begin_run`, `trg_runs_insert` | T1-3, DS3–DS6 | PASS | — |
| D1 | Publication only via definer `si_complete_run`, source locked before run | `0002` T2 | S4-4, S4-9, privileges SD1, audit A1 | PASS | Owner path, see AC5 |
| D2′ | Controlled protocol; no `current_query()` guard | `src/persistence/runs.ts` `completeRun`; no `current_query` in migrations | S4-12 (PB1), `tests/pb2.test.mjs` | PASS | — |
| D3 | Receipt monitor deferred to 0004 | `commit_ts`, `within_validity` stay NULL; settable once | S4-1, S4-10 | PASS | Monitor absent by design |
| D4 | Consistency constraints (§5) | `0002` CHECKs | runs-schema S1–S10 | PASS | See F-1 |
| D5 | T1 FK lock exception, adversarial tests | T1 takes source KEY SHARE first, so no exception remains | LO4 (revised) | PASS | — |
| D5b | Advisory-lock hardening: conditional | `db/bootstrap/optional/advisory-lock-hardening.sql`, production preflight | MG6–MG10, preconditions D5b tests | PARTIAL | Plan §7 still says "founder decision needed"; `docs/b002-persistence.md` records a decision (production gate). Governance text inconsistent (F-5) |
| D6 | T2 failure codes in the §3.3 order | `si_complete_run` decision chain | S4-2 (LEASE_EXPIRED), S4-5, S4-6 (each code; TERMINATE precedes SUSPEND) | PARTIAL | Precedence verified only for RIGHTS_TERMINATED over SOURCE_SUSPENDED; other orderings by inspection |
| D7 | Operational preconditions asserted | `src/persistence/preconditions.ts`, `cli.js preflight` | preconditions D7 ×3 | PASS | — |
| D8 | Verified commit timestamps + fail-closed read gate | Not implemented (0004) | — | BLOCKED | **Production-release blocker** (release invariant) |

## B. Lock order and rules (plan §2)

| ID | Expected behaviour | Implementation | Evidence | Status | Residual risk |
|---|---|---|---|---|---|
| LOCK-T1 | advisory → `sources` KEY SHARE → run rows | `si_begin_run`, `trg_runs_insert` | LO4, DS7, C5, CC-R, CC-C | PASS | — |
| LOCK-T2 | `sources` FOR SHARE → run FOR UPDATE → receipt → COMPLETED; deferred re-lock | `si_complete_run`, `trg_runs_publish_check` | S4-4 (heartbeat proceeds while T2 waits for the source), S4-7, S5-1 | PASS | Tests show order in the exercised interleavings, not all interleavings |
| LOCK-T3 | T3, heartbeat, reaper: rank 4 only | `si_fail_run`, `si_heartbeat_run`, `si_reap_expired_runs` | S3-8 (reaper with ranks 1+3 held), S4-4 (heartbeat with source FOR UPDATE held), S4-12 (T3 with source FOR UPDATE held) | PASS | — |
| LOCK-R | Rights/controls take rank 3 and never touch runs | 0001 routines | audit A9; controls CC6 | PASS | — |
| LOCK-RET | Retirement FOR NO KEY UPDATE, compatible with T1 KEY SHARE | `sources.retired_at` UPDATE | S5-1 shows retirement waits for T2 (FOR SHARE); KEY SHARE compatibility not exercised | NOT TESTED | Low (PostgreSQL lock-mode table) |
| R-LOCK | No later transaction holding `sources` FOR UPDATE/NO KEY UPDATE requests rank 1/4 | — | audit A9 (0001 writers never reference run tables) | PASS | Applies to future migrations |
| R-PUB | No new app-executable definer routine changes run status unless BD1 amended | BD1 amended at `22df3c3` for heartbeat, T3, reaper | audit A1; privileges SD1 | PARTIAL | Amendment awaits human ratification (F-6) |

## C. Objects (plan §3.1)

| ID | Expected behaviour | Implementation | Evidence | Status | Residual risk |
|---|---|---|---|---|---|
| S2-KEY | Two-key namespaced IMMUTABLE request lock key | `si_request_lock_key`, `si_lock_request_key` | LK | PASS | — |
| S2-ADV | Advisory locks only as `si_owner` | definer T1 / owner trigger | DS1, MG4 | PASS | D5b pending |
| S2-T1 | Definer T1 applies decision table rows 1–5, Q3, then decides | `si_begin_run` | T1-1…T1-6, T1-2b | PASS | — |
| S2-INS | Insert trigger: RC, advisory, numbering, hash, cap, Q3, computed columns, RUNNING re-validation | `trg_runs_insert` | DS2–DS7, LI-T1, T1-5 | PASS | — |
| S2-LIM | Evidence/network checks only in T1 (documented limitation) | — | plan §3.1 text; BAD | PASS | Documented |
| S3-TRANS | INVOKER transition trigger: allowed transitions, immutable identity incl. version, frozen terminal counts, COMPLETED only as `si_owner`, heartbeat bound, computed FAILED fields | `trg_runs_transition` | S3-3, S3-4, S3-5, S4-9, audit A7 | PASS | Owner RUNNING shortcut (fixture path) remains |
| S3-NODEL | No DELETE/TRUNCATE of runs, any role | `trg_runs_no_delete` | S3-1, S3-2 | PASS | DDL not blocked (documented) |
| S3-ERR | `run_errors` append-only; FAILED only; `count = least(error_count,100)` at COMMIT | `trg_run_errors_*` | S3-10…S3-13 | PASS | — |
| S3-HB | Heartbeat: live matching token, `(now, now+5 min]` | `si_heartbeat_run` + transition trigger | S3-4, S3-5, S3-6, S3-9 | PASS | — |
| S3-T3 | Token-checked failure with coded errors, atomic | `si_fail_run` | S3-5, S3-6, S3-10, S3-11, S3-13 | PASS | — |
| S3-REAP | Token-free reaper, rank 4, SKIP LOCKED | `si_reap_expired_runs` | S3-7, S3-8, S3-9 | PASS | — |
| S4-T2 | `si_complete_run` steps 1–8 | `0002` T2 | S4-1…S4-12, S5-1 | PASS | Single-statement mechanism (approved) |
| S4-PUB | Deferred, definer, read-only publication check; no `current_query` | `trg_runs_publish_check` | S4-8, S4-9, S4-11, audit A7/A8 | PASS | — |
| S4-RCPT | Receipt ⇒ COMPLETED at COMMIT; guard: monitor columns NULL→value once; no DELETE/TRUNCATE | `trg_receipts_run_completed`, `trg_receipts_guard` | S4-10 | PASS | — |

## D. Transactions (plan §3.2)

| ID | Expected behaviour | Implementation | Evidence | Status | Residual risk |
|---|---|---|---|---|---|
| TX-T1 | BEGIN / `si_begin_run` / COMMIT; typed refusals | `t1Preflight` | LIB, T1-4 | PASS | — |
| TX-T2 | Exactly BEGIN / `si_complete_run` / COMMIT; on error ROLLBACK then T3 with mapped code | `completeRun` | S4-12 (protocol, LOCK_TIMEOUT), S4-2/4/5/6 (mapping + T3) | PASS | `PERSISTENCE_ERROR` fallback path not exercised |
| TX-RC | All run transactions READ COMMITTED | Refused in T1, insert trigger, T2, publication check, reaper | LI-T1, S4-2, S3-7 | PARTIAL | Heartbeat and T3 do not refuse; Step 5 probe: REPEATABLE READ either behaves correctly or fails with 40001 (fail-closed) (F-2) |
| TX-C7 | Canonical request hash | `src/persistence/request-hash.ts` | `tests/request-hash.test.mjs` C7 | PASS | — |

## E. Guarantees (plan §4)

| ID | Expected behaviour | Implementation | Evidence | Status | Residual risk |
|---|---|---|---|---|---|
| G1 | No SUSPEND/TERMINATE in `(start, publish]`, clock-free; holds under IMMEDIATE | source FOR SHARE to end of T2; control check | S4-4, S4-5, S4-7 (CR-IMM) | PASS | Historical (a)/(b) wording UNVERIFIED |
| G2 | No rights version, control or retirement commits while T2 is open | same lock | S4-7 (control), S5-1 (rights version, retirement) | PASS | — |
| G3 | Clock validity only at last check; not durable | documented wording | `README.md:49`, `docs/b002-persistence.md` "Publication timing", Step 4 contract | PASS (documented) | **Not a guarantee**; D8 must close before serving |

## F. Consistency constraints (plan §5)

| ID | Expected behaviour | Evidence | Status | Residual risk |
|---|---|---|---|---|
| CON-EMPTY | EMPTY ⇔ COMPLETED ∧ published 0 ⇔ retain_until NULL; final; duplicates cannot make zero | runs-schema S3, S4; S4-1 | PASS | — |
| CON-CONF | FAIL_RUN never completes with conflicts | runs-schema S4 | PASS | F-1 (KEEP_FIRST) |
| CON-ERR | `error_count = 0` unless FAILED; count at COMMIT | runs-schema S4; S3-10…S3-13 | PASS | — |
| CON-CODES | Codes per status | runs-schema S5 | PASS | — |
| CON-SEQ | `publish_control_seq` iff COMPLETED, ≥ start | runs-schema S6; S4-1 | PASS | — |
| CON-IA1 | Version belongs to source; NULL only REJECTED/NO_RIGHTS; receipts name own run | runs-schema S7, S9; S4-1, S5-1 | PASS | — |
| CON-RETRY | Rows 1–5 precede suspension throw; REJECTED RIGHTS_TERMINATED consumes an attempt; throw does not; ALREADY_COMPLETED after completion | T1-3, T1-2b, T1-4, T1-6, S4-1 | PASS | — |

## G. Plan §6 test identifiers

| ID | Plan description | Evidence | Status | Note |
|---|---|---|---|---|
| LO1 | Adversarial two-session lock-order test | S4-4 | PASS | — |
| LO1-M | Mutant must deadlock | — | NOT TESTED | Not executed |
| LO1-ref | — | — | BLOCKED | Undefined in repo |
| LO2, LO3, LO5, LO6, LO7 | — | — | BLOCKED | Undefined in repo |
| LO4 | T1 source lock before run lock | LO4 (revised) | PASS | — |
| LO4b | Real-object Y6: T1 reaping, T2, R | S5-1 (added in Step 5) | PASS | "Y6" undefined: historical equivalence UNVERIFIED |
| LO4c | Deliberate advisory cycle → 40P01, no partial state | — | NOT TESTED | Residual risk without D5b (plan §7) |
| BD1 | Definer × grantee allowlist | SD1, S4-11, audit A1 | PASS | Step 3 amendment awaits ratification |
| BD2 | Transition not definer; publication check no DML | S3-4, S4-11, audit A8 | PASS | — |
| BD3 | Hostile `search_path` | SD1 (every `si` routine pinned), SD3 (behavioural, rights routine only), audit A5 | PASS | Behavioural only for one routine; catalog for all |
| BD4 | Rights/control routines leave runs untouched | audit A9; 0001 predates 0002 and is frozen | PASS | By inspection |
| BD5 | No app `SET ROLE si_owner`; only `si_migrator`, SET only | MG1, MG1b, audit A4 | PASS | — |
| CR-IMM | IMMEDIATE + SUSPEND waits; `publish < suspend.control_seq` | S4-7 | PASS | — |
| PB1 | Library sends exactly BEGIN / function / COMMIT | S4-12 | PASS | — |
| PB2 | No `SET CONSTRAINTS` / `PREPARE TRANSACTION` in `src/` | `tests/pb2.test.mjs` | PASS | Comments excluded by design |
| PB3 | Forensic `commit_ts − rights_checked_at` under IMMEDIATE + pause | — | NOT TESTED | Forensic; documents G3 only |
| PB4 | Receipt queued before publication check | S4-7 (IMMEDIATE succeeds), S4-9 (update-before-receipt shape fails) | PARTIAL | Queue order inferred from executor semantics, not observed |
| C1, C4, C8 | 2.1 §C retry/hash cases | T1-4 (labelled) | PARTIAL | Definitions unavailable; label only |
| C2, C3 | 2.1 §C | — | BLOCKED | Same-named Amendment C tests in `controls.test.mjs` are a different namespace; not assumed equivalent |
| C5, C6 | Request-key serialization | C5, C6 (t1) | PARTIAL | Label only |
| C7 | Canonical request hash | `tests/request-hash.test.mjs` | PARTIAL | Label only |
| C9, C10 | Attempt cap; live/expired attempt | T1-5, T1-6 | PARTIAL | Label only |
| L1, L2, L4, L6, L7, L8 | — | — | BLOCKED | Undefined in repo |
| LS1, LS2 | — | — | BLOCKED | Undefined in repo |
| IA1, IA1b, IA1c | IA-1, "behavioural" | runs-schema S7, S9 (constraint level); S4-1 | PARTIAL | Behavioural form undefined; label only |
| A2 | EMPTY (plan §5) | runs-schema S3; S4-1 | PASS | Against §5 text; original A2 test spec UNVERIFIED |
| A3, A4, A5, A6, A7, A10 | — | (A4 contract: SD1, SD3) | BLOCKED | Undefined test specs |
| A11 | Window outlasts margin + lease | T1-2 (`t2-a11-near`) | PASS | Content stated in `0002` comment |
| E3 | EMPTY | runs-schema S3 ("schema part") | PARTIAL | Only schema part labelled |
| E6 | — | T1-4 (labelled) | PARTIAL | Label only |
| E1, E2, E4, E5, E7 | — | — | BLOCKED | Undefined |
| CR1 | Suspended T1 | T1-3 (labelled) | PARTIAL | Label only |
| CR2, CR3, CR4, CR4b, CR5, CR6, CR7 | — | — | BLOCKED | Undefined |
| CK-R, LI-R | — | — | BLOCKED | Undefined |
| EC1, EC2 | — | runs-schema S4 (labelled) | PARTIAL | Label only |
| EC3 | — (named for Step 3) | — | BLOCKED | Undefined |
| EC4 | — | runs-schema S9 ("schema part") | PARTIAL | Label only |
| EC5 | — | T1-6 (labelled) | PARTIAL | Label only |
| I4′ | Teardown | — | BLOCKED | Undefined |
| H2 | Forensic | — | BLOCKED | Undefined |

## H. Mutants (plan §6) and acceptance criteria (plan §9)

Step 5 instructions exclude a mutation campaign. Step 2's nine mutant scripts run in every CI
build. The six Step 3/4 mutants below were **not executed**; the "expected killer" column is an
argument, not evidence.

| ID | Mutant | Expected killer | Status |
|---|---|---|---|
| MUT-1 | Trigger-based source locking / COMPLETED outside the function | S4-9, S4-4 | NOT TESTED |
| MUT-2 | Function locks run before source | S4-4 (heartbeat would hit lock_timeout) | NOT TESTED |
| MUT-3 | `trg_runs_transition` SECURITY DEFINER | S3-4, S4-11 (catalog) | NOT TESTED |
| MUT-4 | Update before receipt | S4-7 (IMMEDIATE) | NOT TESTED |
| MUT-5 | Second collector definer routine updating runs | SD1 allowlist | NOT TESTED |
| MUT-6 | `si_complete_run` without the `sources` lock | S4-4, S4-7 | NOT TESTED |
| MUT-S2 | Step 2 mutant scripts (M1–M6, D5b, roles, idempotency) | CI `integration` job | PASS |

| ID | Criterion (plan §9) | Evidence | Status |
|---|---|---|---|
| AC1 | Every test passes 3 consecutive local runs on PG16 and in CI | CI runs `npm run test:db` 3× per build; local 3× | PASS |
| AC2 | Every non-equivalent mutant killed | Step 2 executed; Step 3/4 mutants not executed | PARTIAL |
| AC3 | No correctness assertion depends on clocks or commit timestamps | Commit-time rollback also shown clock-free (S4-9). S4-8, S4-6 (RIGHTS_EXPIRING), S3-7/S3-9, S4-2 expiry rely on the DB clock advancing; S4-8 needs T2 within 1.5 s | PARTIAL |
| AC4 | 0001 byte-identical | migrations "0001 is frozen" | PASS |
| AC5 | No path to COMPLETED except `si_complete_run` | App roles: S4-9, G1 privileges, audit A2. `si_owner` (reachable only via `si_migrator`) can still write a valid receipt + COMPLETED that passes the commit-time check, which plan §3.1 permits | PASS |
| AC6 | LO1 passes and LO1-M deadlocks | LO1 = S4-4; LO1-M not executed | PARTIAL |
| AC7 | BD1 and BD2 hold | §G | PASS |
| AC8 | CR-IMM proves G1 without deferral | S4-7 | PASS |
| AC9 | Docs use §4 wording | `docs/b002-persistence.md` "Publication timing"; Step 4 contract | PASS |
| AC10 | Release invariant in README and persistence docs | `README.md:49`; `docs/b002-persistence.md` | PASS |
| SEQ-5 | §8 step 5: parity extension, all mutation sets, docs | Docs updated (Step 5); parity extension undefined and not done; mutation sets as AC2 | PARTIAL |
| SEQ-6 | §8 step 6: three runs, CLI cycle, CI, PR (not merged) | Runs + CI PASS; "CLI cycle" undefined beyond `cli.js preflight` (D7); no PR opened (not requested) | PARTIAL |

**Catalog audit (Step 5, fresh migrated template):** A1 definer routines = {T1, T2, T3,
heartbeat, reaper} → `si_collector`; {rights, controls} → `si_rights_admin`; three commit-time
trigger functions with no grantee. A2 no app-role table write privilege. A3 only
`si_rights_admin` UPDATE on `sources.retired_at`, `conflict_policy`. A4 `si_owner` member:
`si_migrator` only (SET, no INHERIT, no ADMIN). A5 every `si` function pins `search_path`. A6
nothing granted to PUBLIC. A7 deferral/definer flags as specified. A8 no DML in definer trigger
functions. A9 0001 write routines never reference run tables.

## Findings (none is a demonstrated contract violation)

- **F-1 (low).** T2 accepts `conflict_count > 0` for an EMPTY run (`received_count = 0`) when the
  source policy is KEEP_FIRST (Step 5 probe). No frozen rule forbids it (plan §5 constrains
  FAIL_RUN only; Step 4 contract C7 allows `conflict ≥ 0`); no publication or security effect.
  Human decision: forbid in a later step, or accept.
  **Disposition: D-M2-07** — accepted for EMPTY runs; revisit before non-empty collection.
- **F-2 (low).** Heartbeat and T3 do not refuse non-READ COMMITTED callers; behaviour is correct
  or fails with 40001 (Step 5 probe). Deviation from the §3.2 heading only.
  **Disposition: D-M2-08** — recorded limitation, not a proven security failure.
- **F-3 (low).** S4-8 is timing-sensitive (1.5 s budget); a slow host fails it (false negative,
  never a false pass). Clock-free evidence of commit-time rollback: S4-9.
  **Disposition: D-M2-08** — recorded limitation.
- **F-4 (documentation).** `0002:52` comment attributes `publish_control_seq` to triggers. Left
  unchanged: editing an applied migration changes its checksum.
  **Disposition:** remains a known comment inaccuracy; applied migration SQL is not edited.
- **F-5 (governance).** Plan §7 says D5b needs a founder decision; `docs/b002-persistence.md`
  records one (production operator step + `preflight --production`). Reconcile the texts.
  **Disposition: D-M2-09.** Correction to the Step 5 wording: the decision was already recorded
  as founder decision A (2026-10-26) in `docs/b002-m2-step2-acceptance.md` and
  `docs/b002-d5b-production-hardening.md`; the stale texts were plan line 19, plan §7 and
  `docs/b002-m2-windows-local-acceptance.md`. Dated decision notes were added to them at
  closure; their original wording is kept as the historical record.
- **F-6 (governance).** BD1 amendment (Step 3, `22df3c3`) awaits ratification.
  **Disposition: D-M2-02** — ratified.

## Gap classification

| Class | Items |
|---|---|
| Documentation-only | F-4, F-5; `docs/b002-persistence.md` M2 status (corrected in Step 5) |
| Existing evidence sufficient after review | BD3, BD4, R-LOCK, AC5, LOCK-T3 |
| Required a focused test (added) | LO4b / G2 for rights versions and retirement → S5-1 |
| Requires a code correction | none demonstrated |
| Not done by instruction or low value | Step 3/4 mutants (AC2, AC6), PB3, LO4c, LOCK-RET, parity extension |
| Blocked by unavailable primary sources | all BLOCKED rows in §G; historical equivalence of (a), (b), C-S2′, G1 wording |
| Human decision | F-1, F-5, F-6; acceptance of the single-statement mechanism and (a)/(b) mapping — **decided at closure**: D-M2-07, D-M2-09, D-M2-02, D-M2-03, D-M2-04. Evidence statuses unchanged. |

## Release boundaries (unchanged; see D-M2-10)

- Milestone 2 completes **EMPTY** runs only (Q1); non-empty counts are refused.
- No live advertisement collection exists; sources are SYNTHETIC only (0001 CHECK).
- No production content-serving path exists or is authorized; D8 is a mandatory release blocker.
- G3 is documented as a non-guarantee.
- D5b is not applied by bootstrap; production preflight fails closed without it.
- No merge, deployment or Milestone 3 work.
