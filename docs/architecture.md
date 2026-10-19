# B-001 architecture

## Responsibility boundaries

- `types.ts`: explicit ad, rights and run models.
- `validation.ts`: checks required fields, timestamps, country codes, network enum, and URI syntax. URI safety validation only checks syntax, **not DNS/SSRF**; no fetching exists in B-001.
- `rights.ts`: deny unknown/unlicensed usage at each action. Does **not** verify external agreement validity.
- `adapters.ts`: offline adapter contract. No platform specific code.
- `ingest.ts`: batches all fixture rows, rejects entire run if any row fails, normalizes one ad per `(network,nativeAdId)` and returns diagnostics.

## Temporal semantics

`seenAt` = our fixture collection observation. `sourceReportedFirstSeen`/`sourceReportedLastSeen` = dates asserted by source, not independently observed. An absence in a result does not establish inactive status.

## Future production safety

No live adapter until lawful access, retention, downstream use, quotas, and source-specific scope are checked. Real collectors need DNS resolution checks, redirect restrictions, private-network blocking, budgets, pagination checkpoints, concurrency controls, deletion propagation, and transactional persistence.

## Rights states

`ALLOWED`, `DENIED`, `UNKNOWN` are independent per source/action. Only explicitly ALLOWED and unexpired rights pass. The synthetic rights sample permits offline evaluation only, nothing customer-facing.
