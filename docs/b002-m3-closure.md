# B-002 Milestone 3 — governance closure and release readiness (M3-CLOSE-01)

**Status:** CLOSURE REVIEW, pending founder and independent acceptance. This document does not approve itself.

- **Scope:** documentation only. No migration, source, test or CI change; no merge; no deployment.
- **Baseline:** `a0b63183f3c0e16f187287a42d2ab6c9ab5d01fd` (M3-P3D).
- **Branch:** `claude/b002-m3-close-01`.
- **Reproduction date:** 2026-11-11, on disposable PostgreSQL 16.15. The compose image is pinned to `sha256:f1c3376c…94`.

> **Independence caveat.** The same author who implemented Milestone 3 performed this review. It re-derives
> its findings from the repository, the catalog and fresh runs rather than from earlier reports. It is still
> **not** the independent verification that D-M2-10 requires for D8/G3.

Companion documents:
- `docs/b002-m3-risk-register.md` (risks R-01…R-18);
- `docs/b002-m3-audit-proposal.md` (M3-AUD-01, not implemented);
- `docs/b002-m4-options.md` (the next-milestone recommendation).

## 1. Summary

| Item | Result |
|---|---|
| Development acceptance of the synthetic baseline (A) | **CONDITIONAL GO.** The conditions are in §7 |
| Controlled internal pilot with real authorized evidence (B) | **NO-GO.** The blockers are in §7 |
| Customer-facing production (C) | **NO-GO** |
| Security invariants (12) | 11 VERIFIED (development scope, not independent). 1 PARTIAL: invariant 10 has an audit aspect, A1 |
| Reproduction (§6) | Every required check ran and passed. A1 reproduced as a known weakness |
| Discrepancies found | 6 documentation or governance items (§3.3). No code defect |
| Recommended next milestone | M3-AUD-01, the durable read audit (Track A) |

## 2. Repository inspection

### 2.1 Branches, commits, worktrees
- A single worktree.
- Baseline a0b6318 is 104 commits ahead of `origin/main`, and nothing in Milestone 3 has been merged.
- The first-parent chain is linear:
  `5b87909 → 3ecb201 → d33d06b (P2B) → c0b2cce (P3A) → 6eca7a7 (P3B) → 4c17ceb (P3C) → a0b6318 (P3D)`.
  Each milestone commit is the parent of the next, so no milestone was rebuilt or bypassed.

### 2.2 Migrations
Sixteen files (0001–0008, up and down) pass the runner's checksum verification. Each migration's down step restores the previous catalog byte for byte, and its up step re-applies identically. Tests M1 and M1b–M1h verify this, and data-carrying variants cover retention (RT-14) and verification (VR-16).

| Migration | Milestone | Main objects |
|---|---|---|
| 0001 | M1 | sources, rights versions, controls. CHECK `evidence_kind IN ('SYNTHETIC')` |
| 0002 | M2 | runs, T1 `si_begin_run` |
| 0003 | M3-P1 | scoped T1 `si_begin_run_scoped` (FD7) |
| 0004 | M3-P2A | T2 signature without caller counts (FD3) |
| 0005 | M3-P2B | non-empty T2 `si_complete_run`, ads, observations, receipts, evidence guards |
| 0006 | M3-P3A | effective retention, `si_purge_due`, purge log and failures (FD12/FD13) |
| 0007 | M3-P3B | `si_verify_receipts`, `si_receipt_verdict`, `si_evidence_readable`, receipt guard (FD14/FD15) |
| 0008 | M3-P3C | reader grants, `si_read_evidence`, `si.reader_access_log` (FD16/FD17) |

### 2.3 Roles, grants and SECURITY DEFINER functions
These were checked against the live catalog of the migrated template (schema version 8), not against documentation:

| Grantee | EXECUTE (SECURITY DEFINER, fixed `search_path`, no PUBLIC) |
|---|---|
| `si_collector` | `si_begin_run`, `si_begin_run_scoped`, `si_complete_run`, `si_fail_run`, `si_heartbeat_run`, `si_reap_expired_runs` |
| `si_rights_admin` | `si_record_rights_version`, `si_record_source_control`, `si_grant_reader`, `si_revoke_reader` |
| `si_retention` | `si_purge_due`, `si_record_purge_failure`, `si_retention_status`, `si_purge_failures` |
| `si_monitor` | `si_retention_status`, `si_purge_failures`, `si_verify_receipts`, `si_verification_status`, `si_verification_failures`, `si_record_verification_failure` |
| `si_reader` (group) | `si_read_evidence` only |

