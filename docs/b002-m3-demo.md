# B-002 Milestone 3 — synthetic evidence lifecycle demonstration (M3-P3D)

**Status: implemented, pending independent acceptance. Synthetic data only. Not a product, not a
production deployment, not customer-facing.**

The demonstration drives the **real** implementation — migrations 0001–0010 applied by the
least-privilege migrator, and the persistence library in `src/persistence/` — against a fresh,
disposable PostgreSQL 16.15 container. It contains no business logic of its own: the database and the
library decide every outcome; the demonstration only calls them and asserts the results.

## 1. How to run

```bash
npm ci
npm run demo:lifecycle                        # build, then demo/run.sh: about 8 minutes (real-deadline scenario)
DEMO_SKIP_DEADLINE=1 bash demo/run.sh         # under 2 seconds of database work; skips N5 (reported as SKIPPED)
DEMO_REPORT=/path/report.json bash demo/run.sh
bash demo/run-mutants.sh                      # negative control: the demonstration must FAIL with each mutant
```

Requirements: Node 22+, Docker. `demo/run.sh` starts `postgres:16.15` (the pinned digest from
`compose.yaml`) with `track_commit_timestamp = on`, bound to 127.0.0.1 on a Docker-assigned port with
tmpfs storage, runs `demo/lifecycle.mjs`, and removes the container on exit (also on failure). The
superuser and every role password are random per run and never printed; no production credential is
used or accepted. The program refuses to run against anything but a container named `si-demo-*` on a
loopback port. Exit code 0 means every scenario passed.

**Report.** `demo-report.json` (or `$DEMO_REPORT`): commit, PostgreSQL version, schema version, each
scenario with its outcome and duration, collection / verification / read / denial / purge / audit
counts, timings, resource usage, the fixtures used, and the limitations. It contains no advertising
content, native ids or URLs: the program scans its report for every fixture value (and the server log,
scenario L1) and refuses to write a report that would contain one.

**CI.** The `lifecycle-demo` job runs the full demonstration three times (matrix), each against its own
fresh container, uploads the content-free reports, and runs `demo/run-mutants.sh` once.

## 2. Data

`fixtures/synthetic-ads.json` (the B-001 fixture: fictional records, `example.org` URLs that are never
fetched), normalized by the existing B-001 parser (`parseAd`). Where a scenario needs more records the
demonstration derives them deterministically by changing only the identity suffix. The raw,
un-normalized fixture is itself the invalid batch of N3. There is no network collection.

## 3. Scenarios and what each one proves

| ID | Scenario | Proves (real implementation) |
|---|---|---|
| E1 | Environment | Migrations 0001–0010 applied by `si_migrator`; PostgreSQL 16; D7 operational preconditions; safe collector logging |
| H1 | Synthetic source | A SYNTHETIC source with two networks (inserted as `si_owner`: sources have no write function) |
| H2 | Rights | `si_record_rights_version`: evaluation and retention ALLOWED; display, mirroring, export DENIED; valid for publication |
| H3 | Scoped run | Scoped T1 binds the request to the fixture hash and records the network scope |
| H4 | Evidence | Non-empty T2 persists 24 records atomically; the database derives received 25, published 24, duplicate 1 |
| H5 | Counts | Run counts, stored observations and the receipt agree |
| H6 | Commit time | One transaction id shared by every observation and the receipt, with a commit timestamp |
| H7 | Verification | `si_verify_receipts` records VALID / COMMITTED_IN_WINDOW |
| H8 | Reader | A dedicated principal (`provisionReaderPrincipal`) and an audited per-source grant (`si_grant_reader`) |
| H9 | Read | `readEvidence` returns a page; destination and creative URLs are not part of the interface |
| H10 | Pagination | Pages of 7 concatenate exactly to the single 100-record page (order hash reported) |
| H11 | Revocation | After `si_revoke_reader` the read and an earlier cursor are refused (NOT_AUTHORIZED) |
| H12 | Retention | Retention status reports the run due; `si_purge_due` purges 24 observations and 24 identities |
| H13 | Deletion | No evidence or identity left; run PURGED; receipt, verification and purge audit remain, content-free |
| N1 | Unauthorized | A principal without a grant and a service role are refused |
| N2 | Cross-source | An ungranted source and another source's cursor are refused |
| N3 | Invalid batch | The raw fixture (non-canonical timestamps and country order) fails whole: VALIDATION_FAILED, coded diagnostics |
| N4 | Duplicates | Identical copies counted; a conflicting copy fails FAIL_RUN (DUPLICATE_CONFLICT) and keeps the first under KEEP_FIRST |
| N5 | INVALID | A completion whose publication check was made IMMEDIATE commits after its rights expired (real ~7.5 min deadline): verified INVALID / COMMITTED_AFTER_WINDOW, never readable |
| N6 | UNVERIFIABLE | A disturbed receipt identity (labelled fixture) is UNVERIFIABLE and never readable |
| N7 | Expired | Evidence past its effective end (labelled fixture) is not returned |
| N8 | Suspended | Nothing is returned while SUSPENDed; LIFT restores access |
| N9 | Terminated | Nothing is returned after TERMINATE_RETENTION; the evidence is purged |
| N10 | Revoked grant | Refused, including with a cursor obtained before the revocation |
| N11 | Invalid cursor | Refused with BAD_CURSOR |
| N12 | Read limit | 101 refused by the library before sending, and by the database at both the intent and the read (SQLSTATE only) |
| N13 | Unsafe logging | A collector session that could log parameters is refused before any payload; a reader session without a statement bound is refused |
| N14 | Purge vs completion | A purge skips a source held by a completion (BUSY) — no foreign-key error — and purges it afterwards, keeping the shared identity |
| A1 | Request audit only (M3-AUD-01/03) | A read inside a transaction that rolls back keeps its **committed** request record (the read intent, bound to the reader and the source) and the report **measures** what the rollback erased: request records lost = 0, release records lost = 1. Rollback-resistant release accounting is NOT IMPLEMENTED; disclosure audit NOT GUARANTEED. A read whose intent is not committed releases nothing (INTENT_UNCOMMITTED). Until M3-AUD-01 this scenario demonstrated the A1 weakness (§5) |
| A2 | Intent vs. current authorization | Revocation between the committed intent and the read is enforced (NOT_AUTHORIZED); BUSY during a control is retryable with the same intent; a consumed intent is final (INTENT_USED) |
| L1 | Logs | No fixture value appears in the server log |

