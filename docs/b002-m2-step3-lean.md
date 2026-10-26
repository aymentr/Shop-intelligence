# B-002 / M2 Step 3 — lean implementation contract

Date: 2026-10-26
Branch: `codex/b002-m2-step3-lean`
Base: `4a577296dce2f5d218ee10054ffa9976ad7d0858`
Authority: `docs/b002-m2-plan.md` revision 2, especially §§3.1, 3.2, 5 and 8.

## Mission

Implement only the previously specified Step 3 database lifecycle:
`trg_runs_transition` (SECURITY INVOKER), heartbeat, T3 failure,
expired-run reaper, `trg_runs_no_delete`, and append-only `run_errors`
integrity. Preserve all accepted Step 2 semantics.

This is still internal infrastructure, not a dashboard or live data collector.
No Step 4 / T2 publication, no migrations 0003/0004, no serving, scraping,
merge, or deployment.

## Baseline and immutable rules

- Step 2 development acceptance: CI #84, 3 × 133/133, mutation and DR-1 green.
- Migration 0001 remains byte-identical; migration 0002 may be extended
  **only** with the Step 3 objects and grants.
- Never give application roles direct UPDATE/DELETE on run tables.
- Transition trigger must be SECURITY INVOKER, never SECURITY DEFINER.
- Allowed lifecycle transitions and immutable identity/decision columns
  are enforced at the database boundary, including rights_version_id.
- No direct path to COMPLETED for application roles; Step 4 will later
  provide the only authorized publication function.
- A terminal run freezes historical counters. Heartbeats must extend
  lease only within the bounded clock interval (now, now + 5 minutes].
- T3/reaper must take only rank-4 run-row locks, and be safe under
  concurrent retry and expiry.
- FAILED rows must have computed failure fields; run_errors are
  append-only, codes/fields constrained, and their committed count
  equals least(error_count, 100).
- D5b production policy and D8 serving prohibition remain unchanged.

## Risk assessment

High: a collector directly marks a run COMPLETED; immutable version/source
is rewritten; two workers both finalize a run; stale lease succeeds; failure
records mismatch or leak free text. Moderate: terminal counts mutate,
heartbeat overextends, reaper races with T1. Low: API type ergonomics.

## Lean implementation order

1. Implement invoker transition and no-delete triggers in migration 0002.
   Add minimum privilege and catalog tests for status, identity, counts,
   and the SECURITY INVOKER property.
2. Implement bounded heartbeat and T3 failure protocol with typed library
   wrappers. Cover valid lease, stale lease, expired lease, terminal state
   and concurrent duplicate action.
3. Implement reaper, append-only error guard and deferred error-count
   integrity. Test one real expired-run cleanup and one mismatch rejection.
4. Run focused PostgreSQL Step 3 tests, then the existing full suite and
   standard CI once. Fix real regressions only. No new mutation campaign
   without a demonstrated high-risk blind spot.

## Frozen completion checks

- Only the defined state transitions succeed; forbidden transitions and
  identity/version edits fail with no partial write.
- SECURITY INVOKER catalog check passes; no application direct-write grants.
- Heartbeat cannot revive expired/terminal runs or extend past 5 minutes.
- T3 and reaper safely fail RUNNING attempts and cannot finalize another
  worker's live lease.
- Terminal counts immutable; error records append-only and consistent at
  COMMIT; no unrestricted error text accepted.
- Existing Step 2 tests remain green; CI green on implementation HEAD.
- Record one concise evidence summary and stop.

## Delivery gate

Until those checks pass: Step 3 **IN PROGRESS**, not accepted. No
production authorization. Once they pass, close the milestone without
inventing additional experiments. The original revision-2 M2-wide
acceptance and D8 production restrictions are not waived.