Other facts from the catalog:
- No role can execute the trigger functions or the internal helpers (`si_evidence_readable`, `si_receipt_verdict`, `si_commit_ts`).
- Table grants to application roles are SELECT only, on metadata and audit tables.
- **No application role holds any privilege on `si.ads` or `si.observations`.** Only the test superuser `si_bootstrap` does.
- Tests G1, SD1, SR-0, EV-7, RT-11 and VR-13 assert this matrix exactly.

### 2.4 Behaviour inspected in source

| Area | Where |
|---|---|
| Collection and completion | `si_begin_run_scoped` (0003), `si_complete_run` (0005); library `src/persistence/runs.ts` |
| Receipt verification | `si_verify_receipts`, `si_receipt_verdict`, `trg_receipts_guard` (0007); `src/persistence/verification.ts` |
| Rights enforcement | `si_record_rights_version`, `si_record_source_control` (0001); the predicate `si_evidence_readable` (0007) |
| Reader authorization | `si_read_evidence`, `si_reader_principal_ok`, `si_reader_session_problem`, `trg_reader_grants_guard` (0008); `src/persistence/reader.ts` |
| Retention and purge | `si_effective_retention_end`, `si_purge_due`, `trg_runs_purge_check`, `trg_observation_purge_check` (0006); `src/persistence/retention.ts` |
| Audit | append-only triggers on `purge_log`, `purge_failures`, `receipt_verifications`, `verification_failures` and `reader_access_log` |
| Operational | `src/persistence/preconditions.ts`, `production-readiness.ts`, `cli.ts` |
| CI | `.github/workflows/ci.yml`. Jobs: `test` (Node 22/24), `integration` (3 suite passes, 10 mutation scripts, DR-1), `slow-deadline`, `lifecycle-demo` (3 runs plus mutants) |

## 3. Milestone evidence reconciliation

### 3.1 Ancestry, migrations, privilege changes

| Milestone | Commit | Migration added | Privilege change (BD1) | DB tests |
|---|---|---|---|---|
| P2B | d33d06b | 0005 | none (T2 already granted) | 199 |
| P3A | c0b2cce | 0006 | FD13 (`si_retention`, `si_monitor`) | 219 |
| P3B | 6eca7a7 | 0007 | FD15 (`si_monitor` verification) | 246 |
| P3C | 4c17ceb | 0008 | FD17 (`si_reader`, `si_rights_admin` grants) | 270 |
| P3D | a0b6318 | none | none | 270 (demo added) |

Each privilege change appears in the catalog exactly as recorded in design §2.1. No undeclared grant was found.

### 3.2 Hosted CI evidence (GitHub Actions, workflow "CI")

| Run | Commit | Conclusion |
|---|---|---|
| #111 | cfb041d | success |
| #112 | 5b87909 | success |
| #113 | 3ecb201 | **failure**: a DR-1 port collision. Fixed in the next commit, by using a Docker-assigned port |
| #114 | d33d06b | success |
| #115 | c0b2cce | success |
| #116 | 6eca7a7 | success |
| #117 | 4c17ceb | success |
| #118 | a0b6318 | success. 7 jobs: test ×2, integration, slow-deadline, lifecycle-demo ×3 |

### 3.3 Discrepancies and unsupported claims

1. **README "Next gates" item 2** said "Close D8/G3 … before any evidence read path". An internal read path exists since 0008, so the claim was stale. **This closure corrects it.**
2. **`docs/b002-persistence.md:231`** says D8 is "planned for 0004". This is historical and stale: D8 work landed in 0007/0008. It is left unchanged as a historical document and noted here as an erratum.
3. **Design §13.7, last bullet**, says the read gate "does not exist". It was written at P3B and has been superseded by 0008 (§14). This is also noted as an erratum.
4. **Design §1** is headed "Frozen scope (PROPOSED)". That label is historical; the scope was implemented and accepted milestone by milestone.
5. **FD13, FD15 and FD17** are recorded as "ACCEPTED with M3-P3x". Those acceptances were inferred from the acceptance of the baseline; there is no explicit founder sign-off of the BD1 amendments. **An explicit confirmation is required (condition A-2).**
6. **The P3D final report** said that the 2 UNVERIFIABLE verdicts exceeded the scenario-named runs. That is incorrect. The 2 are:
   - N6, the disturbed identity;
   - N14's earlier run, purged before verification (NO_EVIDENCE, the VR-10 behaviour).

   Also, `runs_completed` = 10 does not count the N5 run, whose completion finished after the deadline wait. These figures match the counts reproduced in §6.

