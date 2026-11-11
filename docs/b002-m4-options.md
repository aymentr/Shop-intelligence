# B-002 — next milestone options after Milestone 3 (recommendation, not implemented)

**Status: RECOMMENDATION for a founder decision.** Baseline a0b6318. Nothing here is implemented.

## 1. Where Milestone 3 leaves the system

Milestone 3 delivers the following end to end, and only for synthetic evidence:
- scoped collection;
- atomic, idempotent completion;
- commit-time receipt verification;
- retention and purge;
- an internal reader with grants, bounds and revocation;
- a 30-scenario demonstration.

It has none of the following: a production host, scheduling, a durable read audit, real sources, display rights, or any user-facing intelligence. See `docs/b002-m3-closure.md` §7 for the release classification.

## 2. Track A — infrastructure hardening

| Candidate | Size | Independently testable? | Unblocks |
|---|---|---|---|
| **A1. M3-AUD-01 durable read audit** (`docs/b002-m3-audit-proposal.md`) | One migration (0009), library change, ~12 tests, demo A1 update | Yes: the existing disposable-DB harness | A risk register R-01; prerequisite for pilot B |
| A2. Scheduler and monitoring for verification and purge | Process wrapper + alerting contract; no schema change | Partly: it needs a time-controlled harness | R-05 and R-06 |
| A3. D5b production host and startup enforcement of D7 | Hosting decision + runbook + gate in every entry point | No: it needs a real host | R-03 and R-04 |
| A4. Independent D8/G3 verification | External reviewer; no code | No: it needs a third party | R-02 |
| A5. Backup and restore cadence beyond DR-1 (PITR, logical) | Runbook + tests | Partly | R-08 |

## 3. Track B — product intelligence (synthetic only)

| Candidate | Size | Notes |
|---|---|---|
| **B1. Content-free freshness and reliability report** | Read-only SQL view/function over runs, receipts, verifications and purge log; CLI output | It uses only metadata the monitor already sees. It needs no evidence read, no new rights and no display. This is the smallest Track B step |
| B2. Internal search and filters over evidence | Extends `si_read_evidence` | It widens the read surface before A1 is fixed. **Not recommended yet** |
| B3. History and trends | Derived evidence | Retention rule FD12 requires that nothing derived outlives retention. It needs a design |
| B4. Real source adapter | — | It needs a schema change (`evidence_kind = 'SYNTHETIC'` CHECK) plus rights and legal decisions. **Out of scope** |

## 4. Recommendation

**Next milestone: M3-AUD-01 (Track A1).** Reasons:
1. It closes the only *demonstrated* security weakness: A1. The read audit is lost on rollback.
2. It is the smallest change that can be tested independently. It needs one migration and one function-signature change, and it reuses the harness, mutant pattern, DR-1 and demonstration.
3. Every Track B item that reads evidence (B2, B3) would widen a read path whose audit is not durable, so A1 should come first.
4. It is a precondition listed for classification B (controlled internal pilot).

**Smallest Track B step, if the founder prefers visible product progress:** B1, the content-free freshness and reliability report.
- It reads no evidence content, so A1 does not affect it.
- It can run in parallel with M3-AUD-01, provided it adds no grant to `si_reader`.

**Not recommended next:** B2 to B4 and real adapters. Each one widens the evidence surface or needs rights decisions that do not exist yet.

## 5. Acceptance shape for the recommended milestone

See `docs/b002-m3-audit-proposal.md` §5–§6 (AUD-I1…I8, AUD-1…AUD-12). Gates are unchanged from Milestone 3:
- unit tests and typecheck;
- the database suite run three times;
- all mutation scripts;
- DR-1;
- the demonstration (three runs) and its mutants;
- the slow-deadline job.
