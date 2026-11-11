# B-002 M4-P1 — synthetic advertiser intelligence (architecture, product contract and first vertical slice)

**Status:**
- **M4-P1** was implemented on branch `claude/b002-m4-p1` (`c041c1f`, tests `d775dee`) from the accepted baseline `d3726d6`.
- **M4-P1-ACCEPT-01** conditionally accepted M4-P1 for synthetic development, under conditions D1–D3.
- **M4-P1.1** (branch `claude/b002-m4-p1-1`, migration 0012) corrects D1–D3; see §9. It is pending independent acceptance.

**Data:** synthetic only. No real advertising source, no customer display, export or mirroring, and no LLM.

**Decisions** (recorded in `docs/b002-m3-design.md` §2.1):
- The BD1 amendment for the status function is **FD20: APPROVED, for synthetic development only.**
- The BD1 amendment for the M4-P1.1 availability function is **FD21: PROPOSED.**

## 1. What was reused (Phase 1 inspection)

| Need | Existing component (unchanged) |
|---|---|
| Evidence storage | `si.ads` and `si.observations` (0005). **No parallel store:** nothing is copied, cached or derived into tables |
| What is readable | `si_evidence_readable(run)` (0007): VALID verdict plus current retention, suspension, termination, retirement, rights and networks |
| Reader identity and grants | Dedicated `si_reader_<name>` logins and per-source `INTERNAL_SYNTHETIC_EVALUATION` grants (0008) |
| Evidence pages | `si_begin_read` and `si_read_evidence` (0009/0010). Each page has its own committed, crash-durable request intent, deterministic keyset order `(collected_at, run_id, ordinal)`, and 100 rows / 256 KiB per page |
| Library | `readEvidence` (bounded retry on `INTENT_NOT_DURABLE`) |

**Gap found.** A reader can see evidence pages, but no collection metadata:
- no runs, empty or failed collections, or verification verdicts;
- so collection freshness, coverage, verification completeness and reliability **cannot** be computed through the existing contract.

History and search **can**, by scanning the authorized pages.

## 2. Architecture

```
src/persistence/intelligence.ts (deterministic; no database access except below)
   │  scanEvidence(source)
   │     sourceAvailability ────────────────────► si_begin_read + si_read_source_availability (0012; before the first page)
   │     readEvidence ──────────────────────────► si_begin_read + si_read_evidence   (one request intent per page)
   │     sourceAvailability ────────────────────► si_begin_read + si_read_source_availability (0012; after the last page)
   │  sourceStatus(source, period) ─────────────► si_begin_read + si_read_source_status (0011; one intent)
   ▼
advertiserHistory · searchAdvertisers · freshness   (pure functions over what the boundary released)
```

**The one new primitive: `si_read_source_status(source, intent, from, to)` (migration 0011).** It returns one row of **content-free** counts and timestamps for one source and one period, and nothing else: no advertising content, identifiers or run ids. It is gated **exactly like an evidence page**:
- **Identity and session.** The dedicated-principal and READ COMMITTED checks, plus the session checks (statement bounds, no parameter logging, `synchronous_commit <> off`).
- **A committed, crash-durable request intent of this login, with the period bound into its audited scope.** The scope is the cursor `v1|<source>|status|<from>|<to>` (UTC, microseconds) with limit 1.
  - `si_begin_read` already accepts that cursor, and `si_read_evidence` rejects it (`BAD_CURSOR`).
  - The status function accepts no other cursor.
  - So a status intent and an evidence intent can never be used for each other.
- **The 0010 durability gate,** copied verbatim into `si_claim_read_intent`, an invoker helper that nobody may execute directly. `si_read_evidence` is **not modified**: M1k shows it is byte-identical.
- **Under the source lock** (FOR SHARE, rank 3, released before return):
  - the active grant;
  - the source must be available **now**: not suspended (TERMINATE_RETENTION also suspends), not retired, and current rights allowing evaluation and retention. Otherwise `SI_READ_SOURCE_UNAVAILABLE`.
- **Consumption.** The intent is consumed and a completion row is written.
- **Evidence-derived fields** (latest verified evidence, readable runs, verified days) use `si_evidence_readable`, so they obey D8/G3, retention and controls exactly like pages.

**Privileges.** `si_reader` gains EXECUTE on `si_read_source_status` only, and USAGE on its row type. No table privilege and no evidence privilege are added. The SD1, G1 and SR-0 tests assert this matrix.

