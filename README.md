# Shop Intelligence — B-001 Source Feasibility Harness

A TypeScript **offline-only** evaluation harness for future multi-network advertising data adapters.

## Scope and limits

- Strict parsing, network-scoped identities, deduplication, collection runs and basic diagnostic ratios.
- Fail-closed rights for evaluation, retention, subscriber display, media mirroring and exports.
- Synthetic fixture adapters only. **No live platform API integrations, scraping, HTTP requests, UI, or commercially licensed ad dataset**. The B-002 PostgreSQL foundation persists rights, runs and synthetic evidence; the offline ingestion harness (`npm run demo`) is not connected to it end-to-end.
- An `ALLOWED` flag is an internal gate, **not legal authorization**. Real permissions require independently documented source agreements.
- Synthetic fixture links use `example.org` and are never fetched.
- Runtime dependency: `pg`. Development dependencies include `typescript`, `@types/node`, and `@types/pg`; versions are pinned in `package.json` and locked in `package-lock.json`. Requires Node 22+.

## Run

```bash
npm ci
npm run typecheck
npm test
npm run demo
```

## Current model

```
source offline fixture → source adapter → strict normalization → run validation
                                                 ↓
                                        rights gate + diagnostics
```

The offline adapter publishes or persists no data. B-002 separately persists rights, controls, run metadata and synthetic evidence. If any record is invalid, the entire run is FAILED and the harness returns no trusted rows.

CI (`.github/workflows/ci.yml`) runs typecheck, tests and the demo on Node 22 and 24, plus three consecutive PostgreSQL integration suites. Push triggers include `main`, `claude/**`, and `codex/**`; pull requests also trigger CI.

## B-002 persistence (development milestones; not production-approved)

PostgreSQL 16 foundation with roles, bootstrap, a migration runner and integration tests against a
real, disposable database. Synthetic sources only; internal evaluation reads only (no customer display, no export, no content
serving), no live collection, no production deployment.

| Migration | Content | Status |
|---|---|---|
| 0001 | sources, versioned rights, rights evidence, Amendment C source controls | Milestone 1 |
| 0002 | collection runs, receipts, run errors; T1, heartbeat, T3, reaper, EMPTY T2 | Milestone 2 (conditional development acceptance, D-M2-01) |
| 0003 | request scope (scoped T1, FD7 option C) | M3-P1, accepted (scope foundation) |
| 0004 | completion hardening (`si_complete_run(uuid, uuid, jsonb)`) | M3-P2A, accepted |
| 0005 | atomic evidence persistence (`si.ads`, `si.observations`), collector logging prerequisite | M3-P2B, accepted as a development milestone; FD7 end-to-end scope enforcement accepted through P2B |
| 0006 | retention enforcement and safe purge (`si_purge_due`, purge audit, retention status) | M3-P3A, accepted |
| 0007 | receipt verification (VALID / INVALID / UNVERIFIABLE), frozen legacy receipt columns, fail-closed readability predicate | M3-P3B, accepted |
| 0008 | controlled internal retrieval: `si_reader` principals, per-source grants, bounded `si_read_evidence` | M3-P3C, accepted |
| 0009 | read request audit: a committed, scoped read intent (`si_begin_read`) before any evidence; replaces the 0008 read entry point | M3-AUD-01, conditionally accepted for synthetic use by M3-AUD-02 |
| 0010 | crash-durable read intent: no evidence until the intent's commit is flushed to WAL (bounded, fail closed) | M3-AUD-03, conditionally accepted by M3-AUD-04 |
| 0011 | reader source status: content-free per-source, per-period run and verdict counts for freshness and reliability, gated like an evidence page | M4-P1, conditionally accepted for synthetic development by M4-P1-ACCEPT-01 (FD20 approved, synthetic only) |
| 0012 | reader source availability: available or not, fixed reason codes and a state token, so that history and search never present an unavailable source as empty | M4-P1.1 (D1), conditionally accepted for synthetic development by M4-P1.1-ACCEPT-01 |
| 0013 | opaque availability state: the token becomes an HMAC under an owner-only key, bound to reader and source (no recoverable metadata) | M4-P1.2 (R1), conditionally accepted by M4-P1.2-ACCEPT-01 (FD21 accepted for synthetic development) |
| 0014 | server-side audited advertiser search and history: bounded, keyset-paged, one audited request per page binding the complete request; replaces the client-side 5,000-record scan | M4-P2, conditionally accepted (M4-P2-ACCEPT-01); FD22 conditionally authorized |
| 0015 | intelligence remediation: response bound = audit bound (262,144 bytes, typed refusal); resource bounds pinned on the reader functions (work_mem, temp_file_limit; requires the bootstrap parameter grant); names up to 1,000 characters (index on a digest of the normalized name) | M4-P2.1, accepted by M4-P2.1-ACCEPT-01 (synthetic development) |
| 0016 | cold-database query reliability: readable runs selected once per page before the page statement (no join whose plan depends on statistics), `plan_cache_mode` pinned to custom plans; same predicate, gate and bounds | M4-P2.2, pending independent acceptance |

