# Shop Intelligence — B-001 Source Feasibility Harness

A TypeScript **offline-only** evaluation harness for future multi-network advertising data adapters.

## Scope and limits

- Strict parsing, network-scoped identities, deduplication, collection runs and basic diagnostic ratios.
- Fail-closed rights for evaluation, retention, subscriber display, media mirroring and exports.
- Synthetic fixture adapters only. **No live platform API integrations, scraping, HTTP requests, UI, or commercially licensed ad dataset**. The B-002 PostgreSQL foundation persists source/rights/run metadata, but the offline ingestion harness is not connected to it end-to-end.
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

The offline adapter publishes or persists no data. B-002 separately persists rights, controls, and run metadata. If any record is invalid, the entire run is FAILED and the harness returns no trusted rows.

CI (`.github/workflows/ci.yml`) runs typecheck, tests and the demo on Node 22 and 24, plus three consecutive PostgreSQL integration suites. Push triggers include `main`, `claude/**`, and `codex/**`; pull requests also trigger CI.

## B-002 persistence (Milestone 1 complete; Milestone 2 in progress)

PostgreSQL 16 foundation: roles, bootstrap, migration runner, migration 0001 (sources,
versioned rights, evidence, and Amendment C source controls: suspension, irreversible
retention termination, LIFT) and integration tests against a real database. Migration 0002 includes collection runs, publication receipts and errors; T1 authorizes and starts attempts. Lifecycle transitions and T2 publication are not yet implemented.

```bash
docker compose up -d --wait db   # local/test only, bound to 127.0.0.1
npm run test:db
```

See `docs/b002-persistence.md` for the architecture, deviations and limitations.

Milestone 2 (migration 0002, collection runs) is in progress: plan in `docs/b002-m2-plan.md`.
**Release invariant:** no production content-serving path may launch until the publication
timing gap D8 is resolved and independently tested.

## Next gates

1. Test rights semantics against actual platform/source agreements before enabling any live adapter.
2. Add real PostgreSQL transactions, provenance persistence, and deletion enforcement.
3. Obtain explicitly permitted API credentials and source-specific integration tests.
4. Measure real record quality by country/network without claiming completeness.

See `docs/architecture.md` and `docs/acceptance.md`.
