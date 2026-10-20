# B-001 acceptance evidence

## Must pass

- TypeScript strict typecheck.
- Offline ingestion fixture with stable network-native IDs.
- Repeated ad deduplicated and tracked in run counters.
- Malformed record fails entire run and returns no trusted ads.
- Source failure sets FAILED.
- UNKNOWN or expired evaluation permission rejects collection.
- Subscriber display, bulk export, and media mirroring denied on synthetic rights.
- Data validation rejects malformed country codes (shape only), invalid URL schemes, offset-less or impossible timestamps, and inverted first/last-seen dates.
- Rights expiry fails closed on unparseable or offset-shifted values.
- Every started run records `finishedAt`; records carry `runId`; conflicting duplicates are counted.
- Static offline guard passes: no common network or process-spawning API patterns in any source file under `src/`, including nested directories. This is a regression check against accidental network code, not a security sandbox; it cannot detect obfuscated or indirect access.
- Tests run with `npm test`; demo produces JSON diagnostics.

## Explicit non-goals

No PostgreSQL, no UI, no API collection, no platform credentials, no production ingestion, no legal review, no actual ad coverage, no live rights verification.