**Negative control of the demonstration itself** (`demo/run-mutants.sh`): with the reader grant check,
the retention check or the verdict check disabled in the disposable database, the demonstration fails
(grant → H11, H13, N1, N2, N10, A2 — the grant check is disabled in both reader entry points since 0009;
retention → N7; verdict → N6). The final audit check also requires every completion record to name a
committed intent of the same reader and source.

**Fixtures no product path can perform** (named in the report): the demo superuser ages a stored
retention deadline (H12, N7, N14) and disturbs one receipt identity (N6) under
`session_replication_role = replica`. Superusers are outside the trust boundary.

## 4. Real, synthetic, and unverified

- **Real and implemented:** rights and controls, scoped collection, atomic evidence persistence,
  deduplication, receipt verification (including the detection of a commit after the rights window),
  internal grants, bounded reads with current authorization, revocation, retention, purge and audit.
- **Synthetic:** every record, the source, the rights basis (a synthetic declaration), the time travel
  of H12 / N7 / N14, the identity disturbance of N6.
- **Not verified by this demonstration (production guarantees):** independent verification of D8/G3;
  D5b on a production host; startup enforcement of the production gate for real processes; behaviour
  under production load, replication, backup/restore cycles beyond DR-1, or clock faults; scheduling of
  verification and purge; operational logging outside PostgreSQL.

## 5. Auditability: the A1 weakness and its resolution

**Update (M3-AUD-01 / M3-AUD-03, migrations 0009 and 0010):** a REQUEST audit is implemented (committed, crash-durable read intents); a disclosure audit is NOT GUARANTEED and rollback-resistant release accounting is NOT IMPLEMENTED. See `docs/b002-m3-audit.md` for the
contract, its differences from this outline, and the residual limitations. Scenario A1 now demonstrates the request
audit. The original M3-P3D text follows for the record.

**Weakness (A1).** `si.reader_access_log` is written inside the read's transaction. A reader that wraps
a successful read in `BEGIN … ROLLBACK` receives the records while the access record disappears. The
demonstration proves it on every run (`access_records_lost_on_rollback`).

**Proposed production-safe design** (requires a separate decision; not implemented here):
1. **Committed intent before data.** A new `si_begin_read(source)` (SECURITY DEFINER) records an access
   intent (principal, source, intent id, time) and must be called in its own, committed transaction; it
   returns a single-use intent id. `si_read_evidence` then requires a committed, unexpired, unused
   intent of the same principal and source, marks it used, and returns data. Because the intent commits
   before any record is released, no rollback can erase the fact that access was requested; the
   completion record (counts) remains best-effort.
2. **Refuse explicit transactions for reads** as defence in depth: the read verifies that it is the
   only statement of its transaction (for example, by requiring a fresh intent created in a different,
   committed transaction), so the library always reads in autocommit.
3. **Out-of-band copy.** Emit a content-free `RAISE LOG` line (principal, source, counts) from the read;
   server logs are not transactional, and the logging policy already excludes parameters and content.
   This duplicates, not replaces, the database record, and depends on log retention and integrity.
4. Alternatives considered and not recommended: autonomous transactions via `dblink` or `pg_background`
   (extra extensions and connection credentials inside the database), or application-only audit
   (bypassable by any direct database client).

## 6. Customer display rights (missing)

The rights model constrains `subscriber_display`, `export` and `media_mirror` to DENIED/UNKNOWN. The
demonstration reads only under an internal reader grant for synthetic evaluation (FD16); it never
displays, exports or mirrors anything. Customer display needs, at least: a founder and legal decision
and a rights-model change per source; a separate display purpose and grant; a field-level review (URLs
and media excluded until mirroring rights exist); an end-user authentication layer that never trusts a
supplied user id; and independent verification of D8/G3 (design §14.8).

## 7. Why this is not yet an advertising-intelligence product

It proves that synthetic evidence can be collected, verified, read under control, revoked and deleted
safely. It has no real sources or adapters, no rights to show anything to a customer, no search,
filters, history, trends, freshness or reliability reporting for users, no interface, no scheduling,
and no production deployment. Those are later milestones (see the M3-P3 roadmap) and each needs its
own rights and security decisions.
