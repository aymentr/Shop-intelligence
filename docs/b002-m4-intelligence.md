# B-002 M4-P1 — synthetic advertiser intelligence (architecture, product contract and first vertical slice)

**Status:**
- **M4-P1** was implemented on branch `claude/b002-m4-p1` (`c041c1f`, tests `d775dee`) from the accepted baseline `d3726d6`.
- **M4-P1-ACCEPT-01** conditionally accepted M4-P1 for synthetic development, under conditions D1–D3.
- **M4-P1.1** (branch `claude/b002-m4-p1-1`, migration 0012) corrects D1–D3; see §9.
- **M4-P1.1-ACCEPT-01** conditionally accepted M4-P1.1 for synthetic development, under conditions R1–R4.
- **M4-P1.2** (branch `claude/b002-m4-p1-2`, migration 0013) resolves R1–R4; see §10. It is pending independent review.

**Data:** synthetic only. No real advertising source, no customer display, export or mirroring, and no LLM.

**Decisions** (recorded in `docs/b002-m3-design.md` §2.1):
- The BD1 amendment for the status function is **FD20: APPROVED, for synthetic development only.**
- The BD1 amendment for the M4-P1.1 availability function is **FD21: CONDITIONALLY AUTHORIZED for synthetic development; final ratification is pending independent verification of R1** (the opaque state token, §10).

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
- `state_token`: 32 hex characters.
  - **Since 0013:** an HMAC-SHA256 under an owner-only 256-bit key, over the reader, the source, the source row version (`xmin`), the latest control sequence and the version in effect (§10).
  - **Under 0012:** an unkeyed digest that also covered the latest rights version. It could be inverted offline (R1).

How it is gated and what the token guarantees:
- **Gate.** It is gated like the status function: identity, session, a committed crash-durable intent with scope `v1|<source>|availability` and limit 1, the 0010 gate, the grant under the source lock, consumption and a completion row.
- **Scope separation.** Its scope is rejected by `si_read_evidence` (`BAD_CURSOR`) and by the status function (`INTENT_INVALID`), and it accepts no other scope.
- **Who gets an answer.** An unknown source and an ungranted source both get `SI_READ_NOT_AUTHORIZED` **before** any availability fact is computed, so reasons reach granted readers only.
- **Why the token works.** Controls and rights versions are append-only, and any update of the source row changes its `xmin`. So equal tokens mean nothing that decides availability was committed in between. The key makes the token opaque without changing that property (§10).
- **Monotone in time.** With equal tokens, availability can only change over time towards unavailable: retirement, expiry and validity windows only end, and a version taking effect changes the token. Therefore "available at both ends with equal tokens" means available throughout.
- **Nothing else changes.** `si_read_evidence`, `si_read_source_status`, `si_claim_read_intent` and `si_begin_read` are byte-identical (M1l, and M1m for 0013). `si_reader` gains EXECUTE on this function and USAGE on `si.source_availability_row` only (SR-0, SD1, G1, AUD-8).

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
   - **Corrected in M4-P1.2.** This happens on an unvacuumed template at migration 0011 and at 0012 alike: the first single-attempt read was refused on 8/8 clones at 0011 and 7/8 at 0012, and on 0/8 for each after `VACUUM`. It was not introduced by 0012.
   - The test template is vacuumed after migrating, so the regular suite measures what it claims. COLD-1/COLD-2 keep the cold case covered: on cold clones the library recovers using only its bounded retry, typically with two refused attempts and about 2 s.
   - The same applies to any real deployment after DDL or grants (R-26).
9. **Reliability metric exclusions.** `collectionReliability` counts COMPLETED and FAILED runs finished in the period only:
   - T1 preflight refusals (`REJECTED`: no rights, suspended, attempt cap and so on) are excluded, because they are refusals to start, not collection attempts;
   - `RUNNING` runs are excluded until they finish or are reaped as FAILED;
   - so a source whose collection is refused at preflight shows `UNKNOWN` reliability, not 0.
