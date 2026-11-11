# B-002 M4-P1 — synthetic advertiser intelligence (architecture, product contract and first vertical slice)

**Status:** IMPLEMENTED on branch `claude/b002-m4-p1` from accepted baseline `d3726d6`, pending founder acceptance.

**Data:** synthetic only. No real advertising source, no customer display, export or mirroring, and no LLM.

**Decision:** the BD1 amendment for the new reader function is recorded as **FD20 (PROPOSED)** in `docs/b002-m3-design.md` §2.1.

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
   │  scanEvidence(source)   ──► readEvidence ──► si_begin_read + si_read_evidence   (one request intent per page)
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

## 3. Product contract

All three capabilities work **per explicitly named source**. Each source is authorized separately by the database. One unauthorized source fails the whole request: there are no partial results. Results are **never merged across sources**: an advertiser identity is the *normalized name within one source*, because no authorization or evidence supports cross-source identity resolution.

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
| Emergency controls | SUSPEND and TERMINATE stop evidence pages and status immediately; LIFT restores | INT-5/6; demo X1; db mutant "availability omitted" |
| D8/G3, retention | INVALID, UNVERIFIABLE, pending and expired evidence never readable; counted in status | INT-7/8/9; db mutant "latest verified not restricted" |
| Durability gate | Status refuses an unflushed intent (`INTENT_NOT_DURABLE`) and asynchronous sessions | INT-19 |
| Scope separation | Status intent → evidence read `BAD_CURSOR`; page intent → status `INTENT_INVALID`; other period → `INTENT_INVALID` | INT-17; db mutant "intent claim omitted" |
| Grants | Revocation between intent and status is enforced (begin_read also checks grants) | db mutant "grant omitted" |
| Caller rollback | Inside a caller transaction nothing is released (`INTENT_UNCOMMITTED`) | INT-17 |

The status function exposes **content-free collection metadata**: counts and timestamps of runs and verdicts. This is new information for readers. It is limited to a source they are granted, while that source is available, and it is audited like evidence. FD20 asks the founder to approve this.

## 5. Tests and negative controls

`tests/db/m4-intelligence.test.mjs` contains INT-1 to INT-18, covering the 18 required behaviours. INT-19, the durability and session gate on status, uses the `wal_writer_delay` fixture, so it runs in the isolated durability CI step (`tests/crash/m4-status-durability.test.mjs`). The mutant scenarios' raw calls use the library's bounded fresh-intent retry on `INTENT_NOT_DURABLE`:

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

**Mutants (each detected; each baseline clean):**
- **Database (status function):** grant check omitted; availability check omitted; latest verified evidence not restricted to readable runs; intent claim omitted.
- **Library (temporary mutated copy):** distinct ads counted as observations; period end inclusive; search merges sources; history identity by substring.

Migration M1k checks that down 0011 restores the exact 0010 catalog and that `si_read_evidence` is untouched.

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
- a suspension that immediately blocks reads (`SOURCE_UNAVAILABLE`).

Every output is labelled *SYNTHETIC DATA — not live market conditions*. In CI it runs on the lifecycle-demo matrix run 1.

## 7. Known limitations

1. **The scan is client-side.** History and search page through every readable record of a source: O(records), at most 5,000 per source, then `SCAN_LIMIT`. Server-side search needs a new, separately authorized read primitive with the query in the audited scope.
2. **Advertiser identity** is the exact normalized name within one source. There is no fuzzy matching, no entity resolution and no cross-source identity; renames and look-alike names are separate identities.
3. **Sub-millisecond boundaries.** Periods and the library's period filter use milliseconds, while the database stores microseconds. A run within the same millisecond as a boundary can be classified differently by history (ms) and status (µs).
4. **Snapshot consistency.** Each page and each status call is its own request and snapshot, so a scan is consistent per page, not across pages. New runs appear at the end (INT-16).
5. **Status exposes collection metadata** to granted readers (FD20). It includes runs that have no readable evidence (INVALID, UNVERIFIABLE, pending, purged), as counts only.
6. **Fail-closed refusals.** `INTENT_NOT_DURABLE` can occur when unrelated unflushed WAL exists, for example catalog pruning after provisioning. The library retries with a fresh intent, at most 3 attempts.
7. **Inherited limits are unchanged:** no disclosure audit (release records are not rollback-resistant), no exactly-once delivery, no restored-copy binding, and the durability conditions (fsync, primary, no failover).
8. **Not production.** Synthetic data only; D5b, D7 enforcement, hosting and independent review are still required.

## 8. Recommended next increment

**M4-P2: server-side, audited advertiser search for one source.** A new read primitive would carry the normalized query and the period **in the audited intent scope**. It would return bounded, keyset-paginated advertiser aggregates computed in SQL under the same gate and source lock. This:
- removes the O(records) client scan and the 5,000-record cap;
- keeps one committed request record per search page;
- is independently testable by reusing the INT suite as an equivalence oracle (server results must equal the client-side computation).

Cross-source views should wait for an explicit cross-source authorization decision.
