# B-002 / M2 Step 4 — controlled completion protocol (T2): frozen contract

Date: 2026-10-29
Branch: `claude/b002-m2-step4-completion`
Base: `22df3c3adcfdd446d0972970f5c01ed6e5a7b490` (Step 3, CI #106 green)
Authority: `docs/b002-m2-plan.md` revision 2, §§2, 3.1 (Step 4), 3.2 (T2), 3.3, 4, 5, 6.

Frozen before implementation. Criteria below are not changed to fit the implementation.

## Scope

In: `si_complete_run` (T2, EMPTY runs only), `trg_runs_publish_check`, receipt checks
(`trg_receipts_guard`, deferred receipt ⇒ COMPLETED check), library T2 protocol, PB2 static
check, focused tests. Out: observations/ads/gate (0003), monitors and read path (0004),
any content serving (D8 release invariant unchanged), live collection, Step 5 docs/parity.

## Contract

**C1. Transitions.** The only route to COMPLETED for an application role is
`si_complete_run`: RUNNING → COMPLETED with `retention_state = 'EMPTY'`. Every other
status change is unchanged from Step 3. No application role gains a table write privilege.

**C2. Lease.** T2 requires `status = 'RUNNING'`, `lease_token = p_lease_token` (non-NULL)
and `lease_expires_at > clock_timestamp()` read after the run lock. An expired lease
with a matching token → `LEASE_EXPIRED`. Unknown run, terminal run (including an already
COMPLETED one) or a different token → refused, nothing written (`NOT_OWNER`).

**C3. Locks** (§2 rank order). READ COMMITTED only. `source_id` read without a lock (it is
immutable), then `sources` FOR SHARE (rank 3), then the run FOR UPDATE (rank 4). No advisory
lock. Every dependent read is a later statement than the lock it depends on.

**C4. Revalidation**, in the §3.3 T2 failure order, first failure wins:
1. `LEASE_EXPIRED` (C2).
2. `RIGHTS_TERMINATED` — condition (b): a TERMINATE_RETENTION with
   `control_seq ≤ publish_control_seq` covers the run's version (`through_version ≥ version`).
3. `SOURCE_SUSPENDED` — condition (a): a SUSPEND or TERMINATE_RETENTION has
   `control_seq ∈ (start_control_seq, publish_control_seq]`, or the state at
   `start_control_seq` is not LIFT. A later LIFT does not clear it (G1).
4. `SOURCE_RETIRED` — `retired_at ≤ clock + publish margin`.
5. `RIGHTS_CHANGED` — a newer version of the source is already in effect at the clock.
6. `RIGHTS_EXPIRING` — `NOT rights_valid_for_publish(version, clock)` (60 s margin).

`publish_control_seq := max(control_seq)` of the source (0 if none), read after the source
lock. Mapping note: the plan names "(a)" and "(b)" without defining them in this
repository; their content is fixed by §3.3 and §4 G1 as above. The commit-time check
re-verifies **both**, which is fail-closed under either reading.

**C5. Receipt.** Exactly one receipt per COMPLETED run, naming the run's own
`(run_id, source_id, rights_version_id)` (existing composite FKs). Inserted before the
COMPLETED update. Receipts: no DELETE or TRUNCATE for any role; UPDATE only to set
`commit_ts` and `within_validity` from NULL to a value once each (0004 monitor); no
application role may write receipts directly. A receipt whose run is not COMPLETED at
COMMIT is refused (deferred check).

Mechanism note: receipt INSERT and COMPLETED UPDATE are one SQL statement (a data-modifying
CTE; the UPDATE consumes the receipt row, so the receipt is produced and its check queued
first, and the publication check is the last event queued — PB4). Two statements, as §3.1
steps 6–7 literally read, cannot satisfy both the deferred receipt check and CR-IMM:
under `SET CONSTRAINTS ALL IMMEDIATE` the receipt check would fire before the update.

**C6. Commit-time verification** — `trg_runs_publish_check`, DEFERRABLE INITIALLY
DEFERRED, SECURITY DEFINER, no INSERT/UPDATE/DELETE, fires on every transition to
COMPLETED by any role: READ COMMITTED; `sources` FOR SHARE; `max(control_seq) =
publish_control_seq`; conditions (a) and (b); `rights_valid_for_publish(version,
clock_timestamp())`; `published_count = 0`, `suppressed_count = 0`; matching receipt exists.
No `current_query()` guard (D2′). Any failure aborts the whole transaction.

**C7. EMPTY (M2).** `received = duplicate = suppressed = 0`, `published = 0`;
`conflict ≥ 0` (FAIL_RUN forbids conflicts by CHECK). Completion metadata:
`finished_at = rights_checked_at = clock`, `retention_state = 'EMPTY'`,
`retain_until = NULL`, `lease_token = lease_expires_at = NULL`, `publish_control_seq` as C4.
Non-empty counts are refused with no write (`SI_BAD_ARGUMENT`).

**C8. Privileges.** `si_collector` gains EXECUTE on `si_complete_run` only (BD1 already
lists it). Publication and receipt check functions have no grantee. Nothing to PUBLIC.

**C9. Atomicity.** Any refusal inside T2 or at COMMIT leaves the run RUNNING with no receipt.
The library sends exactly `BEGIN`, `SELECT si.si_complete_run(...)`, `COMMIT` (PB1); on error
`ROLLBACK`, then T3 with the mapped code (`LOCK_TIMEOUT` for 55P03, `PERSISTENCE_ERROR` for
anything unmapped; no T3 for `NOT_OWNER` or bad arguments). No `SET CONSTRAINTS` or
`PREPARE TRANSACTION` under `src/` (PB2).

**Guarantee wording (§4, unchanged):** at the last check, the rights version was valid with
at least 60 s to spare. PostgreSQL does not bound the time from that check to the durable
commit. Commits outside the window are detectable from commit timestamps; D8 (0004) must
make content from such runs unservable before any production content-serving path launches.

## Risk → test map

| Risk (high unless noted) | Test |
|---|---|
| Valid EMPTY completion wrong or incomplete | S4-1 |
| Stale/invalid token completes; expired lease completes | S4-2 |
| Duplicate completion (sequential and concurrent) finalizes twice | S4-3 |
| SUSPEND during T2 not honoured; source not locked before run (LO1) | S4-4 |
| SUSPEND then LIFT before T2 clears suspension | S4-5 |
| Termination / rights change / expiring rights not caught; wrong order | S4-6 |
| CR-IMM: G1 without deferral; receipt-before-update (PB4) | S4-7 |
| Commit-time rejection leaves partial state | S4-8 |
| Direct COMPLETED by owner or app role bypasses T2 | S4-9 |
| Receipt for non-COMPLETED run; receipt UPDATE/DELETE/TRUNCATE | S4-10 |
| Catalog: definer/read-only/deferrable flags, grants (BD1, BD2) | S4-11, privileges |
| Library: exact protocol (PB1), error mapping + T3 | S4-12 |
| PB2: `SET CONSTRAINTS` / `PREPARE TRANSACTION` in `src/` (moderate) | unit PB2 |

## Delivery gate

Step 4 is **IN PROGRESS** until all of the above pass locally and in CI on the
implementation commit. Acceptance is a human decision; this branch does not self-approve.

## Evidence (implementation commit on this branch)

Local, PostgreSQL 16.15 (local cluster and the pinned compose image): DB suite 158/158 in
three consecutive passes plus one on the compose image (146 Step 3 + 12 Step 4); unit
41/41 including PB2; typecheck; demo; the nine existing CI mutation scripts all kill their
mutants with baselines green; DR-1 PASS. T1-4's former owner COMPLETED shortcut (labelled
in Step 2 as a Step 4 stand-in) now uses the real T2 path; the commit-time check refuses
the shortcut, as C1/C6 require.

Not claimed: the plan's legacy test identifiers (A2–A7, E1–E7, CR1–CR7, LO2–LO7, PB3, I4′)
are covered only where they coincide with the risk map above; Step 5 owns parity, the full
mutation sets and the remaining documentation.
