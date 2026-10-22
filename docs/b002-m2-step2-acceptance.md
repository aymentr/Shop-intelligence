# Shop Intelligence — B-002 / M2 / Step 2 Acceptance Audit

**Decision: NOT ACCEPTED. Step 3 is NOT authorized.**

- Repository: `aymentr/Shop-intelligence`
- Branch reviewed: `codex/b002-m2-acceptance` (no `main` merge or production deployment)
- Reviewed implementation commit before report: `47fa258f0c6b96ce6e4366e2eae78810a503b110`
- Report's own commit: inspect the branch HEAD at the end of this audit (a commit cannot contain its own SHA).
- Authoritative specification: `docs/b002-m2-plan.md`, revision 2.
- Production serving is **blocked by D8**, independently of Step 2 acceptance. No publication path or live collector is authorized.

## 1. Execution evidence and CI

### Verified baseline

GitHub Actions [run 39742185071](https://github.com/aymentr/Shop-intelligence/actions/runs/39742185071) for commit `95f06d2b833c265647e4b2f344af50465e8b0c96` passed:
- Node 22 and 24: typecheck, `npm test` (build included), and demo.
- PostgreSQL 16 integration: three consecutive passes of **129/129**, zero failures.
- MG10 executed against the real disposable PostgreSQL 16 database in each pass and passed. The test creates a hardened baseline, grants EXECUTE explicitly to `si_collector`, confirms PUBLIC count stays zero, confirms `advisory_application_exposures.ok === false`, rolls back the transaction, and rechecks the clean baseline.
- MG9 verifies real `pg_dump -Fc` / `pg_restore` of database ACLs against a database on the *same test cluster*. It does not restore cluster-global roles into a fresh cluster.
- MG1b/MG1c test delegated role memberships and repeat bootstrap.

**Later mutation CI evidence:** The first mutation CI attempt [run 39744113737](https://github.com/aymentr/Shop-intelligence/actions/runs/39744113737) failed in the mutation harness, *after* all 3 × 129 baseline database tests passed: the deliberately mutated MG10 test did fail, but the harness required an error-message substring absent from the TAP assertion output. It is incorrect to mark that first attempt as a successful automated kill. The harness was updated in `3d5243d`. A second owner-membership mutant was added, with explicit cluster membership restoration, in commits `b525945`, `2a999aa`, and `47fa258`. Their results must be established from the final GitHub Actions run; unverified commits are not acceptance evidence.

No independent three-pass **local** PostgreSQL execution was performed by this audit. No actual production cluster preflight or deployment was performed.

## 2. Requirements-to-test evidence matrix

| Revision 2 Step 2 property | Evidence in repository | Evidence quality / reservation |
|---|---|---|
| Same request key, same hash; retry after rejection | `tests/db/t1.test.mjs` T1-4 | Database-integrated, green baseline |
| Same key, different hash rejected | T1-4, C6 | DB test, concurrent C6 |
| Already-completed returns existing outcome | T1-4, LIB | T1-4 uses **owner-only simulated completion**, because T2 does not exist |
| Concurrent live attempts serialize | C5, T1-6, DS7 | Real sessions and blocking checks; not an exhaustive schedule exploration |
| Expired run reaped before new attempt | T1-6 | Forced expiry via owner test helper; rollback on suspension tested |
| 20-attempt limit and sequence enforcement | T1-5 | DB function and trigger, real rejection |
| Suspension before attempted run | T1-3, CC-C | No attempt committed after thrown suspension; tested |
| Termination/successor rights handling | T1-2b, T1-3 | DB tests, version-specific scenarios |
| Rights validity, expiry and successor | T1-2, CC-R | DB tests with bounded timing; not universal time model |
| Source/network scope; evidence kind | T1-2, BAD | DB test |
| Lease token/5-minute expiry, control-seq and policy snapshot | T1-1, CC-C | DB row checks |
| Request-key → source → attempt lock order | `db/migrations/0002_runs.up.sql` `si_begin_run`; LO4, DS7, C5/C6 | Code inspection + real blocking tests. Exact lock graph under every hostile schedule not exhaustively established |
| Dedicated migrator and separation from application roles | MG1–MG5, DS1, privileges tests | Real database checks under test-role definitions |
| Role normalization across delegated grants | MG1b/MG1c | Database-tested; additional grantor/option permutations not exhaustive |
| D5b hardening and effective grants | MG6–MG10 | Real database checks; on-host applicability and production enforcement remain conditional |
| Dump/restore | MG8, MG9 | Same-cluster database restoration; no new-cluster global-role restoration evidence |
| Isolation restrictions | LI-T1 and D7 preconditions | Real PostgreSQL checks |
| Migration 0001 freeze and schema equivalence | migrations tests, MG2 | Checksums and catalog comparison in CI |
| PostgreSQL test repeatability | CI runs including 39742185071 | Three consecutive CI passes; not three independent machines or local runs |

## 3. Mutation audit and outcome classification

**Definition:** A mutant is `KILLED` only when modified implementation was executed and a relevant regression test failed for the expected reason. A normal regression test that *introduces unsafe database state* is not itself an implementation-mutation kill.

| Mutation | Invariant / predicted failure | Detector | Status |
|---|---|---|---|
| Exclude `si_collector` from the effective-permission role scan in `preconditions.ts` | Explicitly granted lock capability becomes invisible while PUBLIC remains revoked | MG10 | **Observed test failure on real mutated build in run 39744113737; automation's first verdict INCONCLUSIVE due strict log matcher. Corrected harness needs final CI confirmation** |
| Replace `EXIT WHEN NOT FOUND` with `EXIT WHEN TRUE` in `roles.sql` membership cleanup loop | Stray direct/delegated `si_owner` grants survive repeated bootstrap | MG1b | **PENDING final CI execution** |
| Change PUBLIC counting to ignore explicit application role grants | Would miss explicit EXECUTE grants | MG10 | **NOT RUN** (MG10 illustrates unsafe state, not direct source mutation) |
| Add inherited `si_owner` membership to application role | Privilege-escalation path | MG1b/MG1c, MG3/4 | **NOT RUN** |
| Remove request-key advisory lock in `si_begin_run` | Concurrent duplicates / serialization deviation | C5/C6/DS7 | **NOT RUN** |
| Change same-key hash consistency check | Reuse key with different payload | T1-4, C6 | **NOT RUN** |
| Remove or change source `FOR KEY SHARE` lock | Rights/control races or changed lock order | CC-R/CC-C/LO4 | **NOT RUN** |
| Bypass suspension/termination predicates | Forbidden T1 attempt created | T1-3, T1-2b, CC-C | **NOT RUN** |
| Change `n >= 20` to `n > 20` | Permit attempt 21 | T1-5 | **NOT RUN** |
| Change lease-expiry predicate or reaper behavior | Expired/live attempt misclassified | T1-6 | **NOT RUN** |
| Remove isolation guard | Repeatable-read/serializable path accepted | LI-T1 | **NOT RUN** |
| Grant data-write privilege to migrator or app role | Privilege separation violation | MG3/MG4, DS1, privileges tests | **NOT RUN** |

The targeted campaign is **not comprehensive**, and the unexecuted mutations cannot be claimed killed merely because suitable tests exist. Mutated source is restored by `finally` in both mutation scripts; the owner-membership script also re-normalizes cluster roles after restoration. These scripts must run only with disposable test cluster credentials.

## 4. D5b security and operational decision

The optional `db/bootstrap/optional/advisory-lock-hardening.sql`:
1. Revokes PUBLIC EXECUTE on the 21 advisory-lock overloads in `pg_catalog`.
2. Grants bigint transaction advisory lock to `si_migrator` and two-integer transaction advisory lock to `si_owner`.
3. Checks no PUBLIC or **effective application-role** EXECUTE privileges remain.
4. Rolls back if verification fails.

Tests MG6/MG7 establish that this can work with the test-cluster `pg_catalog` owner; a non-owner admin cannot reliably apply it, so a managed PostgreSQL service may be incompatible. MG8/MG9 establish that privilege handling is database-local. `si_migrator` must not inherit `si_owner` and must only escalate inside a deliberate migration transaction.

**Founder decision required:** Whether to adopt mandatory, fail-closed D5b in every production database, accepting that some managed hosts cannot satisfy it, or redesign advisory lock isolation / choose infrastructure that can. A weaker option that merely logs a failed D5b check **is not an equivalent security control**. Current CLI `preflight --production` checks it when explicitly invoked; simply having the flag does **not** prove production startup/deployment cannot omit it. No global PostgreSQL privileges were changed outside disposable CI test databases.

Additional operational concerns: other database clients/tools relying on advisory locks may break after global REVOKEs; privileged and superuser sessions are not restricted; future role grants can re-expose functions; role membership is cluster-wide and must be restored/controlled separately from database dumps.

## 5. Remaining blockers and minimum closure

1. **Executable mutation evidence:** obtain successful final CI execution of the corrected mutant harness; extend the campaign to representative T1 lock/idempotency, source rights/suspension, attempt/lease and isolation mutations, and record the failure reason for each.
2. **D5b founder decision:** explicitly approve production infrastructure compatibility and mandate how `preflight --production` is invoked fail-closed by deployment/startup; or change the proposed security architecture and re-test it. Do not infer permission from a test result.
3. **Operational restore proof:** restore the database *and cluster-level roles/configuration* into a clean disposable PostgreSQL 16 cluster, re-run D5b preflight and security probes, and document operator prerequisites.
4. **Final complete verification:** green GitHub Actions on the final report/code commit (Node 22/24, build/typecheck/unit/demo, 3× full DB suite, mutation jobs), plus explicit evidence for any still-required local triple-run acceptance wording or approved revision of that criterion.
5. **Reconcile milestone plan/status:** `docs/b002-m2-plan.md` §7 still contains earlier D5b audit language and §8 names the older branch; distinguish historical findings from current decisions without rewriting the revision-2 normative guarantees.

## 6. Final recommendation

**NOT ACCEPTED.** The baseline T1 implementation has substantial PostgreSQL-backed, repeatable testing, including concurrency and real permission checks, but the requested executable mutation campaign, operational D5b decision, clean-cluster restore evidence, and final-commit verification are incomplete. This is a bounded acceptance conclusion, not a claim that an exploit has been demonstrated.

**Step 3 must not begin. T2 remains unimplemented. D8 continues to block customer-facing serving.**
