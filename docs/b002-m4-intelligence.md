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
| Search source lock omitted | Instrumented pause after the availability check; SUSPEND issued during the pause | `search:ok:1,suspend` (the control waits) | `suspend,search:ok:0` (the page, checked available, silently releases nothing) |
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
