# B-001 architecture

## Responsibility boundaries

- `types.ts`: explicit ad, rights and run models.
- `time.ts`: strict instant parsing. Timestamps must carry `Z` or `±HH:MM`; offset-less values are rejected because their meaning depends on the host time zone, and impossible dates (Feb 30, 24:00) are rejected rather than rolled over.
- `validation.ts`: checks required fields, timestamps, country-code *shape* (two upper-case letters; not checked against the ISO 3166-1 list), network enum, native ID hygiene (no control characters, ≤256 chars), first-seen ≤ last-seen, and URI syntax. URI safety validation only checks syntax, **not DNS/SSRF**; no fetching exists in B-001.
- `rights.ts`: deny unknown/unlicensed usage at each action. Expiry is compared as instants; an unparseable expiry or clock denies. Does **not** verify external agreement validity.
- `adapters.ts`: offline adapter contract. Each adapter declares its `evidenceKind`; only `SYNTHETIC` exists and ingestion refuses anything else. No platform specific code.
- `ingest.ts`: batches all fixture rows, rejects entire run if any row fails, normalizes one ad per `(network,nativeAdId)` (first record kept), counts duplicates and *conflicting* duplicates (same identity, different content ignoring `seenAt`), stamps each record with `sourceId` and `runId`, sets `finishedAt` on every started run, and returns diagnostics. Pre-flight failures (invalid rights, source/rights mismatch, blocked evaluation, invalid run metadata) throw and start no run.
- `tests/offline-guard.mjs` + `tests/offline-guard.test.mjs`: static **regression check**, run by `npm test` and CI. It recursively scans every source file under `src/` (`.ts`, `.mts`, `.cts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.jsx`) for common network and process-spawning patterns: `fetch(`, `XMLHttpRequest`, `WebSocket`, imports or requires of `http`, `https`, `http2`, `net`, `tls`, `dgram`, `dns` and `child_process`, and a short list of HTTP or browser-automation packages. It reports symbolic links instead of following them. It is a text match, **not a security sandbox**: it cannot detect obfuscated or indirect access (strings assembled at runtime, `eval`, dependencies that open sockets themselves) and does not stop code from running. Code review remains the real control.

## Temporal semantics

`seenAt` = our fixture collection observation. `sourceReportedFirstSeen`/`sourceReportedLastSeen` = dates asserted by source, not independently observed. An absence in a result does not establish inactive status.

## Future production safety

No live adapter until lawful access, retention, downstream use, quotas, and source-specific scope are checked. Real collectors need DNS resolution checks, redirect restrictions, private-network blocking, budgets, pagination checkpoints, concurrency controls, deletion propagation, and transactional persistence.

## Rights states

`ALLOWED`, `DENIED`, `UNKNOWN` are independent per source/action. Only explicitly ALLOWED and unexpired rights pass. The synthetic rights sample permits offline evaluation only, nothing customer-facing.