No claim of production readiness was found in code or documentation. Every milestone document marks itself as synthetic, pending acceptance, and not production.

## 4. Security invariants

Classification scope: **development and synthetic, self-verified.** "VERIFIED" means:
- the implementation enforces the invariant in the database;
- a test asserts it;
- where one exists, a mutant that removes the check is detected;
- it reproduced on 2026-11-11.

It does **not** mean that the invariant has been independently verified or tested in production.

| # | Invariant | Class | Enforcement (file / function) | Tests and mutants | Commit |
|---|---|---|---|---|---|
| 1 | Unauthorized collection refused | VERIFIED | `si_begin_run` / `si_begin_run_scoped` check current rights, controls, retirement and networks under the source lock (0002/0003). `si_complete_run` re-checks authority before scope (0005) | T1-2, T1-2b, T1-3, CC-R, CC-C, CP-6, EV-3; mutants M2-R and M2-C (`step2-rights-controls`), M1 (`step2-source-lock`) | M2 (T1), d33d06b (T2) |
| 2 | Evidence bound to its scope | VERIFIED | Scoped T1 binds the request and fixture hashes and the network array (0003). T2 requires exactly the bound fixture (0005). The receipt identity is the transaction id, and the observations share it (0007) | SC-1…SC-14, EV-1, EV-2, EV-3, CP-2, VR-6; demo H3, H6, N6 | d33d06b, 6eca7a7 |
| 3 | Completion atomic and idempotent | VERIFIED | `si_complete_run` runs as a single transaction. Deferred constraint triggers (`trg_observation_run_completed`, `trg_ad_has_observation`) refuse any partial state at COMMIT. T1 uses an idempotency key and request-key lock | EV-6, CP-7, EV-13, T1-4, C5, C6, VR-1 (idempotent verdict), VR-9; mutant `step2-idempotency` | d33d06b |
| 4 | Unverified evidence not retrievable | VERIFIED | `si_evidence_readable` requires a VALID verification row, and `si_read_evidence` applies it for every run (0007/0008) | VR-11, RD-4 (missing verification); mutant RD-M verdict; demo-mutant verdict (N6) | 6eca7a7, 4c17ceb |
| 5 | INVALID and UNVERIFIABLE evidence unreadable | VERIFIED | The same predicate; the verdict is computed from `pg_xact_commit_timestamp` and never taken from the caller (`si_receipt_verdict`) | RD-4, VR-2/VR-3 (slow job), VR-6, VR-7, VR-8; demo N5 (real deadline) and N6 | 6eca7a7 |
| 6 | Rights changes affect subsequent reads | VERIFIED | The read takes `sources FOR SHARE` (rank 3), and rights and control writers take `FOR UPDATE`. The predicate is evaluated per call against current rights | RC-1…RC-6, RC-7, VR-4, RD-7; demo H11 | 4c17ceb |
| 7 | Suspension and termination fail closed | VERIFIED (timing on the test image only) | The predicate refuses while SUSPENDed or TERMINATEd; a waiting read is bounded by lock_timeout 2 s (SI_READ_BUSY) | RD-5/RD-6, RC-1…RC-7, RC-9, C1…C7, LR1, LR2; demo N8 and N9 | 4c17ceb |
| 8 | Retention expiry prevents retrieval | VERIFIED | The predicate uses `si_effective_retention_end` = least(retain_until, current rights end), so retrieval is refused at read time even before purge | RD-5, RC-8, RT-3, RT-15 (slow job); RD-M retention mutant; demo-mutant retention (N7) | c0b2cce, 4c17ceb |
| 9 | Purge removes evidence with no orphan identities | VERIFIED | `si_purge_due` deletes observations and then orphan ads. `trg_runs_purge_check` and `trg_observation_purge_check` refuse inconsistent states. SKIP LOCKED is used against busy sources | RT-2, RT-5, RT-6/RT-7, RT-8, RT-9, RT-10; demo H12, H13, N14 | c0b2cce |
| 10 | Readers cannot bypass the bounded interface | **PARTIAL** | Data access is VERIFIED: readers have EXECUTE on `si_read_evidence` only, no table privileges, identity from `session_user`, and SET ROLE and service roles are refused. **The audit aspect fails:** a reader can obtain data while erasing its access record by rolling back (A1) | SR-0, RD-2, RD-10, RD-12, RD-13, G1, SD1; demo A1 reproduces the gap | 4c17ceb, a0b6318 |
| 11 | No customer-display rights introduced | VERIFIED | CHECKs `rights_versions_subscriber_display_check`, `_export_check` and `_media_mirror_check` allow only DENIED/UNKNOWN. The reader grant purpose is fixed to `INTERNAL_SYNTHETIC_EVALUATION` (FD16). URLs are not returned | Rights tests; RD-1 (fields); demo H2 and H9. No endpoint, export or display code exists (inspection) | 4c17ceb |
| 12 | No application role can mutate protected evidence | VERIFIED | The catalog shows no privilege on `si.ads` or `si.observations`. Append-only triggers apply even to the owner, and receipt and evidence guards are in place | EV-7, RT-1, RT-11, VR-8, VR-13, G1, SD1; mutants M6-WRITE, M6-EXEC (`step2-privilege-boundary`), `step2-d5b` | M2 onward; d33d06b → 4c17ceb |