**The M4-P1.1 primitive: `si_read_source_availability(source, intent)` (migration 0012; D1, FD21).** For one source and now, it returns exactly:
- `available`: the 0011 availability predicate, copied verbatim;
- `reasons`: fixed codes in a fixed order, and nothing else (no text, times, counts or identifiers):
  - `RETIRED`: retired, or retiring within the publish margin;
  - `TERMINATED`: TERMINATE_RETENTION is the latest control, or it terminates the rights version in effect;
  - `SUSPENDED`: SUSPEND is the latest control;
  - `RIGHTS_RESTRICTED`: no version in effect, evaluation not ALLOWED, or the version's validity ends within the margin;
  - `RETENTION_RESTRICTED`: the version in effect does not allow retention;
  - `NOT_SYNTHETIC`: cannot occur under the schema;
  - `UNAVAILABLE`: a fail-closed fallback if the predicate is false for no listed reason;
- `state_token`: a 32-hex digest of the source row version (`xmin`), the latest control sequence, the latest rights version and the version in effect.

How it is gated and what the token guarantees:
- **Gate.** It is gated like the status function: identity, session, a committed crash-durable intent with scope `v1|<source>|availability` and limit 1, the 0010 gate, the grant under the source lock, consumption and a completion row.
- **Scope separation.** Its scope is rejected by `si_read_evidence` (`BAD_CURSOR`) and by the status function (`INTENT_INVALID`), and it accepts no other scope.
- **Who gets an answer.** An unknown source and an ungranted source both get `SI_READ_NOT_AUTHORIZED` **before** any availability fact is computed, so reasons reach granted readers only.
- **Why the token works.** Controls and rights versions are append-only, and any update of the source row changes its `xmin`. So equal tokens mean nothing that decides availability was committed in between.
- **Monotone in time.** With equal tokens, availability can only change over time towards unavailable: retirement, expiry and validity windows only end, and a version taking effect changes the token. Therefore "available at both ends with equal tokens" means available throughout.
- **Nothing else changes.** `si_read_evidence`, `si_read_source_status`, `si_claim_read_intent` and `si_begin_read` are byte-identical (M1l). `si_reader` gains EXECUTE on this function and USAGE on `si.source_availability_row` only (SR-0, SD1, G1, AUD-8).

## 3. Product contract

All three capabilities work **per explicitly named source**. Each source is authorized separately by the database. One unauthorized source fails the whole request: there are no partial results.

**Availability (M4-P1.1, D1).** Every evidence scan, and so every history and search, checks availability before its first page and after its last:
- **Unavailable at either end:** `IntelligenceFailed('SOURCE_UNAVAILABLE')` with `sourceId` and the fixed `reasons`.
- **Available at both ends but with a different state token:** `AVAILABILITY_CHANGED`, because pages read in between may have been empty because of the change.
- **Retry:** both failures are retryable by the caller; neither is ever an empty or partial result.
- **Success** carries an explicit `availability: { state: 'AVAILABLE', checkedFrom, asOf }` on the history, and `sources: [...]` on the search page. So "no matching evidence" is always an *available* source that has nothing matching.
- **Freshness:** when the status function refuses with `SI_READ_SOURCE_UNAVAILABLE`, freshness asks availability for the reasons and returns the same typed failure.
- **Authorization:** an unknown, ungranted or revoked source is `ReadFailed('NOT_AUTHORIZED')`, identical in every case and never converted to unavailable or empty. A revocation in the middle of a scan refuses the next page. Results are **never merged across sources**: an advertiser identity is the *normalized name within one source*, because no authorization or evidence supports cross-source identity resolution.

**Normalization** is deterministic: Unicode NFKC, trim, single spaces, lower case.

