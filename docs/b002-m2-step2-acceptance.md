# Shop Intelligence — B-002 / M2 / Step 2 Acceptance Audit

**Decision: NOT ACCEPTED. Step 3 is NOT authorized.**

- Repository: `aymentr/Shop-intelligence`
- Branch reviewed: `codex/b002-m2-acceptance` (no `main` merge or production deployment)
- Reviewed implementation commit before report: `0382db7ac80156582a82a6f74b5ad9e72cef3b41`
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

**Later mutation CI evidence:** GitHub Actions [run 39744544185](https://github.com/aymentr/Shop-intelligence/actions/runs/39744544185) at `2a999aa` passed three successive 129/129 PostgreSQL suites, Node 22/24 jobs, and BOTH executable mutation checks. The logs show `MG10 mutated test exit: 1`, `MUTANT_KILLED: MG10 detected hidden explicit collector privilege`, `MG1b mutated test exit: 1`, and `MUTANT_KILLED: MG1b detects skipped owner membership cleanup`. The modified source files were restored. A later commit `47fa258` adds explicit normalization of cluster memberships after the role mutation; this passed CI. GitHub Actions [run 39745126213](https://github.com/aymentr/Shop-intelligence/actions/runs/39745126213) at `0382db7` passed three 129/129 PostgreSQL suites, Node.js 22/24, and all **three** executable mutation checks. Logs include `Cluster owner memberships normalized: true` and `MUTANT_KILLED: T1-4 rejects inverted request-hash guard`. The first mutation CI attempt [run 39744113737](https://github.com/aymentr/Shop-intelligence/actions/runs/39744113737) failed in the mutation harness, *after* all 3 × 129 baseline database tests passed: the deliberately mutated MG10 test did fail, but the harness required an error-message substring absent from the TAP assertion output. It is incorrect to mark that first attempt as a successful automated kill. The harness was updated in `3d5243d`. A second owner-membership mutant was added, with explicit cluster membership restoration, in commits `b525945`, `2a999aa`, and `47fa258`. Their results must be established from the final GitHub Actions run; unverified commits are not acceptance evidence.

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

**Definition:** A mutant is `KILLED` only when modified implementation was executed and a relevant regression test failed for the expected reason. A normal regression test that *introduces unsafe database state* is not itself an implementation-mutation kill. MG10's direct grant test and the separate mutation against its role scan are distinct forms of evidence.

| Mutation | Invariant / predicted failure | Detector | Status |
|---|---|---|---|
| Exclude `si_collector` from the effective-permission role scan in `preconditions.ts` | Explicitly granted lock capability becomes invisible while PUBLIC remains revoked | MG10 | **KILLED** in CI run 39744544185; mutant compiled and MG10 failed for expected permission-visibility regression |
| Replace `EXIT WHEN NOT FOUND` with `EXIT WHEN TRUE` in `roles.sql` membership cleanup loop | Stray direct/delegated `si_owner` grants survive repeated bootstrap | MG1b | **KILLED** in CI run 39744544185; mutated roles.sql executed and MG1b failed for expected unremoved membership |
| Change PUBLIC counting to ignore explicit application role grants | Would miss explicit EXECUTE grants | MG10 | **NOT RUN** (MG10 illustrates unsafe state, not direct source mutation) |
| Add inherited `si_owner` membership to application role | Privilege-escalation path | MG1b/MG1c, MG3/4 | **NOT RUN** |
| Remove request-key advisory lock in `si_begin_run` | Concurrent duplicates / serialization deviation | C5/C6/DS7 | **NOT RUN** |
| Invert `x.request_sha256 <> p_request_sha256` to `=` in migration 0002 | Reuse key with different payload or refuse equivalent replay | T1-4, C6 | **KILLED** in run 39745126213; mutated 0002 was executed, T1-4 failed, original 0002 restored |
| Remove or change source `FOR KEY SHARE` lock | Rights/control races or changed lock order | CC-R/CC-C/LO4 | **NOT RUN** |
| Bypass suspension/termination predicates | Forbidden T1 attempt created | T1-3, T1-2b, CC-C | **NOT RUN** |
| Change `n >= 20` to `n > 20` | Permit attempt 21 | T1-5 | **NOT RUN** |
| Change lease-expiry predicate or reaper behavior | Expired/live attempt misclassified | T1-6 | **NOT RUN** |
| Remove isolation guard | Repeatable-read/serializable path accepted | LI-T1 | **NOT RUN** |
| Grant data-write privilege to migrator or app role | Privilege separation violation | MG3/MG4, DS1, privileges tests | **NOT RUN** |

The three executed mutant kills are meaningful but the targeted campaign is **not comprehensive**, and the unexecuted mutations cannot be claimed killed merely because suitable tests exist. Mutated source is restored by `finally` in both mutation scripts; the owner-membership script also re-normalizes cluster roles after restoration. These scripts must run only with disposable test cluster credentials.

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

1. **Executable mutation evidence:** three meaningful mutants are killed (collector scan, delegated role cleanup, T1 hash comparison). Extend the campaign to representative T1 lock/idempotency, source rights/suspension, attempt/lease and isolation mutations, and record the failure reason for each.
2. **D5b founder decision:** explicitly approve production infrastructure compatibility and mandate how `preflight --production` is invoked fail-closed by deployment/startup; or change the proposed security architecture and re-test it. Do not infer permission from a test result.
3. **Operational restore proof:** restore the database *and cluster-level roles/configuration* into a clean disposable PostgreSQL 16 cluster, re-run D5b preflight and security probes, and document operator prerequisites.
4. **Final complete verification:** green GitHub Actions on the final report/code commit (Node 22/24, build/typecheck/unit/demo, 3× full DB suite, mutation jobs), plus explicit evidence for any still-required local triple-run acceptance wording or approved revision of that criterion.
5. **Reconcile milestone plan/status:** `docs/b002-m2-plan.md` §7 still contains earlier D5b audit language and §8 names the older branch; distinguish historical findings from current decisions without rewriting the revision-2 normative guarantees.

## 6. Final recommendation

**NOT ACCEPTED.** The baseline T1 implementation has substantial PostgreSQL-backed, repeatable testing, including concurrency and real permission checks, but the requested executable mutation campaign, operational D5b decision, clean-cluster restore evidence, and final-commit verification are incomplete. This is a bounded acceptance conclusion, not a claim that an exploit has been demonstrated.

**Step 3 must not begin. T2 remains unimplemented. D8 continues to block customer-facing serving.**

## Blocker closure continuation (2026-10-22)

**Decision remains NOT ACCEPTED.** This section records changes after the last accepted baseline `176e72ab3da6cf114abfccf84aa3aa80851637bc`, without revising the frozen plan.

### Status of four blockers

| Blocker | Status | Evidence / missing proof |
|---|---|---|
| Representative mutation campaign M1–M6 | **OPEN** | Prior CI killed three mutants (D5b scan, owner cleanup, T1 hash). No newly executed source-lock, rights, lease, cap, isolation or privilege-separation mutants in this continuation. |
| D5b operator security | **FOUNDER DECISION REQUIRED** | Added production-mode CLI preflight before operator commands, with a negative DB integration test. `SI_PRODUCTION=1` must be set by trusted deployment configuration; there is no deployed runtime startup yet, so an unavoidable end-to-end production startup gate is **not** demonstrated. Managed-host ownership of `pg_catalog` remains unknown. |
| Clean-cluster restore | **OPEN** | Existing MG9 is same-cluster database-local restore, not isolated fresh-cluster global-role/configuration restore. No independent clean-cluster restoration was executed here. |
| Local acceptance runs | **OPEN** | Frozen plan §8 requires **three consecutive local PostgreSQL 16 runs and CI**. CI evidence does not substitute for local runs. The available local execution environment has Node.js but no `docker` or `psql` executable; no local PostgreSQL 16 test cluster was started. |

### Production preflight change

`src/persistence/cli.ts` now checks operational and effective advisory-lock privileges *before* any CLI operator command when `SI_PRODUCTION=1`. This prevents accidental migration/status/bootstrap operations in an unhardened database **when production mode is enabled**. Provisioning must first establish the hardening policy in a disposable/isolated phase. `tests/db/preconditions.test.mjs` adds a real-database negative check for production-mode `status` against an unhardened database. This test must pass on the latest CI commit before being treated as verified evidence.

This is **not** authorization to apply `advisory-lock-hardening.sql` on any shared or production database. Production hosting capability, runtime entry points, trusted enforcement of `SI_PRODUCTION`, and the founder's explicit D5b approval remain unresolved.

### Minimum next work

1. Execute M1–M6 mutations with independent PostgreSQL connections, expected-failure checks and full restoration, and record each result.
2. Provision a **new, disposable PostgreSQL 16 cluster**, restore global roles/configuration plus database-local objects, repeat bootstrap/migrations, and compare catalogs and ACLs.
3. Run the frozen plan's three consecutive local PostgreSQL suites on a machine with Docker/PostgreSQL 16; do not relabel GitHub CI as local evidence.
4. Obtain the founder's explicit D5b strategy decision and verify the selected hosting environment permits the required pg_catalog privilege changes; wire fail-closed production configuration across actual future runtime startup paths.
5. Verify every new test on the final commit in GitHub Actions, then reconsider acceptance. Step 3 and D8 serving remain blocked.

## Environment/evidence continuation (2026-10-22)

**Status: NOT ACCEPTED.** The previous production preflight fix at `0c6e672e681ffd73c2a478e419e62a78083eacd5` was verified by GitHub Actions run [39746826448](https://github.com/aymentr/Shop-intelligence/actions/runs/39746826448): Node 22, Node 24 and integration all succeeded. The three previously killed mutants remain the accepted mutation baseline.

**Environment inspection:** the available Linux execution container has Node.js v22.16.0 and git, but neither Docker/Podman nor `psql`, `postgres` or `initdb`. No local PostgreSQL 16 service exists here. GitHub Actions has an isolated PostgreSQL 16 compose environment, but remote CI is not the plan's local-run acceptance. The Windows execution protocol is in `docs/b002-m2-windows-local-acceptance.md`.

**New M5 experiment:** `tests/mutations/step2-isolation.mjs` changes the second READ COMMITTED guard in migration `0002` to `IF false THEN`, executes `tests/db/run.mjs t1` against disposable PostgreSQL, expects LI-T1 to fail, and restores the original migration in `finally`. CI execution is required to classify this mutation as KILLED; until verified it is **NOT EXECUTED/INCONCLUSIVE** for acceptance. This is not a change to the accepted T1 implementation.

| Blocker | Status | Current evidence |
|---|---|---|
| M1–M6 representative mutation campaign | **OPEN** | Three earlier kills verified; M5 newly wired into CI, outcome to be checked; M1–M4/M6 still not executed in this continuation |
| D5b and production startup | **FOUNDER DECISION REQUIRED** | Production CLI preflight negative test verified in run 39746826448. `SI_PRODUCTION=1` can be omitted and no actual API/worker deployment exists; provider compatibility unknown |
| Fresh PostgreSQL 16 cluster restoration | **OPEN** | MG9 is same-cluster database-local restoration only; no global-role/config/ACL restoration into independent cluster |
| Three local PostgreSQL 16 runs | **OPEN** | No local PostgreSQL executable/container runtime; Windows founder execution guide provided; CI is not local evidence |

No Step 3, T2, migrations 0003/0004, live collection, production serving or deployment was authorized or implemented. D8 restriction unchanged. Do not sign off until all mandatory evidence and explicit D5b authorization exist.

## Mutation follow-up — M5 survival and M4 experiment

GitHub Actions run [39748349743](https://github.com/aymentr/Shop-intelligence/actions/runs/39748349743) at `e6ce3189` **failed** because the initial M5 isolation mutation **SURVIVED**: disabling only `si_begin_run`'s READ COMMITTED guard left the insert-trigger isolation guard active, and LI-T1 still passed. This is a meaningful *defense-in-depth* finding, **not** a killed mutation and not a proven vulnerability. The original migration was restored.

The revised M5 script disables **both** guards in the disposable migration and requires LI-T1 to fail. M4 similarly changes both 20-attempt checks from `>= 20` to `> 20` and requires T1-5 to fail. Both scripts restore migration `0002` in a `finally` block. Their outcomes must be taken from their CI runs; unverified or unrelated failures are INCONCLUSIVE, not kills.

The unchanged source has two independent isolation guards and two independent attempt-cap guards. This explains why a single-guard mutation may survive without demonstrating a violation. It does not replace the outstanding M1/M2/M3/M6 campaigns.

Local execution was rechecked: Node.js v22.16.0 is present; Docker, Podman, `psql`, `postgres` and `initdb` are unavailable. Therefore local three-pass evidence and clean-cluster restoration remain OPEN.