Trust boundary for all twelve: a superuser, `si_owner` and the migrator are outside the boundary (design §13.7). The demonstration's fixtures rely on that deliberately.

## 5. Operational readiness

"Implemented" means the code exists and is tested. "Exercised in production" is **no** for every row, because no production deployment exists.

| Control | Implemented safeguard | Exercised in production | Gap |
|---|---|---|---|
| D8/G3 independent verification | Verifier, predicate and read gate (0007/0008) | No | No independent reviewer has looked at it (R-02) |
| D5b host | Runbook `docs/b002-d5b-production-hardening.md`; mutant `step2-d5b`; preflight checks | No | No host exists (R-03) |
| D7 startup enforcement | `assertProductionReady` requires a live collector session and safe logging (PR-1…PR-5; mutant `p3b-production-gate`) | No | Enforced only by the CLI when `SI_PRODUCTION=1` is set; no long-running entry point exists (R-04) |
| Commit-timestamp settings | `track_commit_timestamp` checked by the preconditions; with it off, verification is UNVERIFIABLE and fails closed (VR-12) | No | Configuration management (R-07) |
| Transaction-ID age monitoring | `si_verification_status` reports the xid age; the age limit is 100M | No | No alerting (R-05) |
| Verification scheduling | `si_verify_receipts` is batch, idempotent and concurrent-safe (VR-9) | No | Nothing schedules it (R-05) |
| Retention scheduling | `si_purge_due` uses SKIP LOCKED and is audited; `si_retention_status` | No | Nothing schedules it; deletion deadlines depend on it (R-06) |
| Backup and restore | DR-1 logical clean-cluster restore runs in CI and locally | No | PITR and physical backup are untested (R-08) |
| Clock assumptions | `CLOCK_INCONSISTENT` check; CK1 | No | A monotonic clock is assumed (R-09) |
| Logging and data minimization | FD10 preconditions; canaries EV-11, EV-12, RD-11; demo L1 and the report self-scan | No | The operator's log pipeline outside PostgreSQL is not covered |
| Crash recovery | Atomic T2; lease expiry and reaping (T1-6, mutant M3); interrupted purge (RT-10) | No | Real crashes were not injected (PostgreSQL WAL semantics assumed) |
| Deployment and ownership | Least-privilege migrator, catalog fingerprint, checksums | No | No deployment owner or on-call is designated |

## 6. Reproduction on disposable PostgreSQL 16.15 (2026-11-11, baseline a0b6318)

All checks were run in this session. Raw outputs were kept in the session scratchpad and are not committed.