```bash
docker compose up -d --wait db   # local/test only, bound to 127.0.0.1
npm run test:db
```

Retention (0006): evidence of a completed run is kept until its effective end, the earlier of the
stored deadline (`retain_until`) and the end set by later rights events or `TERMINATE_RETENTION`.
After that, `si_purge_due` (executable only by `si_retention`) deletes the run's observations and
the ad identities no remaining observation references, marks the run PURGED and writes a
content-free audit record, all in one transaction. Source retirement alone does not end retention.
Operators run it explicitly; nothing is scheduled:

```bash
SI_DATABASE_URL=<si_retention login> node dist/persistence/cli.js retention purge [--limit N]   # one bounded batch
SI_DATABASE_URL=<si_monitor login>   node dist/persistence/cli.js retention status | overdue | failures
```

Receipt verification (0007): `si_verify_receipts` (executable only by `si_monitor`) classifies each
completed run with evidence from PostgreSQL's own transaction id and commit timestamp; a receipt alone
never authorizes anything, and no evidence can be read in this milestone.

```bash
SI_DATABASE_URL=<si_monitor login> node dist/persistence/cli.js verification run [--limit N] | status | failures
```

Internal retrieval (0008): a dedicated principal (`si_reader_<name>`, provisioned with
`provisionReaderPrincipal`) with a per-source grant (`si_grant_reader`, by `si_rights_admin`) can read
bounded pages of VALID, currently authorized synthetic evidence through `readEvidence`
(src/persistence/reader.ts). Destination and creative URLs are not returned; nothing is customer-facing.
Since 0009 every read first commits a read intent bound to the login and the exact scope, and since 0010
no evidence is released until that commit is flushed to WAL. This is a REQUEST AUDIT only (an authorized
request is recorded, subject to the durability conditions in `docs/b002-m3-audit.md` §2.3). DISCLOSURE
AUDIT: NOT GUARANTEED. Exactly-once delivery: NOT GUARANTEED. Rollback-resistant release accounting: NOT
IMPLEMENTED — a caller rollback still erases the record that rows were released.

Synthetic advertiser intelligence (M4-P1, `docs/b002-m4-intelligence.md`): `src/persistence/intelligence.ts` provides
advertiser history, deterministic search and freshness/reliability indicators over the verified read boundary
(evidence pages plus the 0011 source status), per explicitly authorized source, with explicit UNKNOWN states.
Since M4-P1.1 (0012 source availability), an unavailable source is a typed failure with a fixed reason
(suspended, terminated, retired, rights or retention restricted), never an empty history or search result.
`npm run demo:intelligence` demonstrates it on synthetic data only (not live market conditions).

Lifecycle demonstration (M3-P3D): `npm run demo:lifecycle` runs the real implementation end to end —
synthetic collection, verification, internal read, revocation, retention and purge, plus negative
controls — against a fresh disposable PostgreSQL 16.15 container and writes a content-free report.
See `docs/b002-m3-demo.md` (what is real, what is synthetic, and what remains unverified).

Production mode (`SI_PRODUCTION=1`, `preflight --production`) also requires `SI_COLLECTOR_DATABASE_URL`:
the gate checks a live collector session's effective logging settings and fails closed without it.

Deleted rows stay in PostgreSQL storage until vacuumed, and in WAL, backups and replicas under
their own retention: the purge is a logical deletion, not secure erasure. Retention is enforced for
synthetic evidence in development only and is **not production-ready**.

Design and status: `docs/b002-m3-design.md` (Milestone 3, §12 for retention), `docs/b002-persistence.md`
(foundation), `docs/b002-m2-final-acceptance.md` (Milestone 2 decisions).
**Release invariant:** no production content-serving path may launch until the publication
timing gap D8/G3 is resolved and independently tested (D-M2-10); 0007 adds commit-time verification,
not the read gate. D5b must be applied and verified
on every production database (D-M2-09).

## Next gates

1. Test rights semantics against actual platform/source agreements before enabling any live adapter.
2. Independently verify D8/G3 and the read request audit. Commit-time verification (0007), an internal,
   synthetic-only read gate (0008), committed read intents (0009) and their crash durability (0010) exist; only
   0009 has had an independent review (M3-AUD-02). A disclosure audit does not exist. No customer display path
   is authorized.
3. Obtain explicitly permitted API credentials and source-specific integration tests.
4. Measure real record quality by country/network without claiming completeness.

See `docs/architecture.md` and `docs/acceptance.md`. Milestone 3 closure review: `docs/b002-m3-closure.md`,
`docs/b002-m3-risk-register.md`, `docs/b002-m3-audit-proposal.md`, `docs/b002-m4-options.md`. Read request audit (what it does and does not guarantee):
`docs/b002-m3-audit.md`.