10. **First-seen fallback.** `sourceReportedFirstSeen` and `sourceReportedLastSeen` are the minimum and maximum over the observations of the source-reported value. Where a record carries none, the record's own source-reported `seenAt` is used. They are unverified source claims, never verified times; the verified times are `firstObservedAt` and `lastObservedAt`.
11. **Availability is source-level.** Per-run conditions (a run's retention ending, a network no longer supported, a verdict still pending) are not source unavailability: such runs simply stop or start being readable. A run whose retention ends during a scan can be missing from that scan's result, as with any concurrent change (limitation 4).
   - **A successful scan is not a point-in-time snapshot.** Records whose own retention ends, or that are purged, after the scan started and before their page is read are omitted; records released earlier in the scan stay in the result. This is correct retention behaviour: expired evidence is never released. The state token does not change, because the source's availability did not change.
   - Independently measured in M4-P1.2-ACCEPT-01: one run's retention expired mid-scan, or the run was purged by `si_purge_due`, and the scan returned `ok:2`. A rights version taking effect during a scan changes the token, so the scan fails conservatively with `AVAILABILITY_CHANGED`.
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
| (found while verifying D2) Dead catalog tuples in the test template | `tests/db/run.mjs` migrated the template and cloned it as is. 0012's GRANT/REVOKE statements left dead `pg_proc`/`pg_type` tuples, which every clone pruned on first access. That pruning WAL was unflushed while the WAL writer hibernated, so the clones' first raw single-attempt reads (AUD-1/2/5/6/7/10, RD-14, RC-9) failed closed | `VACUUM (FREEZE, ANALYZE)` on the template after migrating, so clones start with nothing to prune | Branch `m3-audit`: 10/15 alone; full suite 308/317 on a fresh container. **Erratum (M4-P1.2):** the attribution to 0012's GRANT/REVOKE and the claim that "the 0011 baseline happened to leave less to prune" are not supported. A controlled measurement shows the same first-read refusals on unvacuumed templates at 0011 (8/8) and 0012 (7/8), and none after `VACUUM` (§10, R4) | `m3-audit` 15/15 three times; full suite 317/317 three times |
| **D3** Mutant baselines accept any refusal | Scenarios returned `status !== 'ok'` booleans, so any refusal, including an unrelated error or a persistent `NOT_DURABLE`, counted as a clean baseline | Exact-outcome scenarios with an expected baseline and an expected mutant outcome for every mutant. The bounded retry is kept for `INTENT_NOT_DURABLE` only, and a third one is reported as the outcome, so it fails | During development, the unmutated baseline of "status availability check omitted" returned `READ:INTERNAL` (an unrelated failure of the then-broken availability function). The boolean scheme would have counted it as clean; the exact assertion failed it | 14 mutants, each with an exact baseline and an exact mutant outcome (§5) |

**FD20** is approved for synthetic development only. It does not extend to real evidence, customer display, export or production.

**Remaining production blockers** are unchanged by M4-P1.1 (and by M4-P1.2, §10):
- the Milestone 3 blockers: disclosure audit, D8/G3 independent review, D5b, D7 enforcement, the durability operating conditions, and restored-copy binding;
- the schema allows synthetic sources only;
- the client-side scan (R-22) and name-only identity (R-23);
- FD21 is conditionally authorized only, with ratification pending independent verification of R1 (§10);
- there is no end-user authentication, display, export or mirroring rights.

## 10. M4-P1.2 corrections (conditions R1–R4 of M4-P1.1-ACCEPT-01)

The historical evidence of M4-P1.1 and its review is not changed, apart from the marked erratum in §9 that R4 requires.

### R1: opaque availability state (migration 0013)

**Defect.** The 0012 token was `left(sha256('v1|source|xmin|last_seq|max_version|cur_id'), 32)`. It reproduced at `5649a18`: a granted reader, bounding the inputs with its own transaction id, recovered every input offline in 0.3 s:
- the source row's last-update transaction id;
- the control count;
- the rights-version count;
- the **global** `rights_version_id`.

**Options evaluated.**
- **Server-side comparison.** The pre-check stores the state inputs under an unguessable handle, and the post-check compares against it. It can detect every change, ABA included, and reveals nothing. But it needs a new table written on every scan, plus its own retention and cleanup path inside the gated read path, where every extra write adds WAL (R-26).
- **Keyed token (chosen).** One owner-only row, no per-call writes, and no change to the gate, lock, predicate or library contract.

**Construction.** `left(HMAC-SHA256(K, 'v2|<reader>|<source>|<xmin>|<last control seq>|<version in effect id>'), 32)`.
- `K` is 32 bytes from two `gen_random_uuid()` values (`pg_strong_random`, 244 random bits), stored in `si.availability_state_key`.
- The table and the functions `si_availability_mac` and `si_rotate_availability_state_key` are **owner-controlled**. They are reachable by `si_owner`, by roles that may `SET ROLE si_owner`, and by superusers.
  - Among the application and reader roles, exactly **`si_migrator`** may `SET ROLE si_owner`, by design (it applies migrations as the owner), so it can read the key.
  - No reader and no runtime application role (`si_collector`, `si_rights_admin`, `si_retention`, `si_monitor`) can reach the key, by inheritance or by `SET ROLE`.
  - SD13 asserts all of this since the M4-P1.2 follow-up. **Correction:** the original wording "No role … gains anything" ignored `SET ROLE`; M4-P1.2-ACCEPT-01 defect 2.

**Security properties and their evidence:**

| Property | Why it holds | Evidence |
|---|---|---|
| Opacity | Without `K` the token is a pseudorandom function of its inputs. The low entropy of the inputs no longer matters, because the search space includes the 244-bit key | The review's inversion attack: *not found*; 7.0 M unkeyed candidates in 0013's own layouts: *not found*; INT-23 (4) in-suite |
| Correct construction | — | INT-23 (1): the token equals Node's `createHmac` over the documented message and the stored key. INT-24: the in-database HMAC equals RFC 4231 test case 2 |
| No reader correlation | The reader is an input | INT-23 (3): two readers get unrelated tokens for the same state; the mutant "not bound to the reader" is killed |
| No cross-source correlation | The source is an input, and the global `rights_version_id` is no longer recoverable | — |
| What a reader still learns | Exactly the contract: whether this source's availability state changed between two of its own requests (FD21, R-25) | — |
| No exposure | The key never appears as a literal in a statement, log line or error. A missing key fails with a fixed message naming nothing secret (`SI_READ_STATE_KEY_MISSING`, 55000) | INT-23 (6), (7) |

**Secret lifecycle:**
- **Rotation.** `si_rotate_availability_state_key()`, owner only. Every token changes, so a scan in flight across a rotation fails closed with `AVAILABILITY_CHANGED` (INT-23 (5)).
- **Backup and restore.** The key is schema data, so dumps and WAL are as confidential as the key, and DR-1 restores it with the schema.
  - **Correction (M4-P1.2-ACCEPT-01 defect 1):** a *logical* restore (`pg_dump`/`pg_restore`, as DR-1 does) does **not** keep producing the same tokens, because every source row gets a new `xmin` (independently measured: same key, `xmin` 10118 → 10357, a different token).
  - The consequence is only fail-closed: a scan straddling a restore gets `AVAILABILITY_CHANGED`. The earlier sentence ("a restored copy keeps producing the same tokens") was wrong for logical restores.
  - **Rotate the key** (`si_rotate_availability_state_key()`, as the owner) after restoring a copy into any environment with lower trust or different readers: the copy carries the production key, and with readers there it would re-open R1 offline inversion against that key.
  - A restore without the row fails closed until the owner rotates.
- **Down 0013** restores 0012's function byte for byte and drops the key (M1m).

**The "latest rights version" input is dropped as redundant.** A rights version recorded during a scan either:
- takes effect at once, which changes the version in effect;
- takes effect within the 60 s publish margin, which ends the current version's window, so the source is unavailable at the post-check, or the version takes effect and changes the version in effect;
- or takes effect later than the margin, which cannot change readability during the scan.

No scenario distinguishes this input from the remaining ones, so it could have no meaningful mutant. The remaining three inputs each have one (R2).

### R2: token regression coverage

**SV-1 / SV-M** (`tests/slow/m4-scheduled-version.test.mjs`, slow CI job) is a real-time product path. Version v2 is scheduled 64 s ahead *before* the scan. Page 2 runs inside v1's margin and is empty; v2 takes effect before the post-check.
- Real 0013: `AVAILABILITY_CHANGED`.
- Mutant without the version in effect: **`ok:1`, the truncated success**, so it is killed.

Mutants for every token input, each with an exact behavioural assertion (`tests/db/m4-intelligence.test.mjs`):

| Input | Scenario | Baseline | Mutant |
|---|---|---|---|
| Source row version | Retired within the margin, then un-retired, mid-scan | `AVAILABILITY_CHANGED` | `ok:1` |
| Control sequence | Suspended, empty page, lifted | `AVAILABILITY_CHANGED` | `ok:1` |
| Version in effect | New version mid-scan (fast contract check; SV-M is the truncation case) | `AVAILABILITY_CHANGED` | `ok:3` |
| Key | — | `value:hmac` | `value:recoverable` |
| Reader binding | — | `value:distinct` | `value:shared` |

INT-21 adds concurrent changes from several sessions between pages, never a successful truncated result:
- suspend, new version and retirement, with a later lift;
- termination racing a new version;
- retirement within the margin racing a suspension.

### R3: AUD-13a measures the gate directly

The 500 ms wall-clock bound, with up to two tolerated refusals, is replaced by measurements:
- **Production function, 50 single-attempt reads.** For every read, the flush position observed right after its intent committed is compared with the end of that intent's COMMIT record, located in the WAL (`pg_walinspect`). "The gate never waits for the read's own intent" is asserted on **every** read. Every outcome is a release or a fail-closed `NOT_DURABLE`, never another error.
- **The gate's own view.** A copy of the production function that differs by one NOTICE reports the target, the flush position at the target and the number of wait iterations. On every read the flush position at the target covers the read's own commit, and the target covers the intent. Any wait happens only while WAL beyond the read's own durable commit is unflushed.
- **Sensitivity.** The new AUD-DM mutant "intent committed asynchronously" is detected under the verified 10 s writer.
- **Unchanged.** The real 1 s timeout and the fail-closed refusal stay enforced and tested (AUD-12b).
- **AUD-FX** uses the same measurement.

### R4: template recovery

- §9 and limitation 6 are corrected: the first-read behaviour exists at 0011 and 0012 alike.
- `tests/db/m4-cold-template.test.mjs` builds its own unvacuumed template and six clones:
  - **COLD-1:** a raw single-attempt first read either releases or fails closed with the intent left OPEN. It fails if the cold condition never occurs.
  - **COLD-2:** the library recovers with at most `3 × (NOT_DURABLE_ATTEMPTS − 1)` refused attempts per history and every request consumed once.
- The regular suite keeps the vacuumed template.

### Governance (M4-P1.2)

- **FD21:** conditionally authorized for synthetic development; final ratification pending independent verification of R1.
- **R7** (any source-row update or new rights version refuses an in-flight scan) is recorded as accepted conservative behaviour (R-27).
- **R5** (RT-13 failed once, unexplained) stays OPEN (R-28).
- **R-29 (new, OPEN):** RD-M "source lock omitted" (an M3 test whose assertions are unchanged; M4-P1.2 added only a failure diagnostic to its barrier) failed once in three fresh-container suite runs and did not reproduce in 20 targeted runs. Its barrier now records what the read did.
- **Found and fixed during the M4-P1.2 regression (DR-1):** the new AUD-13a replaces the read function twice (instrumented copy, then the original). Each DDL leaves dead `pg_proc` tuples whose first-touch pruning made a later single-attempt read fail closed on the restored cluster. AUD-13a now warms the database after each replacement: the R4 mechanism, applied to the test itself.
- All real-evidence pilot and production blockers above are unchanged.
- **CI #125 (first push of M4-P1.2):** MG9 failed with `unrecognized configuration parameter "transaction_timeout"`. MG9 is a Milestone 2 restore test, unchanged since it passed in CI #124. The runner image's host `pg_dump`/`pg_restore` had moved to a newer major whose restore issues that setting, which the PostgreSQL 16 server rejects. MG9 now uses version-matched tools: the host tools only when their major equals the server's, otherwise the database container's own (as DR-1 does). The match is asserted. It is validated with the real host tools and with a simulated newer host client.

### M4-P1.2-ACCEPT-01 follow-up (documentation and tests only; no product change)

The independent review (separate session, `bb155d3`) gave a CONDITIONAL ACCEPT. Its low-severity findings are corrected here without changing any migration, function or library behaviour:

| Finding | Correction |
|---|---|
| 1. Restore claim false | §10 "Backup and restore" corrected; a logical restore changes tokens (fail closed). Rotate the key after restoring into a lower-trust environment |
| 2. "Owner-only" ignored `SET ROLE` | Wording changed to owner-controlled. SD13 now asserts that exactly `si_migrator` may `SET ROLE si_owner` (and can then read the key, the documented exception), and that a reader cannot |
| 3. AUD-13a had no refusal bound, and its wait branch never ran | At most 2 of 50 ordinary reads may be refused fail-closed, in both the production and the instrumented gate. A new deterministic step commits unrelated WAL asynchronously after each intent: the gate waits (5/5 in the first run, up to 400 ms), only for WAL beyond the read's own durable commit, and then releases |
| 5. Retention-expiry scan semantics undocumented | Limitation 11: a successful scan is not a point-in-time snapshot |
| 7. R-29 wording | Corrected in the risk register and §10 |

R-28 and R-29 stay OPEN; no deterministic evidence resolves them.

**FD21:** the independent review recommended final ratification for synthetic development only, and the M4-P2 instruction refers to the accepted FD21 contract. FD21 is therefore recorded as **accepted for synthetic development**. It is not accepted for real evidence, a pilot or production.

## 11. M4-P2: server-side audited advertiser search and history (migration 0014)

**Status:** IMPLEMENTED on branch `claude/b002-m4-p2` from the accepted baseline `bb155d3`, pending independent acceptance. Synthetic data only; no display, export or deployment.

### Architecture

```
src/persistence/intelligence.ts
   searchAdvertisers(sources, query, …)   per source, per page ──► si_begin_read + si_search_advertisers   (0014)
   advertiserHistory(source, name, …)     per page              ──► si_begin_read + si_advertiser_history  (0014)
   sourceAvailability / sourceStatus / freshness                ──► unchanged (0011-0013)
   *ClientScan (M4-P1 client-side scan)                         ──► kept as the reference oracle and performance baseline only
```

- The 5,000-record client-side scan is no longer on the product path.
- History returns the summary plus the requested advertiser's observations only, keyset-paged at up to 100 per page.
- Search returns aggregated advertiser hits, up to 50 per page.

### Security contract (every page)

| Property | Implementation | Evidence |
|---|---|---|
| Dedicated reader, READ COMMITTED, safe session | Same checks as every reader function | SRV-3, SRV-6 |
| Committed, crash-durable request intent | `si_claim_read_intent` (the 0010 gate), one intent per page | SRV-6; mutant "history intent claim omitted" |
| The complete request is audited | Scope `v1|<source>|search|<sha256>` or `|history|`. The digest covers every argument, length-prefixed in UTF-8 bytes: query or name exactly as sent, networks, period, page position and inclusivity; the page size is the intent limit | SRV-2: each of 8 changed fields gives `INTENT_INVALID`; mutants "scope does not bind the query / the period" |
| No scope substitution | Evidence, status, availability, search and history scopes are mutually refused (`INTENT_INVALID` / `BAD_CURSOR`) | SRV-2 |
| Authorization before results | Grant checked under the source lock; unknown, ungranted, ungranted-and-suspended and other-reader sources fail identically (`NOT_AUTHORIZED`, or `INTENT_INVALID` with a foreign intent) | SRV-3; mutants "search / history grant check omitted" |
| Availability (FD21) | Evaluated inside each page under the lock (`si_availability_state`, the 0013 predicate, reasons and keyed token, unchanged). Unavailable gives `SOURCE_UNAVAILABLE` with fixed reasons, never an empty result. The page token equals the FD21 availability token | SRV-4; mutants "availability check omitted", "server state token ignores the row version" |
| Only readable evidence | Runs filtered by `si_evidence_readable` (VALID verdict, retention, controls, rights, networks) | SRV-1, SRV-5; mutant "readable-evidence predicate omitted" |
| No cross-source aggregation | One source per call. The library merges hit lists without merging identities; one unauthorized or unavailable source fails the whole search | SRV-3; lib mutant "page position not inclusive" |
| Bounded resources (**corrected in §12.2–§12.4**: response ≤ 262,144 bytes; the candidate cap does not bound work) | Page size 1–50 (search) or 1–100 (history). At most 200,000 candidate observations per call (`SCAN_LIMIT`), at most 1 MiB per response (`RESULT_TOO_LARGE`), at most 10 spellings per hit (`namesTruncated`). Query or name at most 300 characters; at most 5 networks, canonical; period at most 366 days at millisecond precision | SRV-2, SRV-7 (bounds enforced through lowered limits in copies) |
| No direct access | Readers gain EXECUTE on the two functions only. Every helper (normalizer, scope, availability state, argument checks) is owner-only; readers still have no table privilege | SRV-3; SR-0, SD1, AUD-8 |
| Request audit only | Consumption plus a completion row naming the hits or observations released. **This is a request audit, not proof of delivery** | SRV-6 |

**Identity and normalization.**
- An advertiser is (source, `si_normalize_advertiser(name)`).
- The server normalizes authoritatively: NFKC with the server's Unicode tables, trimming and collapsing the JavaScript `\s` whitespace set, and lower-casing with the ICU root locale.
- The library sends the raw text, and the scope binds that exact text.
- The JavaScript helper `normalizeAdvertiser` matched the SQL normalizer on a 42-string corpus and on 3,999 of 4,000 random strings. The one difference involved characters treated differently by the two Unicode versions; that is why the server is authoritative.
- Similar names are never merged.
- Ordering and keysets use `COLLATE "C"` (code-point order).
- An expression index `observations_by_source_advertiser (source_id, si_normalize_advertiser(advertiser_name))` serves history. It must be rebuilt with `REINDEX` after a PostgreSQL or ICU upgrade that changes Unicode tables.

### Consistency (what is and is not guaranteed)

> **Superseded by §12.8 (M4-P2.1).** The table below overstated detection: a grant revoked and restored between pages, and an add-and-remove swap that leaves the summary identical, are not detected.

**Each page** is computed in one statement under the source lock, so it is consistent within itself. **No snapshot spans pages.** The library distinguishes:

| Situation | Outcome |
|---|---|
| The source becomes unavailable (suspended, terminated, retired, rights or retention restricted) | `SOURCE_UNAVAILABLE` with reasons, on the next page |
| Availability changes and recovers between pages (suspend→lift, new rights version, retire→un-retire, key rotation) | `AVAILABILITY_CHANGED`: the state token differs between pages |
| An individual record expires (or new evidence arrives) between history pages | `RESULT_CHANGED`: the summary or count differs between pages. Retry for a consistent result |
| Search results change between pages | The keyset continues after the last name: no duplicates and no skipped later names. A name sorting before the position appears only in a new search, and later pages' aggregates reflect their own time |
| Nothing matches | An explicit AVAILABLE result with zero observations or hits |

All of these are tested in SRV-5.

### Performance (synthetic, one source, 500 advertisers; local PostgreSQL 16.15 container; medians)

| Observations in source | Client scan, history | Server history | Client scan, search page | Server search page | Server search, all 10 pages | Audited requests (client → server) |
|---|---|---|---|---|---|---|
| 1,000 | 83 ms | **6 ms** | 64 ms | **11 ms** | 226 ms | 13 → 1 |
| 5,000 | 300 ms | **9.5 ms** | 324 ms | **32 ms** | 700 ms | 53 → 1 |
| 20,000 | `SCAN_LIMIT` (cap 5,000) | **26 ms** | `SCAN_LIMIT` | **131 ms** | 2.5 s | — → 1 |
| 50,000 | `SCAN_LIMIT` | **58 ms** | `SCAN_LIMIT` | **305 ms** | 6.5 s | — → 1 |

**Plans and costs** (`EXPLAIN (ANALYZE, BUFFERS)` of the core queries):
- **History** uses the expression index: an Index Scan on `observations_by_source_advertiser` returning only the advertiser's rows (100 rows at 50,000), with a hash of the readable runs. Execution takes 48 ms and 6,718 shared buffers at 50,000, all hits; sort memory is 75 kB.
- **Search** reads every readable run's observations: a Bitmap Heap Scan per run that discards non-matching names. Execution takes 314 ms and 9,804 buffers at 50,000; sort memory is 125 kB. It costs roughly linear time in the source's observations per page, and every page re-aggregates.
- **Variants tried:** a single evaluation of the normalizer per row and an inlinable variant did not reduce the cost (measured 148–211 ms against 117 ms for the normalizer step), so none was adopted.
- **Per-page overhead:** the request intent (a synchronous commit) costs about 1 ms. Authorization, availability and the durability gate are within the 10–14 ms of a page at 1,000 observations.
- **Bound:** ~~the 200,000-candidate cap limits the worst case at about 1.2 s per page by this profile~~. Incorrect (M4-P2-ACCEPT-01 D3): the cap does not bound the scan; see §12.4.

### Limitations (M4-P2)

1. **Search cost.** Search is O(observations of the source) per page. Substring matching cannot use a btree. A trigram index would need the `pg_trgm` extension, which is not adopted.
2. **No cross-page snapshot.** See the consistency table. History fails closed on any change between pages; search pages reflect their own time.
3. **Normalization depends on the server's Unicode version and ICU.** Upgrades require `REINDEX`, and identities could split or merge across an upgrade.
4. **Spellings are capped** at 10 per search hit and 50 in a history summary, with a truncation flag.
5. **Inherited limits are unchanged:** request audit rather than disclosure audit, no exactly-once delivery, R-26 cold-catalog liveness, and the durability operating conditions.
6. **Not production.** Synthetic data only. All Milestone 3 real-evidence pilot and production blockers remain.

**Governance:** the new reader privilege (EXECUTE on `si_search_advertisers` and `si_advertiser_history`) is recorded as **FD22 (PROPOSED)**. R-22 (the client-side scan) is resolved on the product path by 0014.

### Regression findings during M4-P2 (Phase 8), each investigated

| Finding | Root cause | Resolution |
|---|---|---|
| COLD-2 failed 3/3 | It expected M4-P1.2's three audited requests per history. Server-side history is one request, with availability inside | Expectation corrected: one request; at most `NOT_DURABLE_ATTEMPTS − 1` refused attempts. On cold clones: 0–1 refused attempts, about 1 s |
| Scheduled-version test failed | It hooked evidence pages, which the server-side history no longer uses | SV-1/SV-M now run on the client-scan path, which uses the 0013 availability function. New SV-2/SV-2M: a version taking effect between server-side pages gives `AVAILABILITY_CHANGED`; the server-token mutant without the version in effect gives `ok:3` (killed) |
| AUD-1 failed once (pre-existing M3 test) | Its content-free check searches the stored intents (UUIDs, hex digests) for record values. Ids such as `a2-0` can occur by chance at a UUID group boundary | Fixture ids now contain letters outside `[0-9a-f-]`; 0/20 after the fix |
| AUD-7 failed once (pre-existing M3 test) | Two fail-closed outcomes depend on WAL-writer timing: the gate refuses (`55000`), or the gate passes and the consumption waits on the intent row lock (`55P03 SI_READ_BUSY`). The old assertion accepted only the first. Measured 4/30 failures on `bb155d3` and 6/30 on M4-P2 | Accepts exactly those two refusals and still asserts that nothing is released; 0/20 after the fix |

## 12. M4-P2.1: server-side intelligence remediation (migration 0015)

**Status:** IMPLEMENTED on branch `claude/b002-m4-p2-1` from `61bda9d` (the M4-P2 review commit), pending independent acceptance. It addresses M4-P2-ACCEPT-01 findings D1–D7, documents D8, and fixes one further defect found while reproducing D4 (ingestion, §12.6). Synthetic data only; no display, export or deployment. The architecture of §11 is unchanged: the same two reader functions (same signatures, privileges, gate, lock, grant and availability checks, readable-evidence policy and audit), replaced by `CREATE OR REPLACE` in 0015.

### 12.1 Reproduction on the baseline (61bda9d, disposable databases)

| Finding | Workload | Expected | Actual on 61bda9d |
|---|---|---|---|
| D1 | History of 100 observations (1,000-character titles, 2,000-character URLs), page size 80 | Typed refusal or a page | `ReadFailed INTERNAL` (23514 from the audit CHECK `bytes_returned <= 262144`); page size 70 succeeds. Search, 50 hits of 990-character CJK names: `INTERNAL` |
| D2 | Library history of one advertiser with 200,000 observations (bound 5,000) | Refusal after one page | `SCAN_LIMIT` after **51 pages / 51 audited requests, 93 s, 4.56 GB of temporary files** (the acceptance review measured 168 s and 5.06 GB) |
| D3 | Same source | Work bounded | No-match search over 200,000: 1.0 s; over 400,000: 2.5 s (the candidate cap never applies). Concentrated search: 2.5 s, 52 MB temp; history page: 2.0 s, 93 MB temp. Reader `SET work_mem = '1GB'` was in effect inside the definer function (temp 50 MB → 0 MB): the reader could relax memory |
| D4 | Search pagination, page size 1, after a 1,000-character CJK name | Next page | `BAD_CURSOR` (cursor 4,150 > 4,096 characters; the server also refused positions above 1,000 characters) |
| D5 | History of a 304-character name and of a 1,000-character name | History | `BAD_ARGUMENT` (limit 300) |
| D6 | The four surviving mutants | Killed | Not covered by any test on 61bda9d (search period end, history network filter, search `synchronous_commit` check, search source lock) |
| D7 | Grant revoked and restored between history pages; add-and-remove swap | Documented honestly | Revoke+restore: `ok:3` (not detected); the §11 table did not say so |
| D8 | SUSPEND issued during a concentrated search page | Documented | Waited 2.3–3.1 s for the page's source lock |
| (new) | Ingestion of an incompressible 1,000-character CJK advertiser name (valid per 0005) | Stored | **54000: index row size 3,024 exceeds btree maximum 2,704** for `observations_by_source_advertiser`; the whole run completion failed |

Plans at 200,000 candidates (`EXPLAIN (ANALYZE, BUFFERS)`, work_mem 4 MB): the candidate `LIMIT 200001` sits above the scan and join; it bounds the rows materialized, not the rows read. The temporary files come from the materialized CTEs (`cand`, `mine`; each is read twice), not from sorts: search 17 MB, history 59 MB in the plan. A no-match search reads every readable run's observations (Nested Loop over 800 runs × Bitmap Heap Scan, 2.3 s at 400,000) and is never limited by the cap.

### 12.2 D1 — the response bound is the audit bound

- `max_bytes` = **262,144** in both functions: exactly the 0008/0009 CHECK. The size is `octet_length(out_doc::text)`, the same value written to `read_intents.bytes_returned` and `reader_access_log.bytes_returned`, and the byte length of the text a client receives (REM-1 measures it on the client). The historical CHECKs are unchanged.
- Above it: `SI_READ_RESULT_TOO_LARGE` (54000) **before** the intent is consumed. Nothing is released, the intent stays `OPEN`, no completion row. The library maps it to `RESULT_TOO_LARGE`.
- **Exact boundary (REM-1, real function):** a history page built to exactly 262,144 bytes is released and audited as 262,144; the same page one byte larger is refused typed, not by the CHECK. The construction is linear and exact (fixed-width fields); the test asserts the measured size, so the boundary is not assumed.
- **The library reduces the page size** on `RESULT_TOO_LARGE`: the page is requested again at half the size, down to 1 (at most 7 audited requests for a page of 100; each is its own audited request with its own scope, never a retry of the same request). The reduced size is kept for later pages. Search merges per-source pages up to the smallest last hit of any source that has more (a reduced page must not let another source's later hits skip it; lib mutant "search merge ignores a reduced source page").
- **A page of one result always fits.** History spellings in the summary are bounded to the first 50 in code-point order *and* 64 KiB (`namesTruncated` when cut). Worst case of a one-observation history page: normalized name ≤ 33 KB (18,000 characters of ≤ 33 UTF-8 bytes per original character), spellings ≤ 64 KiB, one observation ≤ ~25 KB (name and title of 1,000 characters at ≤ 6 JSON bytes each, URL of 2,048 at ≤ 6), envelope < 1 KB: under 125 KB. A search hit: ≤ 33 KB + 10 spellings × 6 KB < 95 KB. REM-4b builds a worst case (64 spellings of 1,000 characters, 994 of them control characters; control-character title; quote-filled URL): the page of one observation is 82,516 bytes.

### 12.3 D2 — history above the library bound fails after one page

`advertiserHistory` compares the first page's `summary.observations` with its bound and fails `SCAN_LIMIT` immediately. The count's semantics: the number of observations the pages of *this* request would return (same source, normalized name, networks and period, readable evidence), counted in the same statement as the page, up to the server cap (above it the server already fails `SCAN_LIMIT`). It cannot be bypassed:
- **Filters** are part of the request and of the count (REM-2: a network filter that excludes nothing is refused; one that excludes everything returns 0).
- **Pagination:** the library always starts at the first page (no caller-supplied position for history), and every later page's summary must equal the first's.
- **Concurrent changes:** growth after the first page changes the summary of the next page → `RESULT_CHANGED` (REM-2), never a longer result; the per-observation bound check remains.

### 12.4 D3 — resource bounds

**Pinned on both functions** (`proconfig`, verified exactly by SD1 and REM-3):

| Setting | Value | Why |
|---|---|---|
| `work_mem` | 4MB | The server default; measured 4–64 MB: larger values did not reduce latency at 200,000 candidates and increased history temp (93 → 118–167 MB). Pinned so that a reader's `SET work_mem = '1GB'` no longer applies inside |
| `hash_mem_multiplier` | 2 | The default, pinned for the same reason |
| `max_parallel_workers_per_gather` | 0 | `temp_file_limit` is per process; parallel workers would each get their own. The measured plans used none |
| `jit` | off | No compilation cost on large plans; deterministic plans |
| `temp_file_limit` | 256MB | Above the largest legitimate page measured at the cap (93–167 MB), far below the 4.6 GB of the D2 workload. 53400 inside the page → `SI_READ_RESOURCE_LIMIT` (54000) → library `RESOURCE_LIMIT`. A superuser-only parameter: the cluster bootstrap grants `SET ON PARAMETER temp_file_limit TO si_owner` (without it 0015 fails closed with 42501). Nobody else holds a parameter privilege (SD15) |
| `lock_timeout` | 2s | Unchanged from 0014 |

**Verified, not assumed:**
- REM-3 relaxes the reader session (`work_mem 1GB`, `hash_mem_multiplier 1000`, 8 parallel workers, `jit on`) and reads the values inside an instrumented copy of the production text: `4MB / 2 / 0 / off / 256MB`.
- The reader cannot `SET temp_file_limit` (42501), nor change its own role settings.
- Function settings take precedence over session settings for the statements inside; they cannot be changed by the caller.

**Time.** A function's `SET statement_timeout` does not shorten the statement that is already running (measured: a 200 ms function setting around `pg_sleep(1)` completed in 1,002 ms). The per-statement time bound is therefore the reader session's `statement_timeout`. The reader session check (0008, unchanged) requires it to be between 1 ms and 10 s (provisioned: 10 s), so no page runs longer than 10 s. A timeout is 57014 → library `RESOURCE_LIMIT` (REM-3b).

**What bounds the work (and what does not).** The 200,000-candidate cap does **not** bound SQL work: it limits the rows materialized after the scan and join, and a no-match search reads every readable observation of the source. The enforceable bounds are: time ≤ the session `statement_timeout` (≤ 10 s, checked); temporary files ≤ 256 MB per page; memory ≈ `work_mem` × plan nodes, with no parallel workers; one source per call; page sizes 1–50 / 1–100. Shared-buffer reads are bounded only by the time bound.

**Smallest next step** for bounded search work (not in this remediation): a per-source advertiser summary maintained at publication time (normalized name → counts, first/last, networks, spellings), searched instead of the observations. That makes search O(advertisers of the source) and lets history read only its own index range. The readable-evidence policy would have to be re-applied to the summary (verdicts, retention and controls change after publication), which is a design of its own. `pg_trgm` remains not adopted.

### 12.5 D4/D5 — names up to the documented maximum

- **History** accepts names of 1–1,000 characters (0005), counted in code points on both sides (the library no longer uses UTF-16 length: a 1,000-code-point astral name is 1,999 JavaScript units).
- **Search positions** may be any normalized name: the server accepts up to **18,000** characters (NFKC expands one code point to at most 18, U+FDFA; measured over every code point: the largest expansion is 18 characters/33 bytes). The library's cursor bound is derived from that (18,000 × 6 JSON bytes + tokens, base64url: 145,600 characters), and the decoded cursor must name a requested source and a position of at most 18,000 code points. Forged, oversized or foreign positions are `BAD_CURSOR` (REM-4); the cursor remains bound to the exact query and carries the state tokens (unchanged).
- **Identity keys are never truncated.** History compares the full normalized name.

### 12.6 Ingestion defect found during reproduction: the advertiser index

The 0014 btree index on `(source_id, si_normalize_advertiser(advertiser_name))` stores the full normalized name. A btree row holds at most 2,704 bytes: an incompressible 1,000-character CJK name normalizes to 3,000 bytes, and inserting it **failed the whole run completion** (54000). 0015 replaces it with `observations_by_source_advertiser_key (source_id, si_advertiser_key(advertiser_name))`, a SHA-256 of the normalized name. History selects rows by the key (index condition, no per-row normalization). Identity remains the full normalized name: every distinct spelling selected must normalize to the requested name, verified once per spelling in the same statement. Otherwise the page is refused (`SI_READ_IDENTITY_CONFLICT`, library `INTERNAL`): a digest collision fails closed and never merges identities (mutant "identity guard omitted", with a collision simulated in an instrumented copy). A first version compared the full name on every row; it doubled the history page time at 200,000 candidates (2.0 → 4.8 s) and reached the 10 s statement timeout on a 600,000-observation database. That was measured during Phase 9 and replaced by the per-spelling check. The down migration recreates the 0014 index and is refused (54000) if such a name has been stored: 0014 cannot represent it.

### 12.7 D6 — negative controls

New mutants (`tests/db/m4-remediation.test.mjs`); each baseline gives exactly its outcome, each mutant exactly the defect:

| Mutant | Scenario | Baseline | Mutant |
|---|---|---|---|
| Search period end inclusive | A run finished exactly at `to` | `ok:0` | `ok:1` |
| History network filter omitted | META and TIKTOK observations, `networks: ['META']` | `ok:1` | `ok:2` |
| Search `synchronous_commit` protection omitted | Intent taken in a safe session; the call made with `synchronous_commit = off` (the library path is already refused by `si_begin_read`) | `SI_READ_UNSAFE_SESSION` | `ok` |
| Search source lock omitted | Instrumented 1.5 s pause after the availability check; SUSPEND issued once the reader's backend is observed in the pause (`pg_stat_activity`) | `search:ok:1,suspend-waited` | `search:ok:0,suspend-immediate` (the page, checked available, silently releases nothing) |
| Response bound above the audit bound (the 0014 value) | Search page above 262,144 bytes | `SI_READ_RESULT_TOO_LARGE` | `SQLSTATE:23514` |
| History identity guard omitted (simulated key collision: the instrumented selector also takes `Acme Synthetic Labs`) | History of `Acme Synthetic` | `READ:INTERNAL` (`SI_READ_IDENTITY_CONFLICT`) | `ok:2` (identities merged) |
| (§11, updated) History identity by substring: selector and guard both removed | `Acme Synthetic` vs `Acme Synthetic Labs` | `ok:1` | `ok:2` |
| Lib: history bound checked per observation only (D2) | 12 observations, bound 11, page size 2 | `SCAN_LIMIT` after 1 request | `SCAN_LIMIT` after 6 |
| Lib: no page-size reduction on `RESULT_TOO_LARGE` (D1) | 60 large observations, default page size | `ok:60` | `RESULT_TOO_LARGE` |
| Lib: search merge ignores a reduced source page | Source A's page reduced to 2 of 5 hits; source B's 2 hits sort after A's | `n1,n2,n3,n4,n5,z1,z2` | `n1,n2,z1,z2` (A's n3–n5 skipped) |

Real response-bound tests (not lowered copies): REM-1 (exact boundary of the history function), REM-1b (a search page of 50 long-name hits refused raw; the library paginates completely, every released page ≤ 262,144 bytes), REM-4b (worst-case one-observation page). The §11 mutants run against the 0015 text (the §11 identity mutant now removes both the key selector and the identity guard).

### 12.8 D7 — consistency, corrected

This replaces the §11 consistency table. **Each page** is one statement under the source lock: consistent within itself. **No snapshot spans pages, and not every change between pages is detected.**

| Between pages | Detected? | Outcome |
|---|---|---|
| Authorization: the grant is revoked | Yes, per page | Every page re-checks the active grant: `NOT_AUTHORIZED` (REM-5) |
| Authorization: revoked **and restored** between two pages | **No** | The grant is not an input of the state token; the pages before and after are each authorized when computed (REM-5: `ok:3`) |
| The source becomes unavailable | Yes | `SOURCE_UNAVAILABLE` with reasons on the next page |
| Availability changes and recovers (suspend→lift, rights version, retire→un-retire, key rotation) | Yes, by the state token | `AVAILABILITY_CHANGED` |
| History: evidence added, expired or invalidated so that the summary changes (count, distinct ads, runs, first/last times, networks, spellings) | Yes | `RESULT_CHANGED` |
| History: an add-and-remove **swap that leaves the summary identical** (e.g. one run expires and another of the same instant becomes readable) | **No** | Each page is correct when computed; the result belongs to no single state (REM-5: `w1, w3` where w2 was replaced by w3) |
| Search: names added or removed | Not detected | Keyset continuation after the last returned name: no duplicates and no skipped later names; a name sorting before the position appears only in a new search; each page's aggregates reflect that page's time (REM-5) |
| Retention expiry between pages | History: detected only through a summary change; search: not detected | As above |

**History's actual guarantee:** every observation returned was readable evidence of an available, granted source when its page was computed; the summary is identical on every page; the number of observations returned equals that summary's count. It is not a snapshot. A stronger guarantee (for example a digest of the readable set carried between pages) would need its own design and evaluation and is not part of this remediation.

### 12.9 Governance, D8 and the Unicode/ICU risk

- **FD21** remains ratified for synthetic development (unchanged). **FD22** is recorded as **conditionally authorized for synthetic development, pending acceptance of M4-P2.1** (design doc). **R-22** is back to **PENDING**: its closure criteria are to be established independently. **R-26, R-28, R-29** remain open. Nothing here authorizes real evidence, customer access, export or production.
- **D8 (documented, R-30):** a page holds the source lock (`FOR SHARE`) for its whole statement, so an emergency control (SUSPEND, TERMINATE_RETENTION) on that source waits for the running page: measured 2.3–3.1 s at 200,000 candidates, bounded by the reader statement timeout (10 s). The control itself is not lost: it commits when the page ends, and every later page sees it. Pages, not controls, carry the 2 s lock timeout (a page never queues behind a control for more than 2 s).
- **Unicode/ICU upgrade (R-31):** identity depends on the server's Unicode tables (NFKC) and ICU (lower-casing). Both expression functions are declared IMMUTABLE for their index. A PostgreSQL or ICU upgrade that changes these tables can split or merge identities, leave the index inconsistent with the function, and change the search order. Required after such an upgrade: `REINDEX INDEX si.observations_by_source_advertiser_key` and a re-validation of identities. Nothing detects the change automatically today (no stored Unicode/ICU version is compared at startup).

### 12.10 Performance and resources, before and after (local PostgreSQL 16.15 container)

Workloads of M4-P2-ACCEPT-01: source A holds 200,000 observations of one advertiser (the candidate cap); in the resource harness, source B holds 400,000 observations of 500 advertisers. `SCALE-1` (`tests/slow/m4-remediation-scale.test.mjs`, slow CI job) asserts the D2/D3 outcomes on every run. Temporary-file figures come from `pg_stat_database.temp_bytes`, whose reporting lags by up to one request; the values below are per request, from paired readings.

| Workload | 61bda9d | M4-P2.1 (0015) |
|---|---|---|
| Library history of A (bound 5,000) | `SCAN_LIMIT` after **51 audited requests, 93 s, 4.56 GB** temp | `SCAN_LIMIT` after **1 request, 0.93–0.96 s, ~89 MB** |
| One history page of A (server) | 2.0 s, 93 MB temp | 0.93 s (Bitmap Index Scan on the key index; identity checked per spelling) |
| Concentrated search of A (200,000 candidates) | 2.5 s, 52 MB | 2.3–2.6 s, 50–52 MB |
| Same, reader `SET work_mem = '1GB'`, `hash_mem_multiplier = 1000` | 3.1 s, **0 MB (the reader relaxed the definer function's memory)** | 2.3–2.5 s, 49.8 MB (pinned: the session value is not used) |
| No-match search, 200,000 / 400,000 observations | 1.0 s / 2.5 s | 1.0–1.1 s / 2.5 s (unchanged: the scan is not bounded by the cap; §12.4) |
| Broad search of B (400,000 candidates) | `SCAN_LIMIT`, 3.1 s | `SCAN_LIMIT`, 3.4 s |
| Library history of one of B's 500 advertisers (800 observations, 8 pages) | 4.1 s | 3.4 s |
| SUSPEND issued during a concentrated search page (D8) | waited 2.3–3.1 s | waited 2.0–2.3 s |
| History page of 80–100 large observations (D1) | `INTERNAL` (23514) | complete (page size reduced 100 → 50) |
| Search of 50 hits of 990-character CJK names (D1) | `INTERNAL` | 25 hits and a cursor per library page; every page ≤ 262,144 bytes |
| History of a 304- or 1,000-character name (D5) | `BAD_ARGUMENT` | complete |
| Pagination after a 1,000-character CJK name (D4) | `BAD_CURSOR` | complete (cursors up to 44,110 characters measured, REM-4) |
| Ingestion of an incompressible 1,000-character CJK name | run failed (54000, index row size) | stored |

### 12.11 Regression findings during M4-P2.1 (Phase 9), each investigated

| Finding | Root cause | Resolution |
|---|---|---|
| History page time doubled at 200,000 candidates (2.0 → 4.8 s); a 600,000-observation database reached the 10 s timeout | The first index fix compared the full normalized name on every row (one normalization per row), in addition to the key | Identity verified once per distinct spelling (§12.6); history page 0.93 s |
| Lifecycle and intelligence demonstrations failed | They assert the applied migration list `1..14` | Updated to `1..15`; lifecycle 31/0, intelligence 7/0, demonstration mutants killed |
| AUD-12b failed once in the crash suite | Pre-existing: 1/10 on `61bda9d` and 1/10 on M4-P2.1, same assertion (the re-read after the flushing commit is refused `INTENT_NOT_DURABLE`). The test and the gate are not touched by 0015 | Recorded as R-32 (open, unexplained); it fails closed |
| REM-M "search source lock omitted" baseline failed once in three fresh-container passes (`suspend,search:ok:1`) | The scenario compared the completion order of two responses that arrive within milliseconds once the lock is released, after a fixed 500 ms head start | Barrier on the reader's pause and the control's measured wait instead of completion order; 10/10 afterwards |
| RC-1..RC-6 (M3, unchanged) failed once in six fresh-container passes | Its barrier diagnostic: the single-attempt read was refused `SI_READ_INTENT_NOT_DURABLE` before reaching its pause (R-26 mechanism; fail closed) | Not reproduced: 0/15 on `61bda9d`, 0/15 on M4-P2.1; recorded under R-29 |
| `pg_stat_database.temp_bytes` attributed temporary files to the next request | Statistics reporting lag | Figures reported from paired readings (§12.10) |

## 13. M4-P2.2: cold-database query reliability and identity hardening (migration 0016)

**Status:** IMPLEMENTED on branch `claude/b002-m4-p2-2` from the accepted `d0a318a` (M4-P2.1-ACCEPT-01: ACCEPT), pending independent acceptance. It resolves N1, N2 and N3 of that review. Synthetic data only. FD21/FD22 boundaries unchanged: same functions, signatures, privileges, gate, lock, grant and availability checks, evidence predicate, identity guard and bounds. No limit is raised.

### 13.1 Reproduction on the baseline (d0a318a, disposable databases)

"Cold" = a clone with autovacuum disabled on the `si` tables and no `ANALYZE` (fixture). That is the state of a source right after bulk ingestion until autovacuum analyzes it, of a freshly migrated database, and of a `pg_restore`d one (PostgreSQL 16 does not restore statistics; measured: 0 `pg_stats` rows after restore). `track_functions = 'all'` counts `si_evidence_readable` calls.

| Workload (one source) | Cold, 0015 | Warm, 0015 |
|---|---|---|
| 5,000 observations of one advertiser (10 runs): one history page | **statement timeout (10 s), 13,438 readability evaluations** | 34 ms, 10 evaluations |
| Same, library history (50 pages) | `RESOURCE_LIMIT` | 7.1 s (generic plan from page 6: 140 ms/page instead of 30) |
| 1,000 of 50,000 observations (100 runs): one history page | **statement timeout, 12,013 evaluations** | 95 ms, 100 evaluations |
| 200,000 observations of one advertiser (400 runs): first history page | **statement timeout** | 1.3–1.4 s |
| `pg_restore`d copy of a warm 5,000-observation database: library history | **`RESOURCE_LIMIT` (11 s)** | — |
| Search pages | complete (cold 4.8 s at 200,000 candidates, 2.9 s no match) | 3.2 s / 1.3 s |

`EXPLAIN (ANALYZE, BUFFERS)` of the cold history statement: the readable-run scan of `collection_runs` (filter `si_evidence_readable(run_id)`) is the inner side of a Nested Loop under the key-index scan of `observations` (estimated 1 row, actual 5,000), so it ran 5,000 times (16.7 s without the statement timeout).

**N2:** an identity guard checking only the first spelling (`unnest(a.names[1:1])`) was not killed by any test. **N3:** `SI_READ_IDENTITY_CONFLICT` reached the library caller as `ReadFailed INTERNAL`.

### 13.2 N1 — approaches measured

| Approach | Cold 5,000 / one page | Cold 200,000 / first page | Accepted? |
|---|---|---|---|
| 0015 (readable-run CTE joined in the page statement) | timeout, 13,438 evaluations | timeout | — |
| `WITH readable AS MATERIALIZED` (the review's proposal) | 50 ms, 10 evaluations | **timeout**: evaluated once per run, but the cold join still compared every observation with every run (Nested Loop over the CTE scan, 80 million comparisons) | No |
| **0016: readable runs selected first into an array; page filters `run_id = ANY (array)`; `finished_at` by primary key** | 47 ms, 10 evaluations | **1.6–1.8 s**, `SCAN_LIMIT` after one page (as warm) | Yes |

Why 0016 does not depend on statistics: the page statement has no join to choose. Membership is a scalar-array test (hashed, because with custom plans the array is a constant) and each matched observation's collection time is a primary-key lookup of its run (a correlated subquery, which has no alternative plan). The readable-run statement is a single scan of the source's runs: `si_evidence_readable` is evaluated once per candidate run, never per observation.

**N1b (found while reproducing):** with statistics, PL/pgSQL switches to a generic plan after five executions in a session; for the history statement it was 4–5x slower (140 vs 30 ms per page), and a reader could force it with `SET plan_cache_mode = force_generic_plan`. 0016 pins `plan_cache_mode = force_custom_plan` on both functions, like the 0015 resource settings. 0016 also needs it: the array must be a constant for the hashed test.

### 13.3 What 0016 changes in the statement structure (and why it is safe)

A page now runs, under the source lock (`FOR SHARE`, taken after the intent claim): the grant check, the availability state, **the readable-run selection** (new statement), then the page statement. Before 0016 the availability state was already a separate statement under the same lock.

- Every change of controls (SUSPEND, TERMINATE_RETENTION, LIFT), rights versions, grants and source rows locks the source row `FOR UPDATE`, so none of them can commit between the two statements.
- Changes that do not take the source lock, and their effect between the two statements:
  - A new verification verdict that makes a run readable: excluded from this page (conservative).
  - A purge of a run's observations: they no longer exist for the page statement.
  - A retention deadline passing by the clock: `si_evidence_readable` already requires 60 s of margin (`si_publish_margin`), more than the 10 s statement bound, so a run selected as readable cannot be released after its retention end.
- The evidence predicate is the 0015 text, verbatim, and appears exactly once in each function (M1p).
- Cold results equal the client-side oracle over INVALID, UNVERIFIABLE, pending and expired evidence (COLD-2), and equal the warm results (COLD-1).

### 13.4 N2 — identity guard coverage

COLLISION fixture: an instrumented copy of the history function that selects by the first character of the normalized name; the identity guard is the production text.
- Spellings `ACME`, `Acme` and a colliding `Azure Synthetic` sorting **after** them; and a colliding `AAA Synthetic` sorting **before**.
- Both are refused `IDENTITY_CONFLICT` with page size 100 and 1. Nothing is released and the intent stays OPEN (IDG-1).
- A filter that excludes the colliding rows (networks) returns exactly `a1, a2, a1` across pages. An advertiser without a colliding name is unaffected.
- Search, which compares full normalized names, reports `acme:3, azure synthetic:1, bravo synthetic:1`.
- Mutant "identity guard checks only the first spelling" (collider sorts after): baseline `INTEL:IDENTITY_CONFLICT`, mutant `ok:3` (merged). Killed (COLD-M).

### 13.5 N3 — typed identity conflict

- The library maps exactly SQLSTATE `22000` with the exact message `SI_READ_IDENTITY_CONFLICT: the advertiser key selects another normalized name` to `IntelligenceFailed('IDENTITY_CONFLICT')`, with the source id and no reasons.
- The error carries no name, key or count: its message is `INTELLIGENCE_FAILED: IDENTITY_CONFLICT`. IDG-1 asserts that neither the error, its string form nor its stack mentions either identity.
- Tested on the real database-to-library path. Mutant "mapping removed": `READ:INTERNAL`, killed (IDG-M lib).

### 13.6 Cold and warm performance (local PostgreSQL 16.15 container, medians of single runs)

| Workload | 0015 cold | 0015 warm | 0016 cold | 0016 warm |
|---|---|---|---|---|
| 5,000 obs / 10 runs: history page | timeout | 34 ms | 47–67 ms | 33–40 ms |
| Same: library history, 50 pages | `RESOURCE_LIMIT` | 7.1 s | 1.7–2.1 s | 1.6–2.0 s |
| Same: concentrated search page | 75 ms | 73 ms | 76–88 ms | 81–92 ms |
| 1,000 of 50,000 obs / 100 runs: history page | timeout | 95 ms | 112 ms | 105 ms |
| Same: library history (10 pages) | `RESOURCE_LIMIT` | 1.1 s | 0.94 s | 0.95 s |
| Same: search page / no match | 715 / 564 ms | 395 / 399 ms | 400 / 368 ms | 449 / 382 ms |
| 200,000 obs / 400 runs: history page | timeout | 1.3–1.4 s | 1.6–1.8 s | 1.7 s |
| Same: concentrated search / no match | 4.8 / 3.0 s | 3.2 / 1.3 s | 3.8–4.3 / 1.3–1.6 s | 3.6 / 1.3 s |
| `pg_restore`d copy, 5,000 obs: library history | `RESOURCE_LIMIT` (11 s) | — | **5,000 in 3.3 s** | — |

- Readability evaluations per page with 0016 equal the source's run count, cold and warm.
- The warm 200,000-observation history page is about 20% slower than 0015's: 200,000 primary-key lookups replace a hash join. That is the price of a plan that does not depend on statistics.
- Temporary files are unchanged (89.6 MB per 200,000-candidate history page, 41.6 MB per search page).

### 13.7 Tests

| Test | What it shows |
|---|---|
| COLD-1 (`tests/db/m4-cold-identity.test.mjs`) | Cold 5,000-observation history within a 2 s statement timeout. Exactly 10 readability evaluations per page and 500 for 50 pages (since 0018, §14: no per-run evaluation and one set-based evaluation per page). Cold search. 5,001 refused after one page (`SCAN_LIMIT`, not a timeout). Results equal the warm ones after `ANALYZE` |
| COLD-2 | Cold results equal the client-side oracle over INVALID, UNVERIFIABLE, pending and expired evidence |
| COLD-3 | `plan_cache_mode` pinned; a reader's `force_generic_plan` is not in effect inside |
| IDG-1 | §13.4 and §13.5 |
| COLD-M db | 0015-shape history (cold page: `ok:readable-calls=10` → `SQLSTATE:57014`); `plan_cache_mode` unpinned (`force_custom_plan` → `force_generic_plan`); partial identity guard (`INTEL:IDENTITY_CONFLICT` → `ok:3`) |
| IDG-M lib | Conflict mapping removed: `INTEL:IDENTITY_CONFLICT` → `READ:INTERNAL` |
| SCALE-2 / SCALE-2M (`tests/slow/m4-cold-scale.test.mjs`, slow CI job) | Cold 200,000-observation source: history refused after one page (1.8 s), concentrated search 4.3 s, no-match search 1.6 s. The 0015 history function on the same workload: `RESOURCE_LIMIT` (10 s), killed |
| M1p (`migrations.test.mjs`) | 0016 changes exactly the two functions. ACLs unchanged; the only setting added is `plan_cache_mode`. No join with the readable runs; the predicate appears once. Down restores the exact 0015 catalog; up re-applies identically |
| DR-1 | COLD-1, COLD-3 and IDG-1 also run on the restored cluster |

Tests built from the production function text (SRV, REM) now use 0016's text. Anchors that named the 0015 CTE were moved to the readable-run statement. The REM-M "identity guard omitted" baseline is now the typed `INTEL:IDENTITY_CONFLICT`.

### 13.8 Regression findings during M4-P2.2, each investigated

| Finding | Root cause | Resolution |
|---|---|---|
| MG2 and MG9 failed in the first fresh-container pass | Two expectations in `migrator.test.mjs` still listed migrations `1..15` and a count of 15 | Updated to 16; the full suite was re-run from the start |
| RT-13 (M3 purge-contention timing) failed once in the first run (`maximum purge batch 8201 ms <= 5000 ms`) | Pre-existing (R-28): reproduced 1/8 on `d0a318a` and 0/8 on M4-P2.2; it does not use the reader functions | R-28 stays open |
| AUD-12c failed once in the crash suite (`SI_READ_INTENT_NOT_DURABLE`) | The R-26/R-32 gate-liveness family; the test reads through `si_read_evidence`, which 0016 does not touch | Not reproduced: 0/25 on `d0a318a`, 0/25 on M4-P2.2. AUD-12b, same family: 3/25 on `d0a318a`, 2/25 on M4-P2.2. R-32 stays open |
| SCALE-2M was not killed once (the 0015 function took 8.5 s, under the 10 s timeout) | The mutant's slowness varies between 8.5 s and more than 10 s | Both history calls of SCALE-2 now run under a 4 s reader statement timeout (0016: 1.4–1.8 s; 0015: at least 8.5 s): 2/2 since |
| CI-131 integration, attempt 1, pass 3: RC-1..RC-6 (M3, unchanged) | The read was refused `INTENT_NOT_DURABLE` before its pause. Root cause: the durability gate's target lies past the next WAL page's header when the last record ends on a page boundary, so a fully flushed intent is refused after 1 s on a quiet server (R-35, pre-existing since 0010/0011; not 0016). Reproduced deterministically on `d0a318a` and `bd5e8f2`; naturally 1/80 runs on each | Product correction deferred to a reviewed increment (R-35). The test is correct and unchanged |
| CI-131 integration, attempt 2, pass 2: REM-M lib "history bound checked per observation only" counted 7 requests instead of 6 | Test defect (M4-P2.1): the request counter included an attempt refused `INTENT_NOT_DURABLE` (R-35), which the library repeats with a fresh intent. The mutant was still killed (7 vs 1) | `counting()` counts NOT_DURABLE-refused attempts apart; every other failure still counts; exact counts unchanged (1 and 6). REM-0 injects one refusal and fails against the old counter |


### 13.9 Limitations (unchanged or new)

1. Search remains O(observations of the source) per page (§12.4), and every page re-evaluates readability for every run of the source (O(runs)).
2. The warm 200,000-candidate history page is about 20% slower (§13.6).
3. The per-page readable-run array grows with the number of runs of a source in the period (400 at the measured cap).
4. R-26, R-28, R-29 and R-32 remain open. All Milestone 3 real-evidence, pilot and production NO-GOs remain.

## 14. M4-P3.0: set-based evidence readability (migration 0018)

**Status:** IMPLEMENTED on branch `claude/b002-m4-p3-0` from the accepted `023fc36` (M3-R35.1), pending independent acceptance. It must be accepted on its own before M4-P3.1. Synthetic data only. No advertiser summary, identity dictionary, new publication-time metadata or cached readability; no table, column or index. FD21/FD22 boundaries, the M3 durability gate (0017), durability and audit are unchanged.

### 14.1 The oracle and its callers (unchanged)

`si_evidence_readable(run)` (0007, STABLE, SECURITY INVOKER) is the authoritative predicate. It reads `clock_timestamp()` once per call (instant t, margin m = `si_publish_margin()` = 60 s) and is TRUE exactly when every condition below holds. A missing row or a NULL anywhere makes it FALSE (`coalesce(..., false)`).

| # | Condition | Varies by |
|---|---|---|
| 1 | a verdict row exists (`receipt_verifications`, primary key `run_id`: at most one) and it is `VALID` | run |
| 2 | run `COMPLETED`, `RETAINED`, `published_count > 0` | run |
| 3 | source `evidence_kind = 'SYNTHETIC'` | source |
| 4 | source not retired, nor retiring within the margin: `retired_at IS NULL OR t + m < retired_at` | source |
| 5 | source not suspended: the latest control (by `control_seq`) is not `SUSPEND` / `TERMINATE_RETENTION` (`si_source_suspended`) | source |
| 6 | retention not terminated for the run's rights version (`si_retention_terminated(source, version)`) | version |
| 7 | active retention: `t + m < least(retain_until, si_retention_end(source, version))` (`least` ignores a NULL; both NULL: FALSE). `si_retention_end` is the earliest of a covering termination, a retain revocation by a later version and the expiry of an allow-version, each only if it took effect | run × version |
| 8 | current rights: the version in effect at t (the highest `version` with `effective_from <= t`) allows evaluation and retention, and `t + m < si_window_end(it)` (its expiry, the next version's `effective_from` including a scheduled one, a covering termination) | source |
| 9 | every observation of the run is in a network of `supported_networks` (`NOT EXISTS ... NOT (o.network = ANY (supported_networks))`) | run |

Not part of the predicate, enforced by the readers before it: the reader's grant and scope (checked under the source lock), the availability state (FD21 token), the committed and durable read intent (0009/0010/0017 gate), and the response and scan bounds.

Callers: `si_read_evidence` and `si_read_source_status` (unchanged: still the oracle, per run), and `si_search_advertisers` / `si_advertiser_history` (0016: the oracle once per run of the source on every page; changed by 0018).

Transactions and locks (unchanged by 0018): a page takes the source row `FOR SHARE` after its intent claim. Controls, rights versions, grants, run completion and purge lock the source row (`FOR UPDATE` / `FOR NO KEY UPDATE`) and cannot commit during a page. Receipt verification takes no source lock; a verdict only ever makes a run readable, and a page that misses it is conservative. The 60 s margin exceeds the 10 s statement bound, so a run selected at t cannot be released after its retention or rights end (§13.3).

### 14.2 Design

`si_readable_runs_at(source, from, to, t)` (PL/pgSQL, STABLE, SECURITY INVOKER, owner-only, `plan_cache_mode = force_custom_plan`) returns the runs of the 0016 readable-run statement at instant t: COMPLETED, RETAINED, `published_count > 0`, in the period, and the oracle's conditions. Four statements, each with no join whose plan depends on statistics:

1. **Source, once** (conditions 3, 4, 5, 8): if any fails, no run is readable (early return). It also yields the unsupported networks: the five networks of the `ads.network` CHECK minus `supported_networks`, with the oracle's NULL semantics.
2. **Rights versions of the source, once each** (6 and the version half of 7): ids of the non-terminated versions whose retention end is set and later than t + m, and of those without a retention end. Condition 7 is exactly "(retain_until or end set) and each one that is set > t + m".
3. **Networks** (9): only if a network is unsupported, the runs with an observation of an ad of this source in an unsupported network (`ads (source_id, network, ...)` and `observations_by_ad`, proportional to evidence in unsupported networks only). This is exact because an observation's network is its ad's (composite foreign key `observations_ad`, all columns NOT NULL) and `ads.network` is CHECKed to the five networks. EQ-0 asserts both.
4. **Runs, one scan of the source's runs** (1, 2, the run half of 7, 9, period): the verdict by primary key (a correlated scalar lookup, not a join), and hashed membership in the constant arrays of 2 and 3.

`si_readable_runs(source, from, to)` calls it with `t = clock_timestamp()` once. In both reader functions the 0016 readable-run statement is replaced by `readable_runs := si.si_readable_runs(p_source_id, p_from, p_to);`. Nothing else in them changes (M1r: definitions equal the 0017 text with that one replacement; ACL, settings, SECURITY DEFINER, volatility and owner unchanged).

**Time semantics (the one intended difference).** The oracle reads the clock separately for each run; 0018 decides a page at one instant. Within one page statement the oracle could see a boundary between two runs; 0018 cannot. Equivalence is therefore stated and tested as "0018 at t = the oracle at the same t" (EQ-2 to EQ-4), plus the real oracle at real time wherever no boundary falls inside the statement (EQ-1, EQ-2).

A first set-based draft (one SQL statement joining runs, verdicts, versions and CTEs) was equivalent but **plan-dependent**: on a cold database at 400 runs the planner chose a nested loop with a sequential scan of `receipt_verifications` per run (80,000 comparisons, 12 ms); at 2,000 runs it chose hash joins (8 ms). A plan that is quadratic when statistics are missing is the 0015 hazard (§13), so it was replaced before measurement by the form above.

### 14.3 Equivalence (tests/db/m4-readability-equivalence.test.mjs)

Reference = the 0016 readable-run statement, verbatim, with `si_test_evidence_readable_at(run, t)`. That function is the installed oracle with exactly one substitution, `clock_timestamp()` → `p_t`; EQ-0 compares `prosrc` against the installed oracle. Comparisons are exact arrays (multisets: no duplicates).

| Test | States | Result |
|---|---|---|
| EQ-0 | Design dependencies; instruments are the installed functions | `ads.network` CHECK domain = the literal of 0018; `observations_ad` FK on NOT NULL columns; `receipt_verifications` PK = `run_id`; margin 60 s; oracle copy = installed oracle with exactly one substitution; candidate = active 0018 text; both readers call it once and never the oracle |
| EQ-1 | Product path at real time, after every step: VALID, pending, INVALID, UNVERIFIABLE, EMPTY, RUNNING, reaped (FAILED), retain_until within/beyond the margin, retention ended, purged, grant revoked, network reduced (unsupported and mixed runs) and restored, SUSPEND/LIFT, retain revocation by a later version, expiry within the margin, TERMINATE_RETENTION, retirement in a day and within the margin, a period | real `si_readable_runs` = real oracle, and both equal at the same instant, at every step; grant revocation does not change the set |
| EQ-2 | Six runs whose retention ends and a scheduled v2 (retain DENIED) cross in real time over 6.5 s | about 980 samples: exact equality at the injected instant on every sample; real-time differences only on samples straddling a known boundary (2) |
| EQ-3 | 8 s of concurrent publication (about 480), verification, purge (about 73), reaping (about 73), SUSPEND/LIFT (15) | about 300 REPEATABLE READ snapshots: candidate = reference on every one, no duplicate |
| EQ-4 | ZOO, seed 20261114, 120 trials x 3 sources x 5 instants (t, t ± 1 µs, t - margin) x 2 periods. Each trial randomizes, within PK/FK/NOT NULL only: run status (all 4), retention state (all 5), published_count, retain_until and finished_at on boundary values, verdicts (all 3, pending, inserted), controls (SUSPEND/LIFT/TERMINATE with any through_version and time), rights versions (evaluation/retain ALLOWED/DENIED/UNKNOWN, effective_from and expiry on boundaries, a scheduled v3), supported_networks (subsets, empty, NULL element, unknown value), retirement, evidence kind | 3,600 comparisons, all identical; about 2,400 readable and 45,600 unreadable run evaluations; every status, retention state and verdict covered (asserted). Reproduce with `SI_EQ_SEED`, `SI_EQ_TRIALS` |

No mismatch was observed. The ZOO fixture drops CHECKs and disables user triggers on five state tables in a disposable clone so that impossible states are also compared; the evidence tables and every key the design relies on are untouched.

### 14.4 Mutation testing

The 34 mutants of `si_readable_runs_at` run on the EQ-4 states. A mutant is killed when it disagrees with the reference. Every disagreeing run is then checked against facts computed independently from the tables at the same t, which must show the mutant's intended reason: for example, a run gained by "verdict condition removed" must have a non-VALID or missing verdict.

| Mutant | Kills (of 3,600) | Unexplained |
|---|---|---|
| verdict condition removed | 386 | 0 |
| unknown (pending) verdict treated as readable | 268 | 0 |
| run status / retention state / published_count condition removed | 282 / 408 / 62 | 0 |
| evidence kind condition removed | 44 | 0 |
| retirement condition removed (missing source-status check) / margin removed / `<` → `<=` | 165 / 71 / 9 | 0 |
| suspension condition removed (missing source-status check) | 294 | 0 |
| current rights condition removed | 269 | 0 |
| wrong rights version: latest ignoring effective_from / first instead of current | 59 / 613 | 0 |
| effective_from `<=` → `<` | 6 | 0 |
| current evaluation / retain removed | 92 / 64 | 0 |
| rights window removed / margin removed / `<` → `<=` | 48 / 42 / 4 | 0 |
| retention termination removed | 13 | 0 |
| retention condition removed (missing retention) / retain_until ignored / rights retention end ignored | 506 / 487 / 25 | 0 |
| retention `<` → `<=` / margin removed | 16 / 169 | 0 |
| network condition removed | 287 | 0 |
| incorrect network predicate: first unsupported network only / first observation only / supported read as unsupported | 124 / 158 / 869 | 0 |
| period end inclusive / start exclusive | 42 / 55 | 0 |
| source filter removed (runs of another source) | 1,036 | 0 |
| unsafe join duplicating runs: per observation / verdicts joined by source | 665 / 750 | 0 (only extra copies of readable runs) |

All 34 mutants are killed, and every disagreement is explained by the mutant's intended reason.

The M4 reader mutants of earlier phases now target the active text: the period-end mutants edit `si_readable_runs_at`, "history readable-evidence predicate omitted" replaces the call, and the source-lock pause sits before it.

### 14.5 Performance

One synthetic source, 10 observations per run, built through the product path. The states are mixed: 5% INVALID, 3% pending, 5% retention ended but not purged, about 5% GOOGLE runs made unsupported, and 14% mixed META/TIKTOK runs. Environment: local PostgreSQL 16.15 container (fsync off, tmpfs). Each figure is p50 / p95 over 20 requests, the 0016 path also over 20.
- *Selection* is the readable-run selection alone, with the readers' pinned settings and the 10 s timeout.
- *History* is a one-page library history request, the complete reader path: lock, intent, gate, audit.
- *Search* is a library search request, reported only: its page statement scans every candidate observation of the source (§12.4), which this phase does not change.
- `tests/slow/m4-readability-bench.test.mjs`.

| Runs (readable) | State | Selection 0018 | Selection 0016 | History 0018 | History 0016 | Search 0018 | Search 0016 |
|---|---|---|---|---|---|---|---|
| 10 (8) | cold / warm | 1.6 / 2.2, 1.5 / 1.8 ms | 3.4 / 3.8, 3.5 / 3.8 ms | 4.4 / 5.0 ms | 6.8 / 7.3 ms | 4.8 / 5.3 ms | 7.2 / 8.6 ms |
| 100 (84) | cold / warm | 2.1 / 2.6, 1.8 / 2.1 ms | 28.7 / 38.6, 28.7 / 29.5 ms | 4.8 / 5.8 ms | 33.6 / 42.7 ms | 9.0 / 10.4 ms | 38.2 / 66.3 ms |
| 400 (333) | cold / warm | 2.2 / 3.7, 2.5 / 2.8 ms | 110 / 135, 113 / 120 ms | 5.2 / 6.2 ms | 115 / 131 ms | 20.7 / 22.7 ms | 132 / 308 ms |
| 2,000 (1,658) | cold / warm | 6.7 / 7.9, 6.4 / 7.2 ms | 549 / 641, 563 / 619 ms | 8.4 / 12.3 ms | 583 / 651 ms | 86 / 107 ms | 650 / 703 ms |
| **10,000 (8,243)** | cold | **29 / 36 ms** | 2,784 / 2,884 ms | **23.5 / 24.3 ms** | 2,910 / 3,058 ms | 428 / 443 ms | 3,342 / 3,455 ms |
| | warm | **31 / 35 ms** | 2,867 / 2,948 ms | **26.3 / 34.3 ms** | 3,036 / 3,121 ms | 421 / 488 ms | 3,426 / 3,557 ms |
| **30,000 (25,001)** | cold | **155 / 192 ms** | 8,508 / 8,667 ms | **113 / 124 ms** | 8,842 / 9,053 ms | 1,372 / 1,481 ms | 8 of 20 `RESOURCE_LIMIT` (10 s) |
| | warm | **102 / 109 ms** | 8,719 / 8,908 ms | **83 / 111 ms** | 8,985 / 9,227 ms | 1,334 / 1,425 ms | 18 of 20 `RESOURCE_LIMIT` |
| | restored | **137 / 153 ms** | 9,007 / 9,228 ms | **105 / 117 ms** | 9,167 / 9,368 ms | 1,363 / 1,441 ms | 20 of 20 `RESOURCE_LIMIT` |

The table shows p50 / p95; where two pairs are given, the second is the warm figure.

**Targets.** Selection and history at 10,000 runs: p95 ≤ 100 ms, met. At 30,000 runs: p95 ≤ 400 ms, met cold, warm and restored. No timeout, no temporary file (0 bytes over 20 selections at every layout), no limit raised.

**Other measurements.**
- *Search.* At 10,000 runs search is about 440 ms, of which about 30 ms is readability. Its page statement, O(observations), is the next step (M4-P3.1); M4-P3.0 brings it from timeouts to 1.4 s at 30,000 runs.
- *Peak backend memory.* VmHWM, which includes the shared buffers touched, was 99–171 MB at 10,000–30,000 runs. The memory used by the function itself is the arrays: 16 bytes per run.
- *Plans.* The nested plans are linear and statistics-independent, cold and warm (auto_explain). At 10,000 runs, cold:
  - the source statement: hash of 1 source row and 1 version (0.4 ms);
  - the network statement: bitmap scan of the unsupported networks' ads, then `observations_by_ad`, 5,000 rows, 8.8 ms, 15,600 buffer hits;
  - the run scan: index scan of the source's runs with a primary-key verdict lookup per run, 18.6 ms, 29,000 buffer hits;
  - 35 ms in total.
- *Restored.* pg_dump -Fc / pg_restore into a fresh database, no statistics; the server is not restarted (its data is in tmpfs).
- *R-26.* Requests refused once by the durability gate and retried by the library (about 1–4 s, pre-existing) are counted apart, on both paths: at most one per 20.

### 14.6 Security and privileges

- **New functions:** `si_readable_runs_at` and `si_readable_runs`, both SECURITY INVOKER, owned by `si_owner`, `EXECUTE` revoked from PUBLIC; no role is granted them (privileges test).
- **Who runs them:** only the two SECURITY DEFINER reader functions call them, so the code runs as `si_owner` with the readers' pinned settings (work_mem, temp_file_limit, statement timeout, jit, parallelism; `plan_cache_mode` also pinned on the new function).
- **Reader privileges:** no new table privilege.
- **Unchanged:** the grant check, availability token (FD21), intent claim and logging, durability gate, identity guard and response bounds (M4 suites, DR-1).
- **Reversibility:** migration down restores the exact 0017 catalog, and up re-applies identically (M1r).

### 14.7 Limitations and risks

1. Single-instant semantics (§14.2). This is intended and conservative: no run is released that the oracle would refuse at the page's instant.
2. Statement 2 is O(versions²) per page (`si_retention_end` per version) and statement 3 is O(unsupported evidence). Both are small for synthetic sources; a source with many versions or much evidence in a de-supported network is unmeasured beyond §14.5.
3. The page statement itself remains O(observations of the source) for search (§12.4). M4-P3.0 removes only the per-run readability cost.
4. Write path (observed while building the benchmark, pre-existing, not changed): one collector session that ingests about 10,000 runs into a database without statistics slows down steeply in `si_complete_run`, consistent with plans cached when the tables were small (98% CPU in one backend after about 7,000 runs). The benchmark reconnects its collector every 500 runs. Recorded as R-37.
5. R-26 (gate refusals on stray WAL) affects request latency independently (§14.5 counts the retries). R-26, R-28, R-29, R-32 and R-36 remain open. All real-evidence pilot and production NO-GOs remain.

### 14.8 M4-P3.0.1: readability hardening (migration 0019; conditions A–C of M4-P3.0-ACCEPT-01)

M4-P3.0-ACCEPT-01 gave M4-P3.0 a CONDITIONAL ACCEPT with three conditions. Under the current schema the independent review found no mismatch (159,360 own comparisons plus 36,000 with new seeds). Migration 0019 replaces only `si_readable_runs_at`, keeping its owner, privileges, STABLE volatility and settings. The oracle, `si_readable_runs` and both readers are unchanged, and 0018 is not edited.

**A — network domain.** In 0018, the unsupported networks were the five-name literal minus `supported_networks`. If the domain were ever extended, the new network would never be treated as unsupported, and its runs would be released.

0019 derives the unsupported networks from stored data instead. The candidates are the network values actually present for the source's evidence: `ads (source_id, network, ...)`, one index probe per distinct value (a loose index scan). Each candidate is kept when `NOT (network = ANY (supported_networks))` holds, which is the oracle's own test with the oracle's NULL semantics.

Each observation's network equals its ad's through the composite FK `observations_ad`, so the excluded runs are exactly the oracle's. The alternatives were measured on the same 30,000-run dataset (p95, cold, no statistics):

| Network predicate | 10,000 runs | 30,000 runs | Exact if the composite FKs are bypassed? |
|---|---|---|---|
| 0018: five-name literal | 67.7 ms | 253 ms | no |
| **0019: stored network values (adopted)** | **62.1 ms** | **193 ms** | no (characterized, below) |
| per-run probe of each run's own observations (the oracle's form) | 118 ms | 338 ms | yes |

The per-run probe is the only form independent of the composite FKs, and it misses the 10,000-run target, so it was not adopted. The dependency on the FKs is unchanged from 0018. It is characterized by EQ-6, a disposable fixture that bypasses FK triggers with `session_replication_role = replica`:

| Case | Oracle | 0019 (and 0018) |
|---|---|---|
| (i) observation network differs from its ad's | refused | released |
| (ii) observation references another source's ad | refused | released |
| (iii) dangling ad reference | refused | released |
| (iv) META observation on a TIKTOK ad of the source | readable | refused (conservative) |

None of these states can be reached through the product's write path. **They do not require superuser rights** (corrected by M4-P3.0.1-ACCEPT-01, reproduced by IG-3): `si_owner` owns the tables, and so does any role able to `SET ROLE si_owner`, such as `si_migrator`. Such a role can drop or replace the keys, insert an observation that violates them (also into a COMPLETED run: the append-only triggers block only UPDATE and DELETE), and re-add the key `NOT VALID`. A superuser can additionally bypass FK triggers with `session_replication_role = replica` while the keys stay VALID. The controls that keep readers away from such states are in §14.9.

EQ-5 simulates a later migration that adds a network, SNAP, with FK-consistent evidence:
- source supports META: the oracle and 0019 both refuse the runs with SNAP evidence, while the 0018 form releases them (killed);
- source supports META and SNAP: both release them;
- source supports only SNAP: both refuse everything.

New mutants killed on the EQ-4 states: "network enumeration stops after the first stored value" and "unknown network comparison treated as unsupported". The 36 mutants in total each have 0 unexplained disagreements.

**B — single snapshot.** `si_readable_runs_at` must stay STABLE. Under READ COMMITTED, a STABLE PL/pgSQL function runs all four of its statements on its caller's snapshot; a VOLATILE one takes a new snapshot for each statement. This is now documented in the function itself.

`tests/db/m4-readability-snapshot.test.mjs` uses an instrumented copy that differs from the active text only by one `pg_sleep` between statements 1 and 2 (asserted). While the reader is paused, a single writer transaction removes TIKTOK from the source's networks and records a VALID verdict for a pending META run B. Run A is a VALID TIKTOK run and C a VALID META run.

| Test | Result |
|---|---|
| SNAP-1 (direct) and SNAP-1v (through the VOLATILE wrapper the readers call) | exactly the before-set {A, C}; a new call afterwards returns exactly the after-set {B, C} |
| SNAP-M (VOLATILE mutant) | exactly {A, B, C}: a set that never existed, which releases A (unauthorized) — killed |

A reader failure inside the fixture is reported as a fixture error, never as a kill. The catalog volatility pin (privileges) and SNAP-0 remain.

**C — R-37** is recorded with the independent findings and remains a separately tracked write-path risk (risk register). `si_complete_run` is unchanged.

### 14.9 Trust boundary and integrity controls (M4-P3.0.1-CLOSE-01)

**What the readers' correctness rests on.** These are separate invariants. Production SQL enforces each of them; none is re-checked per read.

1. **Validated composite foreign keys**, `observations_ad (ad_id, source_id, network, native_ad_id)` and `observations_run (run_id, source_id, rights_version_id)`, on NOT NULL columns. The 0019 network optimization relies on them: an observation's network is its ad's (§14.8, EQ-6).
2. **Immutable completed-run evidence.** The append-only triggers on `observations` and `ads`, the run-completed and ad-has-observation constraint triggers, and the purge path are the only writers. This is a separate invariant, not implied by (1).
3. **One snapshot inside the readability helper.** `si_readable_runs_at` is STABLE, so its four statements read one snapshot (SNAP-*).

   The reader functions are a different matter. They run the readability statement (`readable_runs := si.si_readable_runs(...)`) and the evidence page statement separately under READ COMMITTED, so they do **not** read one transaction-wide snapshot. Writers that can change readability are excluded during a page by the source lock (`FOR SHARE`, §13.3). What the lock does not cover is evidence appended between the two statements: M4-P3.0.1-ACCEPT-01 showed such an observation (written with a superuser fixture) is returned. This is safe only while invariant (2) holds; the product never appends to a completed run.
4. **The catalog is not the data.** A catalog check shows the constraints are in force **now**. It does not prove that rows written while they were not in force are consistent: rows written while a key was dropped, `NOT VALID`, or bypassed by disabled triggers or replica mode (IG-4). Only a data audit shows that.

**Controls (no production SQL change, no per-read scan).**

| Control | File | What it checks | Cost | When |
|---|---|---|---|---|
| Catalog integrity gate | `db/ops/integrity-gate.sql` | both FKs: exist on `si.observations` with the expected name, are foreign keys, have the exact expected definition, are validated, have all 4 enforcement triggers enabled (2 on `observations`, 2 on the referenced table), have NOT NULL referencing columns and a valid unique referenced key; the 7 immutability/integrity triggers on `observations` and `ads` are enabled; no stored `session_replication_role` default for any database or role | catalog only: about 2.5 ms (IG-5; 0.05 ms server time measured by M4-P3.0.1-ACCEPT-01) | deployment verification (CI integration job), DR-1 on the restored cluster, step 2 below |
| Data audit `FK_AUDIT` | `db/ops/fk-audit.sql` | every observation whose composite references do not hold, whatever the state of the constraints | full scan of `si.observations` (130–200 ms at 300,000 observations) | step 3 below; never per read |

Both are read-only (IG-1 runs them as `si_owner` in a READ ONLY transaction). PASS means zero rows, and each row of the gate names one failed check. Run them with:

    psql -X -v ON_ERROR_STOP=1 -At -f db/ops/integrity-gate.sql
    psql -X -v ON_ERROR_STOP=1 -At -f db/ops/fk-audit.sql

IG-2 checks that each tampering is reported by exactly its own check: a key dropped, replaced by a narrower key or re-added `NOT VALID`, an enforcement trigger disabled on either table, a referencing column made nullable, an immutability trigger disabled, a stored replica default. Each runs as `si_owner` where the owner can perform it (asserted), otherwise as superuser.

**Procedure after any operation that can bypass integrity.** This covers a privileged or data-only load, any `DISABLE TRIGGER`, `session_replication_role = replica`, dropping, replacing or re-adding a constraint, or a restore that is not a full `pg_restore` (a full restore re-validates the keys):

1. **Readers stay disabled for the affected sources.** Record a `SUSPEND` control (`si_record_source_control`) for each affected source before the operation, or for every source when the scope is unknown. Readers then refuse those sources (availability `SUSPENDED`), and the source lock orders the control against pages in flight.
2. **Restore and validate the constraints.** Re-create any dropped key, run `ALTER TABLE ... VALIDATE CONSTRAINT` (it fails on an inconsistent row), re-enable triggers and reset `session_replication_role`. Then run the gate; it must return zero rows.
3. **Run `FK_AUDIT`**; it must return zero rows. It also finds rows written while the keys looked valid (IG-4).
4. **Any row returned by either query blocks re-enabling readers.** The affected evidence is investigated and corrected through a reviewed procedure; readers are not re-enabled to work around it.
5. **Record the verification.** Re-enable readers with the `LIFT` control (`lift`). Its `reason` names the verification ("integrity gate PASS, FK_AUDIT 0 rows, <time>") and its `reference` names the change ticket. Source controls are append-only, so the record is durable and attributed (`recorded_by`).

This is an operational control. It does not make inconsistent states unreachable to the owner role, and it does not replace restricting who can assume `si_owner` (docs/b002-d5b-production-hardening.md).

**Mutation coverage.** M4-P3.0.1-ACCEPT-01 found that the "retention termination condition removed" mutant was killed on some seeds of the randomized EQ-4 and not on others; seed 424242 is reproduced with 0 kills. In product-reachable states the condition is redundant: a termination is recorded at its own time and also ends retention through `si_retention_end`. EQ-7 now kills it deterministically. Its fixture records a covering TERMINATE_RETENTION at t + 1 day followed by a LIFT, with its facts asserted before the comparison, so a setup failure is never a kill. A control case (termination of version 0 only) shows the mutant agrees wherever the condition is not decisive. EQ-4 remains randomized: it requires every other mutant to be killed on every seed and names the one covered by EQ-7.


## 15. M4-P3.1: immutable advertiser summaries and identity dictionary (migration 0020)

**Status:** IMPLEMENTED on branch `claude/b002-m4-p3-1` from `1d6fb8f` (M4-P3.0.1-CLOSE-01), pending independent acceptance. Storage foundation only: **no reader reads these tables**. `si_search_advertisers` and `si_advertiser_history` are unchanged (M1t asserts their definitions); switching them is M4-P3.2. Synthetic data only. Owner-only tables and functions; no reader or application role gains any privilege. No authorization or readability decision is stored. Readability stays live (§14), and so do verdicts, rights, controls, grants and expiry.

### 15.1 Design decisions

| # | Question | Decision |
|---|---|---|
| D1 | Distinct ads across runs without summing per-run counts | Within a run an ad occurs once (`observations UNIQUE (run_id, ad_id)`), and `ad_id` ↔ `(source, network, native_ad_id)` is one-to-one (`ads` UNIQUE). Each summary row stores the run's sorted `ad_ids`. Distinct ads over any set of runs = the number of distinct elements of the union. Per-run counts (`observations`) are summed only for observation counts. SUM-1: 4 distinct ads, 7 observations. |
| D2 | Digest and normalized-name collisions | The identity **is** the normalized name (`si_normalize_advertiser`, the existing rule) under a normalizer fingerprint. The 32-byte digest is only the index key; a CHECK enforces `advertiser_key = sha256(normalized_name)`. Publication inserts missing identities, then compares the stored normalized name for every digest it uses. A digest recorded for another name fails the publication closed (`SI_SUMMARY_IDENTITY_COLLISION`, SUM-2). Different raw spellings with one normalized name are one identity by design; each run keeps its distinct raw spellings (`names`). |
| D3 | Long normalized names | Up to 18,000 characters (1,000 × an NFKC expansion of up to 18). They are stored but never indexed; the unique index is `(source_id, normalizer, advertiser_key)`. SUM-1 publishes an 18,000-character name. |
| D4 | Normalizer changes | The fingerprint `v1|icu=<actual und-x-icu version>|pg=<major>` is recorded on identities and on each run's status. A status with another fingerprint is STALE: the run is not eligible, the guard admits deleting its rows, and backfill re-derives it under the new fingerprint (SUM-5). Bump `v1` in code whenever `si_normalize_advertiser` itself changes. |
| D5 | Partial backfill fails closed | A run's summary rows and its status record commit in **one** transaction, both at publication and at backfill. A source is eligible for summary-backed reads (`si_summary_coverage`, for M4-P3.2) only if every COMPLETED RETAINED/EMPTY run has a current status and no drift is open. Backfill is bounded (`p_limit` ≤ 1,000) and resumable in deterministic `(source, finished_at, run_id)` order; an interrupted batch rolls back entirely (SUM-4). |
| D6 | Completed-run immutability | Summary rows, status and the drift log are append-only (UPDATE and TRUNCATE are refused for every role, the owner included). DELETE is admitted only for a PURGED run, a STALE status or a source with open drift; an identity only when no summary references it. New: observations can be inserted only while their run is RUNNING (`trg_observation_open_run`). Adding evidence to a completed run (the M4-P3.0.1-ACCEPT-01 owner path) now requires disabling a trigger, which the integrity gate reports. |

### 15.2 Schema (0020; reversible: down restores the exact 0019 catalog, M1t)

- `si.advertiser_identities` `(identity_id, source_id, normalizer, advertiser_key, normalized_name, first_run_id, created_at)`. UNIQUE `(source_id, normalizer, advertiser_key)`, digest CHECK.
- `si.run_advertiser_summaries` `(run_id, source_id, identity_id, network, observations, ad_ids bigint[], names text[])`. PK `(run_id, identity_id, network)`, index `(identity_id)`. Composite FKs to the run and the identity, both on `source_id`, so a summary cannot cross sources. CHECKs: `cardinality(ad_ids) = observations`, no NULL elements.
- `si.run_summary_status` `(run_id PK, source_id, normalizer, observation_count, summary_rows, identities, content_digest, method PUBLICATION|BACKFILL|REBUILD, recorded_at, recorded_by)`.
- `si.summary_events` (append-only): `DRIFT_DETECTED` (with a finding), `DRIFT_CLEARED`, `REBUILT`.
- Functions, all owner-only:
  - `si_summary_content` is the one derivation, used both to write and to verify;
  - `si_summarize_run`, `si_backfill_summaries`, `si_verify_summaries`, `si_rebuild_run_summaries`, `si_summary_coverage`, `si_normalizer_fingerprint`;
  - the guards and triggers.
- `si_complete_run` is the 0005 text with **one** statement added (M1t): `PERFORM si.si_summarize_run(p_run_id, 'PUBLICATION')` before the receipt.

### 15.3 Publication, backfill, verification, purge

- **Publication.** It derives the run's content once, from the observations just inserted: one normalizer call per observation. It then:
  1. inserts the missing identities in digest order, so concurrent publications of one source wait instead of deadlocking;
  2. checks for collisions;
  3. inserts the summaries and the status.

  Any error aborts the whole publication; SUM-2 shows the run stays RUNNING with no evidence. The deferred `trg_runs_summary_check` refuses at commit a run that becomes COMPLETED without a current status covering exactly its observations. Duplicate completions are refused as before (`SI_T2_NOT_OWNER`), with no change to the summaries (SUM-3). Identity lookups are correlated index probes (`LATERAL ... LIMIT 1`, scalar `IS NULL`), so no plan can hash the dictionary: with 100,000 identities, a hash join spilled 541 MB of temporary files during backfill until this was fixed.
- **Backfill** `si_backfill_summaries(p_limit)` takes the sources `FOR SHARE` and the runs `FOR SHARE`, and re-checks each run under the locks. A purge committed before the lock is not resurrected (SUM-7). A purge waits for, or skips (`BUSY`), a source under maintenance.
- **Verification** `si_verify_summaries(source)` recomputes every summarized run from its observations. Comparing them as multisets in both directions, it reports `MISSING`, `CONTENT_MISMATCH`, `STATUS_MISMATCH` (counts or digest), `ORPHAN_IDENTITY` and `IDENTITY_MISMATCH`. Any finding records `DRIFT_DETECTED`, which blocks coverage; a clean verification of a drifted source records `DRIFT_CLEARED`. `si_rebuild_run_summaries` works only while drift is open (SUM-6).
- **Purge** is unchanged. A trigger, running in the purge transaction under its exclusive source lock, deletes the purged run's summaries and status, and the source's identities that no remaining summary references.

  **Dictionary retention policy:** a normalized name is derived evidence content, so an identity lives exactly as long as some retained run's summary references it. It is deleted in the purge transaction of its last run (SUM-7) or with its last stale summary (SUM-5). It is never evidence of readability.
- **Not affected:** verdicts, rights versions, source controls and grants never write summaries. SUM-7 checks that summaries, identities and status are byte-identical across all of them; expiry and readability are evaluated live by readers.
- **Integrity controls (§14.9) still apply.** The gate now also checks the 0020 guard and lifecycle triggers (IG-2: insert guard, summary append-only, purge trigger). FK_AUDIT is unchanged. Summary drift is found by `si_verify_summaries`, not by FK_AUDIT: SUM-6's corruption is FK-consistent.

### 15.4 Tests (`tests/db/m4-summaries.test.mjs`, `tests/db/m4-integrity-gate.test.mjs`)

The reference for every summary is an independent recomputation in JavaScript from the raw observations; only the normalizer is evaluated by the database.

- **SUM-1:** repeated ads, several sources, networks, spellings, an 18,000-character name, an emoji and full-width forms.
- **SUM-2:** digest collision.
- **SUM-3:** rollback, duplicate completion, and 6 × 5 concurrent publications sharing identities.
- **SUM-4:** pre-0020 data. Backfill steps `[3,4] → [3,1] → [1,0]`, an interrupted batch leaves nothing, and search output is identical before and after.
- **SUM-5:** normalizer change.
- **SUM-6:** owner corruption, drift, rebuild and clear, and append-only refusals.
- **SUM-7:** lifecycle invariance, purge, and both lock orders.

Targeted mutants, each killed for its stated reason with the baseline asserted exactly (a fixture failure throws and is never a kill):

| Mutant | Baseline | Mutant |
|---|---|---|
| summary rows missing for one network (self-check intact) | published, equal | publication refused `SI_SUMMARY_INCONSISTENT` |
| same, with self-check and commit check removed | published, equal | published, differs from recomputation; verification `CONTENT_MISMATCH` |
| names stored normalized (shared derivation) | equal | differs from the independent recomputation (verification cannot see it: the reason for the independent reference) |
| observation count + 1 | published | refused by the `cardinality(ad_ids) = observations` CHECK |
| collision check removed | `SI_SUMMARY_IDENTITY_COLLISION` | published under the impostor identity |
| coverage ignores missing runs (incomplete backfill reported complete) | not eligible | eligible |
| backfill records status without rows | `MISSING` | `CONTENT_MISMATCH` |
| purge keeps summaries | 0 summaries, 0 identities | 1, 1 |
| purge keeps the run's identities | 0 identities | 1 |

### 15.5 Performance and storage (`tests/slow/m4-summaries-bench.test.mjs`; local PostgreSQL 16.15 container, fsync off)

**Method.**
- Publications alternate on the same growing source between the 0020 `si_complete_run` (with summaries) and the 0005 text (bench fixture). The runs published without summaries are then backfilled.
- One source per layout; synthetic rows; 2 networks.
- `ids` is the size of the advertiser pool. With 500 observations per run spread over the pool, almost every observation is its own `(run, identity, network)` summary row: the **worst case for storage**. `conc50` concentrates about 5 observations per summary row.

| Layout | Publication p50 with / without summaries | Overhead (p50) | WAL per publication | Summaries + dictionary + status vs observations (incl. indexes, TOAST) | Backfill | Verify (whole source) | Rebuild per run | Purge per run with / without |
|---|---|---|---|---|---|---|---|---|
| 5,000 obs (10 × 500) | 243 / 250 ms | −3% (noise) | 829 / 608 kB | 1.5 / 2.4 MB = **63%** | 5 runs 0.1 s | 0.3 s | 80 ms | 35 ms |
| 50,000 obs | 263 / 252 ms | **5%** | 830 / 612 kB | 11.7 / 23.2 MB = **50.5%** | 50 runs 1.3 s | 2.1 s | 78 ms | 61 / 24 ms |
| 200,000 obs | 274 / 236 ms | **16%** | 832 / 615 kB | 45.1 / 93.0 MB = **48.6%** | 200 runs 4.8 s | 10.8 s | 80 ms | 50 / 39 ms |
| 1,000,000 obs | 301 / 277 ms | **9%** | 841 / 619 kB | 225 / 465 MB = **48.4%** | 1,000 runs 23.4 s | 46.7 s | 76 ms | 54 / 50 ms |
| 10,000 runs × 10 | 24.1 / 22.0 ms | **10%** | 16.8 / 12.6 kB | 24.5 / 44.4 MB = **54.9%** | 5,000 runs 6.6 s | 7.2 s | 3.6 ms | 114 / 107 ms |
| 30,000 runs × 10 | 31.6 / 30.0 ms | **5%** | 16.9 / 12.6 kB | 72.1 / 133.2 MB = **54.1%** | 15,000 runs 25 s | 24.6 s | 4.3 ms | 359 / 311 ms |
| 500 identities (200,000 obs) | 255 / 230 ms | **11%** | 831 / 615 kB | 48.7% | 200 runs 4.0 s | 8.4 s | 69 ms | 32 / 28 ms |
| 100,000 identities (200,000 obs) | 266 / 230 ms | **16%** | 976 / 628 kB | 79.7 / 100.7 MB = **79.2%** (dictionary 30.1 MB) | 200 runs 5.3 s | 9.1 s | 67 ms | 33 / 32 ms |
| concentrated (50 identities) | 210 / 201 ms | **5%** | 662 / 615 kB | 11.1 / 92.9 MB = **12%** | 200 runs 1.6 s | 5.2 s | 19 ms | 28 / 24 ms |

Every layout: 0 bytes of temporary files in build, backfill and verification; collector peak RSS 46–168 MB (it includes shared buffers touched).

**Publication overhead: target ≤ 25% met** (median 5–16%, including 100,000 identities and 1M observations). Write amplification is +35% WAL bytes per publication at one observation per summary row, and +8% when concentrated.

**Storage: target ≤ 35% met only when advertisers concentrate.**
- At one observation per `(run, identity, network)` row the ratio is 48–55%. A 1-element row costs about 230 bytes: tuple header, run id, two arrays with their headers, and two index entries. An observation costs about 470 bytes.
- With 100,000 distinct identities the dictionary adds 30 MB (79%).
- The ratio is therefore a property of the data's concentration, not a defect of the encoding. ≤ 35% needs about 1.6 observations per summary row on average.

Options for M4-P3.2 to decide, measured or estimated from the per-row breakdown; not implemented:
- (a) single-element rows stored without array headers, a scalar `ad_id` with the array only when there are more (about −30% per such row);
- (b) per-source spelling dictionary, with summaries referencing spelling ids instead of raw names;
- (c) the normalizer fingerprint as a small id in the dictionary's unique key (about −20 bytes per identity);
- (d) accept the cost and track it.

**R-37 (reported, not hidden).** The runs layouts published their first 3,000 runs through **one persistent collector session**. Per-500 medians:

| Layout | Per-500 medians (ms per publication) |
|---|---|
| 10,000 runs | 20.5 → 40.4 → 61.7 → 76.5 → 95.1 → 104.2 |
| 30,000 runs | 18.6 → 38.2 → 55.8 → 74.2 → 90.4 → 104.7 |

Afterwards the bench reconnects every 500 runs (14 and 54 reconnections), and the per-run figures above come from that regime. The slowdown pre-dates 0020 (M4-P3.0-ACCEPT-01: generic plans in the write path); summaries do not remove it.

### 15.6 Limitations and risks

1. Storage at low advertiser concentration exceeds the 35% target (§15.5); R-38.
2. Publication of runs with many new identities costs more: +16% at 100,000 identities, plus dictionary growth. The dictionary is per source and is purged with its last run.
3. Summaries are as trustworthy as their evidence. The insert guard and the integrity gate keep completed-run evidence fixed, and `si_verify_summaries` detects divergence, but only when it is run. M4-P3.2 must call `si_summary_coverage`, and verification must be scheduled operationally.
4. An ICU or major-version change makes every summary STALE until backfill re-derives it. Readers must then fall back to the observation path (M4-P3.2).
5. R-37 (write path), R-26, R-28, R-29, R-32 and R-36 remain open. All real-evidence pilot and production NO-GOs remain.

## 15A. M4-P3.1-CLOSE-01: closure of conditions C1–C4 of M4-P3.1-ACCEPT-01 (migration 0021)

**Status:** IMPLEMENTED on branch `claude/b002-m4-p3-1-close-01` from the frozen, accepted candidate `f3f765e` (unchanged: the 0020 files are checksum-pinned by a test), pending independent acceptance. Migration 0021 replaces exactly `si_summary_coverage` and adds two indexes. Summary derivation, identity semantics, publication, backfill, verification, purge, readers, grants and the readability path are unchanged (M1u: only `si_summary_coverage` changes among functions; down 0021 restores the exact 0020 catalog). R-38 compaction and M4-P3.2 readers are not part of this milestone.

### 15.7 C1 — eligibility cost (migration 0021; `tests/slow/m4-coverage-bench.test.mjs`)

**Baseline reproduced.** At 30,000 runs (27,000 in the measured source), the 0020 `si_summary_coverage` took 487–617 ms (first call / p50 / p95: 612 / 501 / 554 ms) on a database without planner statistics. Cause: `si_normalizer_fingerprint()` (a catalog lookup plus the ICU collation version) was evaluated inside the per-run anti-join — CV-2 counts 932 evaluations for one call over 30 runs. With statistics (VACUUM ANALYZE) the planner chose a hash anti-join and 0020 took p95 27.1 ms.

**Change.** The fingerprint is evaluated once per call (plpgsql `DECLARE ... constant`), and the anti-join is a merge of two index-only scans in `run_id` order:
- `collection_runs_summary_eligible (source_id, run_id) WHERE status = 'COMPLETED' AND retention_state IN ('RETAINED', 'EMPTY')`;
- `run_summary_status_by_source (source_id, normalizer, run_id)`.

The status side is restricted to the source; a status row's `source_id` equals its run's (composite FK `run_summary_status_run`), so the result is unchanged. The merge plan is pinned by function settings (`enable_hashjoin`, `enable_nestloop`, `enable_sort` off), independent of statistics. Nothing is cached: no table, counter or stored decision; drift, completeness and the fingerprint stay live.

**Equivalence.** CV-1 installs the 0020 text next to 0021 and compares them on 280 states per seed (seeds 20261116, 7, 99), including each reason alone on an otherwise eligible source: missing status, status alone missing (rows kept), stale fingerprint (one run, a whole source), open and cleared drift (forged and real), purged, EMPTY and RUNNING runs, a source without runs. All four outcomes are reached (eligible, DRIFT, INCOMPLETE, both); 0 differences.

**Result at 30,000 runs (two independent builds; p95 over 20 calls; local PostgreSQL 16.15, fsync off, 4 vCPU):**

| State | 0020 first / p50 / p95 | 0021 first / p50 / p95 | Target p95 ≤ 10 ms |
|---|---|---|---|
| COLD (never analyzed, new connection) | 612 / 501 / 554 ms; 506 / 506 / 649 ms | 42.3 / 27.2 / 29.2 ms; 39.3 / 26.4 / 33.1 ms | **NOT MET** |
| WARM (VACUUM ANALYZE) | 46.0 / 21.4 / 27.1 ms; 27.0 / 21.2 / 27.0 ms | 15.1 / 9.1 / 10.2 ms; 16.1 / 8.8 / 11.4 ms | **NOT MET** (marginal) |

Plans: COLD, Merge Anti Join over two Index Only Scans with heap fetches (no visibility map yet), 54,417 buffer hits, 34.7 ms; WARM, 0 heap fetches, 463 buffer hits, 13.0 ms.

**Architectural trade-off (target not met; the gate is not weakened).** An exact completeness check must compare every eligible run of the source with its status: it is O(runs of the source). At 27,000 runs the floor is two ordered scans of 27,000 index tuples (about 9–13 ms warm, 27–35 ms cold). The options for M4-P3.2 to decide, none implemented:
1. Keep the exact live check (0021) and call it once per request, not per statement; accept ~10 ms warm / ~30 ms cold at 30,000 runs.
2. A transactionally maintained per-source counter of eligible runs without a current status, written by triggers on runs and status. O(1), but it is a stored, owner-mutable decision whose own correctness would need verification and gate coverage; under contract B (§15.8) it adds no protection against the owner. Not adopted.
3. Partition the check by time (only runs in the requested period). Changes the eligibility contract; a design decision for M4-P3.2.
4. Change the target, which is a decision for the acceptance authority, not this milestone.

### 15.8 C3 — owner trust boundary (contract B)

**Reproduced.** As `si_owner` only — no superuser, no trigger disabled — the sequence works:
1. insert `DRIFT_DETECTED` into `summary_events`, which makes the guard admit DELETE;
2. delete or insert summary rows;
3. insert `DRIFT_CLEARED`.

Afterwards eligibility is `eligible` and the catalog gate passes; only `si_verify_summaries` reports the change (TB-1). Summary INSERT is not guarded (append-only means no UPDATE, DELETE or TRUNCATE).

**Contract B: the database owner is trusted.** `si_owner` (the identity `si_migrator` assumes) owns every table, function and trigger and can always rewrite data and any stored digest together. A verification digest kept in the same owner-controlled database would not protect against a malicious owner and is therefore not introduced. The guarantees are:
- **Ordinary roles** (`si_collector`, `si_monitor`, `si_retention`, `si_rights_admin`, readers): no privilege on the summary tables, the drift log or the summary functions (TB-1, privileges SD1, gate `TABLE_PRIVILEGES` / `FUNCTION_PRIVILEGES` / `PUBLIC_EXECUTE`). They cannot forge drift, write summaries or call eligibility, verification, rebuild or backfill.
- **The owner** can tamper without disabling a trigger. Eligibility and the gate cannot detect it. **`db/ops/verify-summaries.sql` can**: it recomputes every summarized run of every source from the authoritative observations and lists each finding; a finding records `DRIFT_DETECTED`, which makes the source ineligible.

**Mandatory verification.** `db/ops/verify-summaries.sql` (PASS = zero rows) must run:
- at deployment verification;
- in DR-1 after a restore (added to `tests/restore/clean-cluster.sh`);
- after any privileged operation on evidence or summary tables;
- on a schedule.

**Time of check / time of use.** A clean verification proves the summaries matched the evidence at that moment only. TB-1 shows that tampering after a clean verification is invisible to eligibility until the next verification. M4-P3.2 must not present eligibility as proof of integrity.

**DR-1 limitation.** DR-1 dumps the template database, which holds no evidence. Its verification step proves the script runs on a restored cluster; detection on data is proved by TB-1, CV-1 and CC-MX7, which DR-1 also runs against databases of the restored cluster.

Real-evidence pilot and production remain NO-GO.

### 15.9 C2 and C4 — mutation coverage and the integrity gate

**C2.** `tests/db/m4-summaries-close.test.mjs` adds a deterministic control per previously surviving mutant. Each control runs its scenario once on the installed functions (exact baseline outcome, with its preconditions asserted) and once with the function mutated (exact defect); a fixture failure throws and is never a kill.

| Control | Scenario | Baseline | Mutant |
|---|---|---|---|
| CC-MX5 | owner completes a RUNNING run with a receipt but no summary | refused by the summary check (a control with a summary commits) | commits |
| CC-MX13 | owner completes a run whose status counts 2 of 3 observations | refused by the summary check | commits |
| CC-MX4 | fabricated extra summary row, status forged to agree | `CONTENT_MISMATCH` (no `STATUS_MISMATCH` masks it) | clean |
| CC-MX12 | orphan identity | `ORPHAN_IDENTITY` | clean |
| CC-MX7 | an unbackfilled (pre-0020) run is purged while backfill waits for the source lock (wait asserted) | purged run has no status | status resurrected |
| CC-MX8 | fingerprint vs an independent computation | exact | differs |

- **MX4 is not redundant.** Without the stored-minus-content direction, an extra row with a consistent forged status is not detected.
- **SUM-7 clarification.** Its part (2) never exercised the race, because its run was already summarized. It now says so; CC-MX7 is the race.
- **MX10 is equivalent.** Removing `ORDER BY u.advertiser_key` from the identity insert changes nothing, because in PostgreSQL 16 `DISTINCT ON (u.advertiser_key)` over a function scan is implemented by Sort + Unique on the digest, so rows are inserted in digest order either way. A future plan that implements DISTINCT ON differently would invalidate this; the campaign then reports `KILLED (equivalence claim WRONG)`.

`tests/mutations/m4-p31-close.mjs` (CI step) applies MX1–MX17 to the migration files:
- MX1–MX15 are those of M4-P3.1-ACCEPT-01;
- MX16 re-introduces the per-run fingerprint;
- MX17 accepts a status under any fingerprint.

For each mutant it rebuilds the template and requires its named detector test to fail with an assertion. It restores the files byte for byte after each mutant and requires a green restored baseline. MX10 must survive.

**C4.** `db/ops/integrity-gate.sql` now also checks:
- **Foreign keys:** the five 0020 FKs (presence, definition, validation, the 4 enforcement triggers, NOT NULL columns, referenced unique key).
- **Keys and CHECKs:** the 22 primary, unique and CHECK constraints of the summary tables (name, SHA-256 of the definition, validation, unique index valid).
- **Triggers:** the 18 immutability and lifecycle triggers — enabled, and SHA-256 of `pg_get_triggerdef` (WHEN clause, timing, deferral, function).
- **Functions:** 16 security-critical functions — SHA-256 of the body (`prosrc`, as written in the migration), SECURITY DEFINER flag, volatility, settings, owner and exact ACL. These are the 8 immutability and lifecycle trigger functions, the eligibility function and everything eligibility and verification evaluate.
- **Tables:** owner and exact effective ACL of the evidence and summary tables. A NULL ACL is compared as `acldefault()`: pg_restore leaves owner-only tables with a NULL ACL. DR-1 found this in the first version of the gate: six false TABLE_PRIVILEGES reports on the restored cluster, fixed, and IG-2 now has a case for it.
- **Every SECURITY DEFINER function in `si`:** owner `si_owner` and the pinned search path.
- **PUBLIC:** no `si` function executable by PUBLIC.

IG-0 recomputes the 16 function pins from the migration files. IG-2 adds 23 deliberate breaks, each reported exactly, plus one non-break (a restored NULL ACL, not reported). Among the breaks:
- dropped, NOT VALID or narrowed FKs, and a disabled FK enforcement trigger;
- a dropped, weakened or NOT VALID CHECK;
- a disabled or redefined trigger;
- replaced bodies of the guard, the insert guard, eligibility, verification and the fingerprint;
- a changed SECURITY DEFINER search path;
- table and function grants, a PUBLIC grant, ownership changes.

A clean gate says the definitions are in force now. It is not proof that data written before, or by the trusted owner, is correct: that is `fk-audit.sql` for evidence and `verify-summaries.sql` for summaries.

**Finding recorded, not changed (outside the summary contract):** when a run's status row alone is missing and its summary rows remain, backfill fails the whole batch on the summary primary key (fail closed; CV-1 counts it). The run stays INCOMPLETE until verification records the drift and `si_rebuild_run_summaries` re-derives it (R-40).

## 15B. M4-P3.1-CLOSE-02: CI reliability diagnosis (CI #140) and the revised C1 contract

**Status:** branch `claude/b002-m4-p3-1-close-02` from `12b7eb3` (CLOSE-01, unchanged), pending independent acceptance. No production SQL changes: tests, documentation, risk register.

### 15.10 CI #140 reconstruction

| Attempt | Integration pass 1 | Integration pass 2 | Other jobs |
|---|---|---|---|
| 1 | 472/472 | R35-M failed | all green |
| 2 | RT-13 failed (SUSPEND max-batch purge 5,908 ms > 5,000) | — | all green |
| 3 | 472/472 | R35-M failed | all green |

- Pass 1's WAL positions are byte-identical between CI and local runs (R35-M old page layout 0/1351C018), so the suite is deterministic up to background activity.
- Both R35-M failures were the same observation: the old-target mutant's first boundary case (0/AD522018) was released after 31 ms and 75 ms; the other six cases were refused after the 1 s wait.
- The CI server log shows no timed or WAL checkpoint near either failure.

### 15.11 R35-M — test-oracle defect (classification: test oracle; not a product defect)

**Mutation contract.** The pre-0017 gate captures `target = pg_current_wal_insert_lsn()`. At a verified page boundary that is boundary + 24, past the flush pointer (the boundary), and it is reachable only if more WAL is inserted after the boundary and flushed during the wait. Without such WAL the old gate must refuse after its 1 s wait.

**Defect.** Any WAL inserted after the boundary and flushed during the wait releases the old gate legitimately, and says nothing about the gate. Measured sources (local evidence with `pg_walinspect`):
- autovacuum (`Heap2/PRUNE`, `Btree/VACUUM`, xid 0);
- heap pruning;
- another backend's commit;
- the background writer's `Standby/RUNNING_XACTS` (reproduced with `pg_log_standby_snapshot()`).

The test told such releases apart from escapes by elapsed time (void only after ≥ 100 ms). A foreign record flushed quickly releases in under 100 ms. That is CI's 31 / 75 ms, and R35-V1 reproduces it deterministically: a foreign synchronous commit 15 ms into the wait releases at a verified boundary after 27 ms.

**Correction (test only).**
- R35-M runs observed copies of the old gate that differ by exactly one NOTICE after the wait loop, reporting the gate's own `target` and flush at release (R35-0 asserts byte-identity otherwise).
- A release is classified by that evidence:
  - flush ≥ target → **VOID**: rebuilt, at most 5 times, each void logged with the WAL records found after the boundary;
  - flush < target → **ESCAPE**: counted, and the test fails.
- The fixture removes dead intents before each layout (`VACUUM si.read_intents`) and calls the replaced gate once before any layout, so the reader's own pruning is not a void source.
- Every boundary case must end REFUSED; if voids are exhausted the test **fails** — it is never turned into a pass.

**Controls.**
- R35-V1 (positive): foreign commit → VOID, where the old elapsed-time rule would have counted an escape.
- R35-V2 (negative): a gate whose wait is removed releases with flush < target → ESCAPE.

**Adversarial repetition.**
- Quiet: 10/10 pass (0–1 voids per run; sources autovacuum, pruning, other transactions).
- Continuous foreign commits every 40 ms: 10/10 **fail** (voids exhausted). The mutant cannot be observed under continuous foreign WAL, and the oracle refuses to call it killed.

The durability invariant and the 0017 gate are unchanged.

### 15.12 RT-13 — root cause found; the timing requirement is NOT relaxed (classification: product performance, pre-existing; R-28)

The bound is the M3 design gate M3-T14: source-lock hold median ≤ 2 s and p95 ≤ 5 s, SUSPEND wait p95 ≤ 5 s, against a maximum purge batch (20 runs, 10,000 observations). It is a resource-budget requirement for emergency controls, not a correctness deadline. RT-13 checks it with one sample per control.

Measurements:
- **Wait events:** the purge backend is CPU-bound in both modes. No lock waits, no checkpoints, no full-page writes.
- **Bimodal by statistics:** ≈ 0.5 s when `si.observations` has been analyzed before the purge, and ≈ 2.9–3.3 s when it has never been analyzed. `ANALYZE si.observations` alone moves a cold run from 3.3 s to 0.6 s.
- **Slow statement:** the purge's `DELETE FROM si.ads` takes 2.5–2.6 s, of which the delete itself is 127 ms. The rest is the per-row `ON DELETE RESTRICT` enforcement of `observations_ad`: 10,000 lookups of `si.observations`, planned without statistics.
- **Why it is nondeterministic:** whether autoanalyze has run when the purge starts depends on the autovacuum schedule. On slower hosts the cold mode reaches 5.9–10.1 s (CI #140, local CLOSE-01, M4-P2.2: 8.2 s).
- **Not caused by 0020/0021:** 0020 and 0021 show the same two modes (16 interleaved runs).

This is a real exposure: a purge right after a bulk load, before autoanalyze, holds the source lock several times longer, and emergency controls wait for it. Fixing it changes the retention write path (for example, an index or statement form whose plan does not depend on statistics, or an explicit ANALYZE step after bulk ingestion). That is outside this closure's authorization. RT-13 and its 5 s assertion are unchanged; the decision is requested (R-28).

### 15.13 C1 — revised contract (approved thresholds)

At 30,000 runs, with 27,000 in the measured source, the single-source synthetic workload of §15.7, 20 calls:

| | Warm p95 (≤ 15 ms) | Cold p95 (≤ 40 ms) |
|---|---|---|
| Local builds 1 / 2 | 10.2 / 11.4 ms | 29.2 / 33.1 ms |
| Hosted CI #140 | 6.85 ms | 17.1 ms |

- One fingerprint evaluation per call (CV-2, MX16).
- The original 10 ms target is still reported: not met locally, met warm on CI.
- `tests/slow/m4-coverage-bench.test.mjs` asserts the revised limits.

**Reader budget.** The M4-P3.0 reader targets are p95 ≤ 100 ms at 10,000 runs and ≤ 400 ms at 30,000 runs. Eligibility at ≤ 40 ms cold is ≤ 10% of the 30,000-run budget, provided M4-P3.2 calls it once per request. Called per page or per statement it would consume the budget.

## 15C. M4-P3.1-RT13-01: emergency-purge latency fixed at its root (migration 0022)

**Status:** branch `claude/b002-m4-p3-1-rt13-01` from `90d6c46` (CLOSE-02, unchanged), pending independent acceptance. Production SQL: one index (migration 0022). The RT-13 assertion and its 5 s bound (M3-T14) are unchanged.

### 15.14 Root cause (R-28)

Each identity deleted by `si_purge_due` fires the `ON DELETE RESTRICT` check of `observations_ad`, once per deleted row. The check is this query:

```sql
SELECT 1 FROM ONLY si.observations x
 WHERE ad_id = $1 AND source_id = $2 AND network = $3 AND native_ad_id = $4
   FOR KEY SHARE OF x
```

No index covered those columns.

| Statistics on `si.observations` | Plan of the check | Index tuples read per lookup | Cost per batch |
|---|---|---|---|
| Present (analyzed, or stale from one run) | Index scan of `observations_by_ad` (0006) | 1 to 3 buffers | Linear |
| Absent (never analyzed: `reltuples` 0 from the vacuumed template, no `pg_stats` rows) | `BitmapAnd` of `observations_by_ad` and `observations_by_source_advertiser_key` (0015, leading `source_id`) | Every index entry of the source (10,000 for a maximum batch) | Quadratic |

Evidence, cold maximum batch (20 runs × 500 identities), purge transaction's own counters (`pg_stat_get_xact_tuples_returned`):

| Schema | Index tuples read | Of which `observations_by_source_advertiser_key` | Purge |
|---|---|---|---|
| 0021 | 100,040,000 | 100,000,000 (10,000 × 10,000) | 2.7–3.4 s local, 6.2–6.3 s on 1 CPU |
| 0021 without the 0015 index | 40,000 | 0 | 0.39–0.41 s |
| 0022 | 40,000 | 0 | 0.39–0.50 s |

- **Where the time goes:** the FK trigger `observations_ad` took 2,728 ms over 10,000 calls. The statement `DELETE FROM si.ads` took 2,857 ms. Deleting the observations took 142 ms.
- **Wait events:** the purge backend is CPU-bound. Lock-wait samples during the purge were 0 / 3,344 broken and 0 / 961 fixed.
- **Why the bimodality:** autovacuum timing decides whether `si.observations` was analyzed before the purge. The cost also grows with the size of the source, not only with the batch: a larger real source would scale it further.
- **What RT-13 measures:** both. Its `purgeMs` is the physical purge. Its `waitMs` is the SUSPEND / TERMINATE wait, which equals the time the purge still holds the source lock (FOR NO KEY UPDATE). The control's own work is negligible.

### 15.15 Design (migration 0022)

```sql
CREATE INDEX observations_by_ad_fk ON si.observations (ad_id, source_id, network, native_ad_id);
```

The index key is exactly the FK key, in the FK's order. Every qual of the check becomes an index condition of one btree. Under any statistics the lookup reads its own entries only, and no cheaper alternative remains.

Unchanged by 0022:
- functions, triggers, constraints (the FK, its RESTRICT action and its validation);
- privileges and lock order;
- audit, publication and summaries;
- the readers;
- `observations_by_ad`, which is kept so the readers' plans are not touched.

Down drops the index and restores the exact 0021 catalog (M1v).

Rejected alternatives:

| Alternative | Why rejected |
|---|---|
| ANALYZE (in the purge or after ingestion) | Does not hold for a stale, partial or reset set of statistics. Inside the purge it costs O(table) and takes a lock. |
| Planner GUCs on `si_purge_due` (e.g. `enable_bitmapscan = off`) | RI plans are cached per backend, independently of the function's settings. A plain index scan of the `source_id` index would still be possible. Fragile. |
| An index on `ad_id` alone | Measured as RTX2: the cold plan still ANDs the `source_id` index, and reads 1e8 tuples. |
| Dropping or reshaping `observations_by_source_advertiser_key` | Changes the readers' plans (search). Out of scope. |
| Deferring the FK, or deleting identities later | Changes the FK or the atomicity of the purge. |
| Re-ordering the deletes | The order is fixed by the FK (observations first). |

**Cost.** One more btree is maintained on every observation insert (native ids of up to 256 bytes). It is about 52 bytes per observation for the synthetic ids: 504 KiB per 10,000 rows, against `observations_by_ad` at 240 KiB and the heap at 11.2 MB. Ingesting 10,000 observations (20 runs × 500, 1 CPU, 3 runs each) took 5.82–6.27 s with the index and 5.69–6.40 s without, which is within noise. `observations_by_ad` becomes a strict prefix of the new index; dropping it later is a separate decision (R-42). The index is created non-concurrently: on a large table, applying 0022 blocks writes to `si.observations` for the duration of the build (R-42).

### 15.16 Tests

`tests/db/m4-rt13-purge-fk.test.mjs` is in the DB suite. Autovacuum is disabled on the `si` tables of each test database, so the statistics mode is deterministic and asserted as a precondition.

| Test | What it checks |
|---|---|
| PF-0 | The supporting index exists: valid, ready, btree, non-partial, key = FK key. The FK definition is unchanged. |
| PF-1 cold / warm / stale | Maximum batch. Index tuples read are ≤ 5 per deleted row (structural, size-independent detector). Purge ≤ 5 s. A bystander source with the same native ids is byte-identical afterwards. Evidence and FK invariants hold (no dangling observation, no orphan identity, no purged run with evidence or without audit, every FK validated). |
| PF-B (in-suite deliberate break) | Drops the index. Asserts that the defect is reproduced (≥ 5e7 reads of the `source_id` index) and that the PF-1 detector fails on it. |
| PF-2 (rollback) | A rolled-back maximum purge leaves evidence, identities, run states and audit identical. A retry purges. |
| PF-3 (partial failure) | Fault injected at the audit insert, after the identities are deleted. The whole purge aborts. Then a clean retry. |
| PF-4 (contention) | Two concurrent cold maximum purges of different sources, SUSPEND and TERMINATE_RETENTION issued during them, and a collector on a third source. Purges never block each other. A control waits only for the purge of its own source. The collector is not blocked. |

Other checks:
- **File-level deliberate break:** `tests/mutations/m4-rt13-purge-fk.mjs`. RTX1 (no index) and RTX2 (`ad_id` only) are each killed by PF-1 (cold); the file is restored byte for byte.
- **Contention benchmark:** `tests/slow/m4-rt13-purge-bench.test.mjs`. p50/p95 of the purge and of the control wait over 10 iterations per statistics mode, with a collector running. Asserts p95 ≤ 5 s. With `SI_RT13_BROKEN=1` it gives report-only "before" numbers.
- **CI:** job `purge-latency`.

### 15.17 Measurements (local PostgreSQL 16.15 container, fsync off)

On a 1-CPU-limited container, 10 iterations per mode (broken: 6), each with a concurrent collector:

| Mode | Purge p50 / p95 | Control wait p50 / p95 | Index tuples read per purge |
|---|---|---|---|
| Cold, 0021 (before) | 6,180 / 6,326 ms | 6,339 / 6,483 ms | 100,040,000 |
| Cold, 0022 | 830 / 1,013 ms | 997 / 1,248 ms | 40,000 |
| Warm, 0021 (before) | 771 / 1,000 ms | 991 / 1,171 ms | 30,002 |
| Warm, 0022 | 859 / 968 ms | 1,033 / 1,136 ms | 30,002 |

Warm is unchanged within noise. The cold defect no longer reproduces.

On the full 4-CPU host, 10 iterations per mode (broken: 5), each with a concurrent collector, at `79d722f`:

| Mode | Purge p50 / p95 | Control wait p50 / p95 | Index tuples read per purge |
|---|---|---|---|
| Cold, 0021 (before) | 2,855 / 2,875 ms | 2,913 / 2,975 ms | 100,040,000 |
| Cold, 0022 | 418 / 487 ms | 483 / 577 ms | 40,000 |
| Warm, 0021 (before) | 459 / 531 ms | 525 / 662 ms | 30,002 |
| Warm, 0022 | 445 / 578 ms | 518 / 646 ms | 30,002 |

External lock contention, measured separately from execution:
- The purge backend was in a lock wait in 0 of 834 / 919 samples (fixed) and 0 of 2,290 (broken).
- Each control waited only for the purge holding its own source (PF-4).
- Purges of different sources never blocked each other. A collector on another source was never blocked.

RT-13 itself, unchanged, at `79d722f`:

| Run | Maximum purge | Control wait |
|---|---|---|
| Three suite passes | 500–618 ms | 471–587 ms |
| 29 targeted runs | 487–792 ms | 465–762 ms |

**One targeted run failed** (1 of 30) before its timing line was printed, so it was not a timing assertion. The server logged no error. The failure message was not captured (filtered output). The 20 reruns with full output all passed. A pre-existing barrier race is the candidate (R-44).

**Write path and other contracts.** One run of `m4-coverage-bench` measured warm p95 15.79 ms against the 15 ms C1 contract (p50 14.56 ms; the earlier 90d6c46 run measured 8.63 / 9.67 ms) with the same plan and buffers. Eligibility does not read `si.observations`. On one 30,000-run database, alternating with and without the 0022 index (3 rounds each):

| Phase | With the index | Without the index |
|---|---|---|
| Warm p95 | 9.67 / 9.96 / 13.52 ms | 9.77 / 9.81 / 10.01 ms |
| Warm p50 | 8.69–8.88 ms | 8.48–8.56 ms |
| Cold p95 | 25.6–30.0 ms | 24.3–39.3 ms |

After a container restart (new host), the coverage bench missed the C1 limits again, and so did the baseline:

| Commit | Cold p95 | Result |
|---|---|---|
| `79d722f` (with 0022) | 40.13 ms | NOT MET |
| `90d6c46` (control, no 0022) | 43.63 ms | NOT MET |

The C1 margin is a property of the host and pre-existing (R-39), not an effect of 0022. Hosted CI measured 6.85 / 17.1 ms (CI #140). The limits are not relaxed.

