# DEMO-V1: first working product interface (local, synthetic)

**Status:** IMPLEMENTED on branch `claude/demo-v1-01` from `54cf5d4` (M4-P3.2-CLOSE-01). Local synthetic development only.

| Release boundary | Status |
|---|---|
| Synthetic local development | GO |
| Real-evidence pilot | **NO-GO** |
| Production | **NO-GO** |

**Not changed:** migrations, SQL, authorization, durability, audit, retention, the readers and the rights model. No migration was added or edited, and no role or privilege changed.

## 1. Repository inspection (Phase 1)

| Capability | Existing implementation | Role that may call it |
|---|---|---|
| Collection: preflight (T1) | `t1PreflightScoped` → `si_begin_run_scoped` | `si_collector` |
| Validation and publication (T2) | `completeRunWithEvidence` → `si_complete_run(run, lease, rows)`. Validates, deduplicates and publishes; writes summaries (0020) and the receipt | `si_collector` |
| Receipt verification | `verifyReceipts` → `si_verify_receipts`; status via `si_verification_status` | `si_monitor` |
| Source controls | `si_record_source_control` (SUSPEND / LIFT / TERMINATE_RETENTION) | `si_rights_admin` |
| Reader grants and rights | `si_grant_reader`, `si_record_rights_version` | `si_rights_admin` |
| Availability | `sourceAvailability` → `si_read_source_availability` | dedicated `si_reader_*` principal |
| Source status | `sourceStatus` → `si_read_source_status` | reader principal |
| Evidence pages | `scanEvidence` / `readEvidence` → `si_read_evidence` | reader principal |
| Advertiser search | `searchAdvertisers` → `si_search_advertisers`, summary-backed since 0023 (M4-P3.2) | reader principal |
| Advertiser history | `advertiserHistory` → `si_advertiser_history`: observation-backed, keyset pages ≤ 100, ≤ 5,000 observations | reader principal |
| Run and source metadata | SELECT on `si.sources`, `si.source_controls`, `si.collection_runs`, `si.publication_receipts` | `si_collector` (existing grants) |

Before DEMO-V1 the repository had **no HTTP API and no frontend**.

**Request limits, enforced by the library and the database:**
- search: up to 10 sources and 50 results per page; the query is ≤ 300 characters and non-empty after normalization; the period is ≤ 366 days;
- history: up to 5,000 observations (SCAN_LIMIT), pages of 100, at most 262,144 bytes per page;
- every read is a committed, audited request intent.

**Source registration:** there is no function for it. Sources are registered as `si_owner`, exactly as the existing demonstrations and tests do it.

## 2. Plan and architecture (Phase 4)

The smallest architecture that exposes the existing capabilities safely: one Node process, no framework, no new dependency.

```
browser (static HTML/CSS/JS, strict CSP)
   │ JSON over http://127.0.0.1 only
   ▼
app/server/server.ts   node:http; validation; CSRF token; Host/Origin checks; fixed error codes
app/server/service.ts  existing library calls only, each under the least-privileged existing role
   │ four pg pools: analyst (si_reader principal), si_collector, si_monitor, si_rights_admin
   ▼
PostgreSQL 16.15 (disposable container), migrations 0001–0023 unchanged
```

**Files:**
- `app/server/dataset.ts`: the synthetic dataset and the operator scenario catalog.
- `app/server/seed.ts`: setup and seeding through the real pipeline.
- `app/server/service.ts`, `app/server/server.ts`, `app/server/main.ts`.
- `app/public/{index.html, app.css, app.js}`.
- `demo/app.sh`.
- `tests/app/demo-app.test.mjs`.

**Why the app is outside `src/`:** `src/` is guarded offline-only by `tests/offline-guard.mjs`: no HTTP and no `pg` outside `src/persistence/`. The interface is therefore a separate TypeScript project, `app/server/` with `tsconfig.app.json`, compiled to `app/dist/` by `npm run build:app`. It consumes the persistence library through its built declarations (`dist/persistence/*.d.ts`). The guard is unchanged.