| # | Check | Command | Result |
|---|---|---|---|
| 1 | Migrations | migrator on a fresh compose DB | 16/16 checksums OK; schema version 8 |
| 2 | Full demonstration | `bash demo/run.sh` | **PASS: 30 passed, 0 failed, 0 skipped**. 460,620 ms, of which the real deadline wait was 459,873 ms. PostgreSQL 16.15 |
| 3 | Demonstration mutants | `bash demo/run-mutants.sh` | **3/3 KILLED**:<br>• grant mutant: H11, H13, N1, N2, N10 failed;<br>• retention mutant: N7 failed;<br>• verdict mutant: N6 failed |
| 4 | DB regression suite ×3 | `node tests/db/run.mjs` ×3 on one fresh compose DB | **270/270, 270/270, 270/270**. 136 s, 139 s and 136 s |
| 5 | Unit tests and typecheck | `npm test`, `npm run typecheck` | **52/52**; 0 type errors |
| 6 | Mutation scripts | `tests/mutations/*.mjs` (10 scripts) | **All exit 0, every mutant KILLED**:<br>• D5b MG10;<br>• roles MG1b;<br>• T1 idempotency;<br>• M5 isolation;<br>• M4 attempt cap;<br>• M1 source lock;<br>• M2-R and M2-C;<br>• M3-LIVE and M3-REAP;<br>• M6-WRITE and M6-EXEC;<br>• the D7 production gate.<br>Every mutated migration was restored byte for byte (sha256 `dcbdaa30…da4b`) |
| 7 | DR-1 | `bash tests/restore/clean-cluster.sh` | **PASS**. A fresh-cluster logical restore, followed by the security, retention, verification, gate and reader checks on the restored cluster |
| 8 | Rollback and reversibility | migrations suite within #4 | M1 and M1b–M1h pass, plus the data-carrying variants RT-14 and VR-16 |
| — | Slow deadline job | `tests/slow/m3-deadline.test.mjs` and `commit-ts-off.sh` | See §6.1 |

Demonstration counts reproduced:

| Area | Counts |
|---|---|
| Runs | 14 started, 10 completed, 2 failed |
| Records | 45 received, 43 published, 2 duplicates, 1 conflict |
| Verification | 8 VALID, 1 INVALID, 2 UNVERIFIABLE, 0 pending |
| Reads | 24 authorized calls, returning 72 records |
| Denied reads | NOT_AUTHORIZED 7, BAD_CURSOR 3, BAD_ARGUMENT 1, UNSAFE_SESSION 1 |
| Purge | 4 runs, 32 observations, 31 identities |
| Audit | 4 purge-log records, 24 reader-access records, **1 access record lost on rollback (A1)**, 11 verification records |

Resources: Node RSS 58 MB; database 9.6 MB.

### 6.1 Slow job
Both were run on a fresh compose database.

| Check | Command | Result | Duration |
|---|---|---|---|
| Real rights deadlines (VR-2, VR-3, RT-15) | `node tests/db/run.mjs tests/slow/m3-deadline.test.mjs` | **PASS (1/1)**. The G3 bypass is detected as INVALID, the deferred protocol refuses, and the RT-15 expiry purge runs | 461 s |
| Window-end mutant, inside the same test | — | **KILLED**. The baseline verdict is INVALID; with the mutant, the verdict becomes VALID and storing it is refused by `verifications_valid_shape` | — |
| VR-12 | `bash tests/slow/commit-ts-off.sh` | **PASS**. Verification refuses when commit timestamps are disabled | — |

## 7. Release classification

### A — synthetic development baseline: **CONDITIONAL GO**
Everything required for a synthetic development baseline is implemented, tested and reproduced. Conditions:
- A-1: founder or independent acceptance of this closure. This review does not approve itself.
- A-2: explicit confirmation of the BD1 amendments FD13, FD15 and FD17 (§3.3 item 5).
- A-3: A1 is recorded as an accepted, known weakness for synthetic use only (R-01).

Non-blocking follow-ups: the errata for `docs/b002-persistence.md:231` and design §13.7 (R-14).

### B — controlled internal pilot with real authorized evidence: **NO-GO**
All of these conditions must hold before reconsideration:
1. **Rights and legal basis.** A real source agreement establishes the rights. The `evidence_kind = 'SYNTHETIC'` guard is removed only by a reviewed migration (R-12, R-16).
2. **M3-AUD-01** is implemented and accepted (R-01).
3. **Independent verification of D8/G3** (R-02).
4. **D5b** is applied on the pilot host and preflight `--production` passes (R-03).
5. **D7** is enforced unconditionally at startup of every production entry point (R-04).
6. **Scheduling and alerting** cover verification lag, xid age, purge due-dates and failures (R-05, R-06, R-07).
7. **Backup and restore runbook**, including a PITR test (R-08).
8. **Operational policy:**
   - one reader principal per person or process;
   - credential rotation;
   - log retention;
   - a deployment owner;
   - re-measured timing gates on the pilot host (R-11, R-15).

