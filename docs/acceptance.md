# B-001 acceptance evidence

## Must pass

- TypeScript strict typecheck.
- Offline ingestion fixture with stable network-native IDs.
- Repeated ad deduplicated and tracked in run counters.
- Malformed record fails entire run and returns no trusted ads.
- Source failure sets FAILED.
- UNKNOWN or expired evaluation permission rejects collection.
- Subscriber display, bulk export, and media mirroring denied on synthetic rights.
- Data validation handles bogus countries, invalid URL schemes and timestamps.
- Tests run with `npm test`; demo produces JSON diagnostics.

## Explicit non-goals

No PostgreSQL, no UI, no API collection, no platform credentials, no production ingestion, no legal review, no actual ad coverage, no live rights verification, no CI execution claims.