**Observation time** is `collectedAt`: the verified time the run committed (the run's `finished_at`). The source-reported `seenAt`, first-seen and last-seen values are carried separately and labelled unverified.

**Periods** are `[from, to)`, UTC, millisecond precision, at most 366 days.

### A. Advertiser history — `advertiserHistory(client, source, name, { period?, withStatus? })`
- Identity: the normalized name and every exact spelling the source used.
- Every observation with provenance: source, run, ordinal, `collectedAt`, `seenAt`, network, native ad id, title, source URL, content SHA-256, and verification (always `VALID`, because only VALID evidence is readable).
- Timing: `firstObservedAt` and `lastObservedAt` (verified collection times), plus the source-reported first and last seen times.
- Counts: `distinctAds` (distinct network and native id), `runsWithEvidence` and networks.
- Optional: the source's run-level verdict counts for the period.
- **`endOfActivity: 'UNKNOWN'` always.** Absence of observations does not show that an ad stopped.

### B. Deterministic search — `searchAdvertisers(client, { sources, query, period?, networks?, limit ≤ 50, cursor? })`
- **Matching:** the normalized name contains the normalized query.
- **Filters:** collection period and networks.
- **One hit per (source, advertiser):** observations, distinct ads, runs, first and last observed, networks.
- **Order:** `(normalizedName, sourceId)`.
- **Keyset pagination with an opaque cursor:**
  - The cursor is bound to a hash of the exact query, so reusing it with another query gives `BAD_CURSOR`.
  - **A cursor is never a capability:** every call re-reads through the boundary, and a revoked grant refuses a stored cursor.
- **Bounds:** up to 10 sources per request. Each source scan is capped at 5,000 records, after which the request fails closed with `SCAN_LIMIT`, never a silent truncation.

### C. Freshness and reliability — `freshness(client, source, period)` (from `sourceStatus`)

Ages are measured against the **database clock** (`asOf`), and ratios are rounded to 4 decimals.

| Indicator | Definition | UNKNOWN when |
|---|---|---|
| `collectionFreshness` | Latest COMPLETED run, EMPTY included, at any time: how recently the collector succeeded | No successful collection ever |
| `evidenceFreshness` | Latest run readable **now**: newest verified, authorized evidence. **Not** a statement that ads are running | No readable evidence |
| `collectionCoverage` | UTC days in the period with at least one completed run, divided by the days in the period | Empty period (cannot occur after validation) |
| `evidenceCoverage` | Days with readable evidence, divided by the days in the period | As above |
| `verificationCompleteness` | VALID divided by runs with evidence in the period; with INVALID, UNVERIFIABLE and pending counts | No run with evidence in the period |
| `collectionReliability` | Completed divided by (completed + failed) attempts in the period | No attempts in the period |

Zero coverage is a measurement (we know we did not collect), not UNKNOWN. **Collection freshness and evidence freshness are separate facts.** In the demonstration the collector ran 1 day ago (EMPTY), and the newest verified evidence is 2 days old.

**Never inferred:** ad performance, spend, reach, impressions or conversions. No such data exists in the evidence.

## 4. Security and authorization review

| Property | How it holds | Test |
|---|---|---|
| No new evidence path | The library reads only through `si_read_evidence` and `si_read_source_status`; readers have no table privilege | SR-0, SD1, G1, AUD-8 |
| Request audit not bypassed | Every page and every status call has its own committed, crash-durable, consumed intent; the status period is bound in the audited scope | INT-17, INT-19 |
| Source and authorization before results | The database refuses unauthorized and revoked access; the source lock is held during the decision | INT-2, INT-4 |
| Cross-source isolation | Explicit source list, each authorized; no merging; no partial results | INT-3; lib mutant "search merges sources" |
| Emergency controls | SUSPEND and TERMINATE stop evidence pages and status immediately, **as typed failures with reasons, never as empty results**; LIFT restores | INT-5/6, INT-20; demo X1; db mutant "availability omitted"; lib mutant "scan availability checks omitted" |
| Availability changes during a scan (M4-P1.1) | Before/after availability with a state token; suspend→lift, retire→un-retire (A→B→A), terminate, rights or retention withdrawn mid-scan | INT-21; db mutant "token ignores the source row version"; lib mutant "state-token comparison omitted" |
| No availability leak (M4-P1.1) | Reasons only after the grant check under the source lock; unknown, ungranted, ungranted-and-suspended and revoked sources fail identically; other roles cannot call it | INT-20, INT-22; db mutants "availability grant check omitted", "availability intent claim omitted" |
| D8/G3, retention | INVALID, UNVERIFIABLE, pending and expired evidence never readable; counted in status | INT-7/8/9; db mutant "latest verified not restricted" |
| Durability gate | Status and availability refuse an unflushed intent (`INTENT_NOT_DURABLE`) and asynchronous sessions | INT-19 |
| Scope separation | Status intent → evidence read `BAD_CURSOR`; page intent → status `INTENT_INVALID`; other period → `INTENT_INVALID` | INT-17; db mutant "intent claim omitted" |
| Grants | Revocation between intent and status is enforced (begin_read also checks grants) | db mutant "grant omitted" |
| Caller rollback | Inside a caller transaction nothing is released (`INTENT_UNCOMMITTED`) | INT-17 |

The status function exposes **content-free collection metadata**: counts and timestamps of runs and verdicts. This is new information for readers. It is limited to a source they are granted, while that source is available, and it is audited like evidence. **FD20 approved this for synthetic development only.** The availability function additionally tells a granted reader *why* a source is unavailable, as fixed codes, and that availability changed. FD21 asks the founder to approve this.

## 5. Tests and negative controls

`tests/db/m4-intelligence.test.mjs` contains INT-1 to INT-18, covering the 18 required behaviours, and M4-P1.1's INT-20 to INT-22 (explicit availability).

INT-19, the durability and session gate on status and availability, uses the verified `wal_writer_delay` fixture, so it runs in the isolated durability CI step (`tests/crash/m4-status-durability.test.mjs`).

The mutant scenarios' raw calls use the library's bounded fresh-intent retry, on `INTENT_NOT_DURABLE` only.

| Requirement | Test |
|---|---|
| 1. Authorized history | INT-1 |
| 18. Provenance | INT-1 |
| 2. Unauthorized source | INT-2 |
| 4. Revoked grant | INT-2 |
| 3. Cross-source isolation | INT-3 |
| 5. Suspended source | INT-5 |
| 6. Terminated source | INT-6 |
| 7. Retention expiry | INT-7 |
| 8. INVALID receipt | INT-8 |
| 9. UNVERIFIABLE receipt | INT-9 |
| 10. Empty history | INT-10 |
| 15. UNKNOWN states | INT-15 |
| 11. Duplicates | INT-11 |
| 12. Stable pagination | INT-12 |
| 13. Date boundaries | INT-13 |
| 14. Freshness | INT-14 |
| 16. Concurrent collection during a scan | INT-16 |
| 17. Rollback and audit | INT-17 |
| D1: every unavailability reason; available-and-empty versus unavailable; not authorized | INT-20 |
| D1: availability transitions during a multi-page scan | INT-21 |
| D1: content-free, audited answer; the token follows availability-relevant state only | INT-22 |

**Mutants.** Since M4-P1.1 (D3), each scenario returns its **exact** outcome, and both the baseline and the mutant must equal the expected one:
- the outcome is `ok:<n>`, `INTEL:<code>[:<reasons>]`, `READ:<code>`, the raw `SI_<CODE>`, or a value;
- an unrelated refusal, an unexpected success, or a durability refusal that outlasts the bounded retry fails the test.

Database mutants (14 in all with the library ones below):

| Function | Mutant | Baseline | Mutant |
|---|---|---|---|
| Status | Grant check omitted | `SI_READ_NOT_AUTHORIZED` | `ok:1` |
| Status | Availability check omitted | `INTEL:SOURCE_UNAVAILABLE:SUSPENDED` | `ok:1` |
| Status | Latest verified evidence not restricted to readable runs | The VALID run's time | The INVALID run's time |
| Status | Intent claim omitted | `SI_READ_INTENT_INVALID` | `ok:1` |
| Availability | Grant check omitted | `SI_READ_NOT_AUTHORIZED` | `ok:1` |
| Availability | Intent claim omitted | `SI_READ_INTENT_INVALID` | `ok:1` |
| Availability | SUSPENDED reason omitted | `…:SUSPENDED` | `…:UNAVAILABLE` |
| Availability | Token ignores the source row version | `INTEL:AVAILABILITY_CHANGED` | `ok:1` (a truncated success) |

Library mutants (a temporary mutated copy):

| Mutant | Baseline | Mutant |
|---|---|---|
| Distinct ads counted as observations | `value:1` | `value:2` |
| Period end inclusive | `ok:0` | `ok:1` |
| Search merges sources | `ok:2` | `ok:1` |
| History identity by substring | `ok:1` | `ok:2` |
| Scan availability checks omitted (D1 itself) | `INTEL:SOURCE_UNAVAILABLE:SUSPENDED` | `ok:0` |
| State-token comparison omitted | `INTEL:AVAILABILITY_CHANGED` | `ok:1` |

Migration checks:
- M1k checks that down 0011 restores the exact 0010 catalog and that `si_read_evidence` is untouched.
- M1l does the same for 0012 over 0011, with four functions byte-identical.

**Fixtures** (labelled):
- time shift of finished runs to historical, millisecond-precision instants (superuser, replica role);
- a planted INVALID verdict;
- a disturbed receipt identity;
- an aged retention deadline.

## 6. Demonstration

`npm run demo:intelligence` runs `DEMO_PROGRAM=demo/intelligence.mjs bash demo/run.sh` against a disposable PostgreSQL 16.15 container. It covers:
- two **synthetic** advertisers;
- six runs over nine days: two EMPTY, one with an UNVERIFIABLE receipt;
- search, Northwind's history with provenance, and freshness and reliability, including a fully UNKNOWN period;
- a suspension that immediately blocks reads: history, search and freshness all fail with `SOURCE_UNAVAILABLE` and reason `SUSPENDED`, never an empty history.

Every output is labelled *SYNTHETIC DATA — not live market conditions*. In CI it runs on the lifecycle-demo matrix run 1.

## 7. Known limitations

1. **The scan is client-side.** History and search page through every readable record of a source: O(records), at most 5,000 per source, then `SCAN_LIMIT`. Server-side search needs a new, separately authorized read primitive with the query in the audited scope.
2. **Advertiser identity is the exact normalized name within one source** (NFKC, trim, single spaces, lower case). It has these consequences:
   - There is no fuzzy matching, no entity resolution and no cross-source identity.
   - Renames are separate identities.
   - Look-alike names are separate identities: a name with a Cyrillic letter in place of a Latin one is neither merged with nor found by a search for the Latin spelling. NFKC does not fold confusable characters.
   - Two different advertisers whose normalized names are equal are one identity.
3. **Sub-millisecond boundaries.** Periods and the library's period filter use milliseconds, while the database stores microseconds. A run within the same millisecond as a boundary can be classified differently by history (ms) and status (µs).
4. **Snapshot consistency.** Each page and each status call is its own request and snapshot, so a scan is consistent per page, not across pages. New runs appear at the end (INT-16).
5. **Status exposes collection metadata** to granted readers (FD20). It includes runs that have no readable evidence (INVALID, UNVERIFIABLE, pending, purged), as counts only.
6. **Fail-closed refusals.** `INTENT_NOT_DURABLE` can occur when unrelated unflushed WAL exists. The library retries with a fresh intent, at most 3 attempts.
   - Measured in M4-P1.1: the **first** gated request on a freshly cloned database trips over first-touch pruning while the idle WAL writer hibernates (25 × `wal_writer_delay`). This happened on 25 of 25 fresh databases and cost about 1 s for the retry.
   - Later requests rarely do (0 of 1,500 after one warm-up request).
   - Dead catalog tuples make it worse: tuples left by GRANT/REVOKE are pruned on first access. The test template is therefore vacuumed after migrating.
   - The same applies to any real deployment after DDL or grants (R-26).
9. **Reliability metric exclusions.** `collectionReliability` counts COMPLETED and FAILED runs finished in the period only:
   - T1 preflight refusals (`REJECTED`: no rights, suspended, attempt cap and so on) are excluded, because they are refusals to start, not collection attempts;
   - `RUNNING` runs are excluded until they finish or are reaped as FAILED;
   - so a source whose collection is refused at preflight shows `UNKNOWN` reliability, not 0.
10. **First-seen fallback.** `sourceReportedFirstSeen` and `sourceReportedLastSeen` are the minimum and maximum over the observations of the source-reported value. Where a record carries none, the record's own source-reported `seenAt` is used. They are unverified source claims, never verified times; the verified times are `firstObservedAt` and `lastObservedAt`.
11. **Availability is source-level.** Per-run conditions (a run's retention ending, a network no longer supported, a verdict still pending) are not source unavailability: such runs simply stop or start being readable. A run whose retention ends during a scan can be missing from that scan's result, as with any concurrent change (limitation 4). A rights version taking effect during a scan changes the token, so the scan fails conservatively with `AVAILABILITY_CHANGED`.
12. **Search over several sources fails as a whole** when any one source is unavailable (typed, naming that source). There is no partial result with per-source gaps.
7. **Inherited limits are unchanged:** no disclosure audit (release records are not rollback-resistant), no exactly-once delivery, no restored-copy binding, and the durability conditions (fsync, primary, no failover).
8. **Not production.** Synthetic data only; D5b, D7 enforcement, hosting and independent review are still required.

## 8. Recommended next increment

**M4-P2: server-side, audited advertiser search for one source.** A new read primitive would carry the normalized query and the period **in the audited intent scope**. It would return bounded, keyset-paginated advertiser aggregates computed in SQL under the same gate and source lock. This:
- removes the O(records) client scan and the 5,000-record cap;
- keeps one committed request record per search page;
- is independently testable by reusing the INT suite as an equivalence oracle (server results must equal the client-side computation).

Cross-source views should wait for an explicit cross-source authorization decision.

## 9. M4-P1.1 corrections (acceptance conditions D1–D3 of M4-P1-ACCEPT-01)

The historical acceptance evidence (M4-P1-ACCEPT-01 and CI #119–#123) is not changed. This section records the corrections and their own evidence.

| Defect | Root cause | Correction | Before | After |
|---|---|---|---|---|
| **D1** An unavailable source silently appears empty | `si_read_evidence` filters each run through `si_evidence_readable`, so an unavailable source yields empty pages. A reader had no other way to learn availability (the status function refused without a reason), and a scan ended at the first empty page whether the cause was a change of availability or the end of the data | Migration 0012 `si_read_source_availability` (one content-free, audited answer with fixed reason codes and a state token). The library checks before and after every scan: unavailable means typed `SOURCE_UNAVAILABLE` with reasons; a changed token means `AVAILABILITY_CHANGED`; success carries an explicit `AVAILABLE` state | History and search of a suspended, terminated, retired or rights-restricted source returned zero observations. A suspend→lift between pages returned 1 of 3 records as success (lib mutant "state-token comparison omitted", `ok:1`) | Typed failures with reasons for all reasons and transitions (INT-5/6, INT-20, INT-21); lib mutant "scan availability checks omitted" reproduces the original defect (`ok:0`) and is killed |
| **D2** The WAL-writer reset contaminates the next test | Two causes, both measured. (1) `writerDelay(null)` slept a fixed 300 ms and never verified that the WAL writer was back on the default interval. (2) The first gated request on a fresh database trips over its own first-touch pruning while the idle writer hibernates (25 of 25 fresh databases). That, not only the reset, made AUD-13a's single wall-clock maximum exceed 500 ms | `writerDelay` returns only once a new backend reports the requested setting and stray WAL behaves accordingly: restore needs three consecutive flushes within 600 ms; widen needs a record to stay unflushed for at least 500 ms; otherwise it throws within 30 s. `warm()` performs one gated read per fresh database before timing or single-attempt assertions. AUD-12c and AUD-13a establish the verified default writer first. AUD-13a counts every fail-closed retry exactly instead of hiding it in a maximum. AUD-FX tests the fixture both ways, three cycles, with no pause after each restore | The d775dee durability files, 5 runs: run 5 failed AUD-12c and AUD-13a (max 1,007.9 ms) right after AUD-12b's restore. With the verified restore only, AUD-13a still once reached 1,024.1 ms | The full three-file durability step: 14/14 in each of 5 consecutive runs (AUD-13a max 12.6–15.1 ms, 0 refusals; AUD-FX 0 refusals in every cycle), and again after the template vacuum below |
| (found while verifying D2) Dead catalog tuples in the test template | `tests/db/run.mjs` migrated the template and cloned it as is. 0012's GRANT/REVOKE statements left dead `pg_proc`/`pg_type` tuples, which every clone pruned on first access. That pruning WAL was unflushed while the WAL writer hibernated, so the clones' first raw single-attempt reads (AUD-1/2/5/6/7/10, RD-14, RC-9) failed closed | `VACUUM (FREEZE, ANALYZE)` on the template after migrating, so clones start with nothing to prune | Branch `m3-audit`: 10/15 alone; full suite 308/317 on a fresh container (the 0011 baseline passed only because its catalog state happened to leave less to prune) | `m3-audit` 15/15 three times; full suite 317/317 three times |
| **D3** Mutant baselines accept any refusal | Scenarios returned `status !== 'ok'` booleans, so any refusal, including an unrelated error or a persistent `NOT_DURABLE`, counted as a clean baseline | Exact-outcome scenarios with an expected baseline and an expected mutant outcome for every mutant. The bounded retry is kept for `INTENT_NOT_DURABLE` only, and a third one is reported as the outcome, so it fails | During development, the unmutated baseline of "status availability check omitted" returned `READ:INTERNAL` (an unrelated failure of the then-broken availability function). The boolean scheme would have counted it as clean; the exact assertion failed it | 14 mutants, each with an exact baseline and an exact mutant outcome (§5) |

**FD20** is approved for synthetic development only. It does not extend to real evidence, customer display, export or production.

**Remaining production blockers** are unchanged by M4-P1.1:
- the Milestone 3 blockers: disclosure audit, D8/G3 independent review, D5b, D7 enforcement, the durability operating conditions, and restored-copy binding;
- the schema allows synthetic sources only;
- the client-side scan (R-22) and name-only identity (R-23);
- FD21 is undecided;
- there is no end-user authentication, display, export or mirroring rights.