**Design choices:**
- **Search** is `searchAdvertisers`, the M4-P3.2 summary-backed search; there is no other implementation. Before the first page, the service asks each source's availability (`si_read_source_availability`). It searches only the available ones and lists the others with the database's reason code. Cursor pages reuse the exact source list of the first page, and the library refuses any change (`AVAILABILITY_CHANGED`, `BAD_CURSOR`).
- **History** is `advertiserHistory`, which is observation-backed and keeps its consistency checks. The interface pages the returned list for reading only. The per-ad table and the timeline are groupings of the returned observations.
- **Overview counts** come from `scanEvidence`: the audited evidence pages the reader may read, bounded at 5,000 records per source and failing closed above that. Run counts come from the collector's existing view of `si.collection_runs`, and verdict counts from `si_read_source_status` and `si_verification_status`.
- **Operations** run a fixed, server-side catalog of synthetic scenarios: the browser never sends evidence rows. Each result is read back from `si.collection_runs` after the action. A database refusal is shown as such, never as success.
- **Source controls** in the interface are SUSPEND and LIFT only, through `si_record_source_control`. LIFT uses the compare-and-set view (latest rights version, latest control sequence), exactly as `demo/lifecycle.mjs` does.

## 3. Governance boundary

The rights model keeps `subscriber_display`, `export` and `media_mirror` DENIED by constraint, and the reader grant purpose is `INTERNAL_SYNTHETIC_EVALUATION` (FD16).

DEMO-V1 is an **internal, local evaluation interface on synthetic data**. It is not customer display: loopback only, one local operator, no end-user authentication, no export.

**Source URLs** are synthetic `example.org` addresses that the history reader already returns. They are shown as plain text and are never fetched or linked. Destination and creative URLs are not returned by the readers and are not shown.

**Customer display stays unauthorized.** It still needs everything listed in design §14.8:
- a founder and legal decision;
- a rights change;
- a display purpose and grant;
- a field review;
- end-user authentication.

## 4. Synthetic dataset (Phase 3)

| Source | Networks | Analyst grant | Planned runs |
|---|---|---|---|
| `demo-market-alpha` | GOOGLE, META, TIKTOK | yes | 4 with evidence, 1 EMPTY, 1 FAILED (`INVALID_COUNTRIES`). Northwind ad `nw-1` repeats in 4 runs. Harbor Grove stops after run 2; Lumen Home starts in run 3 |
| `demo-market-beta` | META, PINTEREST | yes | 2 runs. A Northwind Outfitters here is a separate identity from Alpha's (no cross-source merge) |
| `demo-market-gamma` | GOOGLE | yes | 1 EMPTY run: an available source with no evidence |
| `demo-market-delta` | META | **no** | 1 run with evidence; reads are refused `NOT_AUTHORIZED` |

- **Repeatable:** the dataset is content-deterministic, and test APP-10 checks this. Run ids and collection times are the database's own values. Source-reported dates (`seenAt`) are historical, Aug–Nov 2026.
- **No time shift:** the collection timestamps are all from seeding time. Unlike `demo/intelligence.mjs`, no time-shift fixture is used.
- **The `synthetic-fixture` source** is created by an existing migration. It appears in the catalog and is not granted to the analyst.

## 5. Start locally (Phase 8)

Requires Node 22 or later and Docker. The repository CI runs Node 22 and 24; this was verified on Node 22.22.

```bash
npm ci
npm run app        # build, start a disposable PostgreSQL 16.15 container, seed, serve
# open http://127.0.0.1:4173/   (Ctrl+C stops the app and removes the container)
```

**What a start does:**
- creates a fresh database and seeds it, taking about 0.5 s after the container is ready;
- generates random role and superuser passwords that are never printed;
- binds to 127.0.0.1 only.

**Options:**
- `SI_APP_PORT=8080 npm run app` serves on another port.
- To use an existing loopback test cluster instead, such as `docker compose up -d --wait db`, run `npm run build:app && SI_APP_PGPORT=54329 SI_APP_ADMIN_PASSWORD=local-test-only node app/dist/main.js`. This **drops and recreates** the database `si_demo_v1`, and it sets the cluster's role passwords to random values, so rerun the DB tests' bootstrap afterwards.

## 6. Workflows (Phase 6)

Each workflow was verified in Chromium by driving the interface (Playwright), and by the API tests.