### C — customer-facing production: **NO-GO**
In addition to every condition for B:
- the display, export and mirror rights decisions;
- a rights-model change for each source;
- a separate display purpose and grant;
- a field-level review;
- end-user authentication;
- independent security review and penetration testing.

Design §14.8 and demo §6 apply. No customer-display work is authorized.

## 8. Next milestone

**Recommended: M3-AUD-01, the durable read audit** (`docs/b002-m3-audit-proposal.md`). It is the smallest independently testable milestone, and it closes the only demonstrated weakness.

The smallest Track B alternative is a content-free freshness and reliability report. Comparison: `docs/b002-m4-options.md`.

## 9. Traceability matrix

| Requirement | Code | Tests | Commit | Evidence (this closure) |
|---|---|---|---|---|
| FD7 scoped collection | `0003` `si_begin_run_scoped`; `runs.ts` | SC-1…SC-14, EV-1…EV-3 | 3ecb201/d33d06b | suite ×3 |
| FD2/FD3 derived counts, single T2 | `0004`, `0005` `si_complete_run` | CP-1…CP-8, EV-5 | d33d06b | suite ×3; demo H4, H5 |
| FD5 cap 500 rows / 1 MiB | `0005` | EV-15, CP-4 | d33d06b | suite ×3 |
| FD10 logging preconditions | `preconditions.ts`, bootstrap | EV-9, EV-11, EV-12, PR-2 | d33d06b/6eca7a7 | suite ×3; demo N13, L1 |
| FD12 retention | `0006` `si_effective_retention_end`, `si_purge_due` | RT-1…RT-15 | c0b2cce | suite ×3; slow job; demo H12, H13, N7, N9, N14 |
| FD13 retention grants | `0006` grants | SD1, G1, RT-11 | c0b2cce | catalog query (§2.3) |
| FD14 verified commit authorization | `0007` `si_verify_receipts`, `si_receipt_verdict`, `si_evidence_readable` | VR-1…VR-16, VR-M ×8 | 6eca7a7 | suite ×3; slow job; demo H7, N5, N6 |
| FD14 F8 D7 gate | `production-readiness.ts`, `cli.ts` | PR-1…PR-5; mutant `p3b-production-gate` | 6eca7a7 | mutation run |
| FD15 verification grants | `0007` grants | SD1, VR-13 | 6eca7a7 | catalog query |
| FD16 internal reader grant | `0008` `si_grant_reader`, `si_revoke_reader`, `si.reader_grants` | RD-7, RC-1…RC-9 | 4c17ceb | suite ×3; demo H8, H11, N10 |
| FD16 bounded read | `0008` `si_read_evidence`; `reader.ts` | RD-1…RD-14, RD-M ×5 | 4c17ceb | suite ×3; demo H9, H10, N1…N4, N7…N12 |
| FD17 reader grants (BD1) | `roles.sql`, `database.sql`, `0008` grants | SR-0, SD1, G1, RD-12; mutant `step2-roles` | 4c17ceb | catalog query; mutation run |
| D-M2-09 D5b | `docs/b002-d5b-production-hardening.md`, preflight | mutant `step2-d5b` | earlier M2 | mutation run (no host) |
| D-M2-10 D8/G3 | 0007 and 0008 | VR, RD and RC suites | 6eca7a7/4c17ceb | self-verified only (R-02) |
| Reversibility | all `*.down.sql` | M1, M1b–M1h, RT-14, VR-16 | each milestone | suite ×3 |
| Restore | `tests/restore/clean-cluster.sh` | DR-1 | 3ecb201 onward | DR-1 PASS |
| End-to-end lifecycle | `demo/lifecycle.mjs`, `demo/run.sh` | 30 scenarios plus 3 demo mutants | a0b6318 | demo PASS, mutants 3/3 |
| A1 audit durability | — (proposal only) | demo A1 (weakness) | — | reproduced; M3-AUD-01 |