**1. Discover.** In *Collection & publication*, run "new advertiser" on Alpha:
1. T1 starts the run.
2. T2 validates and publishes 3 rows.
3. The receipt is recorded.
4. The run's evidence is **not yet readable**: search returns nothing.
5. *Verify receipts*: 1 verified, VALID.
6. Search for "aurora": Aurora Kitchenworks appears, with 2 distinct ads.

**2. Investigate.** In *Advertiser explorer*, search "northwind": two hits, one per source. Opening the Alpha one shows:
- 4 distinct ads, 7 observations and 4 runs;
- a timeline of source-reported times;
- a per-ad table;
- the evidence history with run, ordinal, content SHA-256 and verdict;
- provenance and source verification status.

**3. Operational safety.** In *Collection & publication*, SUSPEND Beta:
- the control is recorded as `si_rights_admin`, and the analyst's access becomes UNAVAILABLE (SUSPENDED);
- history is refused with `SOURCE_UNAVAILABLE`;
- search lists Beta as not searched, with its reason;
- the overview shows no counts for Beta;
- a new collection on Beta is refused with `SOURCE_SUSPENDED`.

LIFT restores access.

**Failed publication.** The "invalid evidence" scenario is persisted as FAILED with `VALIDATION_FAILED` and the diagnostic `INVALID_COUNTRIES` on `countries`. Nothing in the batch is published, including its valid row.

### Screenshots

These are captured from the running application in Chromium (Playwright) on freshly seeded data. They are in `docs/demo-v1-screens/`:
- `01-overview.png`
- `02-explorer-search.png`
- `03-advertiser-detail.png`
- `04-operations-collected.png`
- `05-discover-aurora.png`
- `06-failed-publication.png`
- `08-history-refused.png` (workflow 3)
- `10-mobile-explorer.png` (390 px viewport)

## 7. Tests (Phase 7)

`tests/app/demo-app.test.mjs` runs against a real disposable PostgreSQL 16; CI runs it after the integrity gate. Expected values are recomputed from `PLAN`, never taken from the API.

| Test | Covers |
|---|---|
| APP-1 | seeding goes through T1, T2 and verification; planned outcomes, including the FAILED run |
| APP-2 | overview equals an independent recomputation; an ungranted source releases nothing; the empty source |
| APP-3 | search pagination (every hit exactly once, in code point order), tampered cursor, distinct ads not summed, empty result, network filter |
| APP-4 | advertiser detail and history equal the plan, per ad; same name in two sources stays separate; source-reported range; empty history |
| APP-5 | ungranted source refused `NOT_AUTHORIZED`, never empty |
| APP-6 | workflow 1 |
| APP-7 | failed publication (VALIDATION_FAILED, nothing published) and REJECTED scope mismatch |
| APP-8 | workflow 3: suspension blocks history, search, overview and collection; LIFT restores |
| APP-9 | no credentials or connection strings in any response; CSP and framing headers; CSRF, cross-origin and forged-Host refusals; input validation; no free-form evidence; no TERMINATE_RETENTION exposed |
| APP-10 | a second seed produces identical content |

## 8. Known limitations

- **Single local operator.** There is no end-user authentication or session. The browser runs both reads (analyst principal) and operator actions; the roles are separated only inside the server.
- **Every start resets the data.** There is no persistence across restarts, by design.
- **All collection timestamps fall on the seeding day.** Collection-time filters and first/last observed therefore show one day. Historical depth is visible in the source-reported dates.
- **Overview counts read every readable record of each source on each load** (audited, bounded at 5,000 per source). This suits demo scale; at larger scale the overview needs a content-free count function, which does not exist yet.
- **Search needs a name fragment.** The search function has no "list all advertisers".
- **History is fetched in full** (up to 5,000 observations) and then paged in the browser.
- **Per-run verdicts are not shown.** No non-owner role can read them; only per-source counts are.
- **Each overview, search or history load writes read-intent audit records,** as every read does.

## 9. Next product improvements

1. A content-free, per-source count function for the overview, so it no longer needs a full evidence scan. This needs a design decision and a grant review.
2. End-user authentication and a role-separated operator console, required before anyone other than the local developer uses it.
3. Server-side history paging in the interface, exposing the history reader's keyset pages directly.
4. Optional time-shifted seeding, as a labelled fixture, to show multi-day collection history.
5. Export and customer display only after the governance steps in §3.
