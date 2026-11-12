# B-002 — request audit before evidence retrieval (migrations 0009 and 0010)

**Status:**
- M3-AUD-01 (0009) was implemented on branch `claude/b002-m3-aud-01`.
- The M3-AUD-02 independent review rated it CONDITIONAL ACCEPT for synthetic use, with conditions C1 and C7.
- M3-AUD-03 (0010) implements C1 and C7 on branch `claude/b002-m3-aud-03`, pending independent acceptance.

**Scope:**
- synthetic data only;
- internal evaluation reads only;
- no customer display, export, sharing or real-evidence access.

**Decisions:** FD18 (M3-AUD-01) and FD19 (M3-AUD-03) are recorded as **PROPOSED** in `docs/b002-m3-design.md` §2.1. They are not approved by these implementations.

## 0. What this audit does and does not guarantee

> **REQUEST AUDIT:** records an authorized request, subject to independently verified durability conditions.
> Every read first commits a read intent bound to the login and the exact scope. Since 0010, no evidence is
> released until that intent's commit record is flushed to WAL on disk (§2.2). The durability conditions in
> §2.3 are part of the guarantee.
>
> **DISCLOSURE AUDIT: NOT GUARANTEED.**
>
> **Exactly-once delivery: NOT GUARANTEED.**
>
> **Rollback-resistant release accounting: NOT IMPLEMENTED.**

| Guarantee | Status after 0010 | Basis |
|---|---|---|
| A. Request recorded | VERIFIED | No read returns rows without a matching intent (AUD-1…AUD-4, AUD-8, AUD-M mutants; M3-AUD-02 S2, S6, S7, S15) |
| B. Request durably committed | VERIFIED, within the §2.3 conditions | Rows are released only after WAL is flushed past the intent's commit record (§2.2; AUD-12a/b/c; AUD-DM mutants) |
| C. Retrieval authorized | VERIFIED at retrieval | Every 0008 check runs after the gate (AUD-5, AUD-13c, RD/RC). Not recorded: which grant authorized the release |
| D. Evidence returned by PostgreSQL | PARTIAL | A CONSUMED intent or a completion row proves a release only if the caller's transaction committed. A rollback, a rolled-back savepoint, a dropped socket or a crash erases it |
| E. Evidence received by the client | NOT GUARANTEED | The database cannot observe receipt |
| F. Exactly-once disclosure | NOT GUARANTEED | One intent can be released repeatedly through rollbacks within its 60 s lifetime, and results can change under one intent (§5) |

## 1. Background: A1 and S13

**A1 (0008).** The only record of a read (`si.reader_access_log`) was written in the caller's transaction, so `BEGIN; read; ROLLBACK` erased it. Migration 0009 added a committed **request** record (the read intent). It did not add a rollback-resistant **release** record.

**S13 (0009, found by M3-AUD-02).** `RecordTransactionCommit` decides at commit time whether to flush, based on the current `synchronous_commit`. A reader could:
1. call `si_begin_read`, which refused `synchronous_commit = off` at that moment;
2. run `SET LOCAL synchronous_commit = off` in the same transaction;
3. commit, and read at once.

A server crash before the WAL writer flushed then lost the intent, although the rows had already been delivered.

0009 checked only that the intent was committed (visible). A comment in `0009_read_audit.up.sql` says the `synchronous_commit` refusal makes "a committed intent … durable before it is visible". **That statement is incorrect (erratum).** 0009 is kept byte for byte, and 0010 corrects the behaviour.

Reproduced on PostgreSQL 16.15 with SIGKILL crash recovery:
- 0009 lost the intent after release in 3 of 12 attempts at the default WAL-writer delay, and deterministically with a 10 s delay;
- 0010 lost 0 of 12, and refused deterministically with a 10 s delay.

## 2. The flow after 0010

```
reader (autocommit)                         database
──────────────────────────────────────────  ─────────────────────────────────────────────────────────
SELECT si.si_begin_read(src, cursor, limit) checks: READ COMMITTED; limit 1..100; dedicated reader
                                            principal (session_user); safe session (0008 rules plus
                                            synchronous_commit <> off); cursor belongs to src;
                                            SYNTHETIC source with an active grant
                                            INSERTs si.read_intents (OPEN, 60 s), server-set identity,
                                            time and transaction id; the intent id carries that id
COMMIT  (request record) ─────────────────────────────────────────────────────────────────────────
SELECT * FROM si.si_read_evidence(          all 0008 argument, identity and session checks (plus
          src, intent_id, cursor, limit)    synchronous_commit <> off); xid from the id; pg_xact_status
                                            must be 'committed'; T := pg_current_wal_insert_lsn();
                                            then the intent row: same session_user, exactly
                                            (src, sha256(cursor), limit), created_xid = xid, OPEN,
                                            unexpired; then WAIT until pg_current_wal_flush_lsn() >= T
                                            (≤ 1 s, no lock held, else INTENT_NOT_DURABLE);
                                            then, unchanged from 0008: source FOR SHARE, current grant,
                                            si_evidence_readable per run, bounds; source lock released;
                                            intent OPEN → CONSUMED; completion row; rows out
```

### 2.1 Why the intent id carries its transaction id

The WAL target T must be taken **after** the commit is observed. It must also be taken **before** the read touches `si.read_intents`, because a heap access can itself insert WAL (HOT pruning) that nothing will flush.

A first prototype took T after looking up the intent row. It refused **153 of 1,500 idle reads (10 %)**, and `pg_walinspect` showed `Heap2:PRUNE` as the only unflushed WAL each time.

With the transaction id taken from the id itself, observing the commit needs no table access. The same test gave **1,500 of 1,500** reads, with a maximum of 16 ms. The row must then have `created_xid` equal to that id, so a forged id that names some other committed transaction is refused.

### 2.2 Durability proof (PostgreSQL 16 source and behaviour)

1. **Commit order.** `RecordTransactionCommit` inserts the commit record first (`XactLogCommitRecord` → `XLogInsert`). It reserves `[start, end)` by advancing `Insert->CurrBytePos` under `insertpos_lck`. It then flushes, but only if `synchronous_commit > off` at commit time. Then it updates the clog (`TransactionIdCommitTree` or `TransactionIdAsyncCommitTree`). `ProcArrayEndTransaction` runs last.
2. **What `pg_xact_status` sees.** It returns `committed` only if the transaction is no longer in the proc array **and** the clog says committed. Both happen after the commit record's space is reserved.
3. **The target bounds the commit record.** `pg_current_wal_insert_lsn()` (`GetXLogInsertRecPtr`) reads `CurrBytePos` under the same spinlock, so T ≥ the end of the commit record.
4. **The flush position means fsynced.** `pg_current_wal_flush_lsn()` (`LogwrtResult.Flush`) advances only in `XLogWrite`, after `WaitXLogInsertionsToFinish` and `issue_xlog_fsync`. So once flush ≥ T, the commit record is complete and fsynced, and crash recovery replays it.
5. **Verified against behaviour, not only source.** The proof was checked by SIGKILL crash recovery:
   - AUD-12a;
   - the AUD-DM mutants, whose detecting scenarios crash the server;
   - the M3-AUD-03 before/after experiment.

   It was not assumed from "write vs. flush" positions.

### 2.3 Durability conditions (part of the guarantee)

- **fsync = on.** Durability means the local WAL flush, and it is only as strong as fsync. The test compose file runs `fsync = off`: a PostgreSQL crash is covered, but an OS or power failure is not exercised.
- **Local durability only.** No synchronous standby is supported (D7 precondition).
- **Primary only.** A server in recovery refuses reads with `INTENT_NOT_DURABLE`.
- **Durability is not tamper resistance.** Superuser, owner and migrator remain outside the trust boundary: they can delete or rewrite intents.
- **Bounded wait.** The wait is at most 1 s, holds no lock and can be cancelled. On timeout, `INTENT_NOT_DURABLE` (55000), nothing is released, and the intent stays OPEN.

## 3. Invariants and where each is enforced

| ID | Invariant | Enforced by | Tests |
|---|---|---|---|
| AUD-I1 | No evidence is returned without a committed intent of the same login and exact scope | `si_read_evidence` (0010): transaction id from the intent id, `pg_xact_status`, row lookup, scope and `created_xid` comparison | AUD-1…AUD-4; AUD-M committed / principal / scope |
| AUD-I1b | No evidence is returned until that intent's commit record is flushed | The durability gate (§2.2) | AUD-12a/b/c; AUD-DM: wait removed, timeout fails open, target weakened, target taken before the commit is observed |
| AUD-I2 | Application roles cannot delete or alter an intent; the only transition is OPEN → CONSUMED | Owner-only table; `trg_read_intents_guard` | AUD-4, AUD-8; G1 |
| AUD-I3 | Identity comes from `session_user`, never from a parameter | Trigger and read | AUD-4, AUD-8, RD-12 |
| AUD-I4 | An intent is single-use once its consumption **commits**, and expires after 60 s | `UPDATE … WHERE state = 'OPEN'`; `expires_at` | AUD-4, AUD-6, AUD-7; AUD-M consumption |
| AUD-I5 | A committed intent never overrides current authorization | Every 0008 check runs after the gate, under the source lock | AUD-5, AUD-13c; demo A2; RD/RC |
| AUD-I6 | Intents are content-free | Source id, SHA-256 of the cursor, limit and counts | AUD-1, AUD-10 |
| AUD-I7 | Emergency controls are never blocked by intents or by the gate | No FK to `sources`; the gate holds no lock; the intent row lock is taken after the source lock is released | AUD-9, AUD-13c, RC-9 |
| AUD-I8 | Down 0010 restores the exact 0009 catalog; down 0009 restores the exact 0008 catalog | Down migrations | M1j, M1i, AUD-11 |
| AUD-I9 | No reader entry point returns evidence without a matching intent | `si_reader` executes only `si_begin_read` and `si_read_evidence(text, uuid, text, int)` | AUD-8, SR-0, SD1 |
| AUD-I10 | An uncertain transaction (malformed, foreign, future or aborted) or recovery fails closed with a fixed code | Exception mapping in the gate | AUD-12b; AUD-DM uncertain |

## 4. Failure, retry and what can be proved

| Situation | Evidence released? | Record left | Retry |
|---|---|---|---|
| `si_begin_read` refused | No | Nothing | Fix the cause |
| Intent created in the caller's open transaction, read in it | No (`INTENT_UNCOMMITTED`) | Nothing once that transaction ends | Call it in autocommit |
| Intent committed asynchronously and not yet flushed | No, until flushed; then normal | OPEN intent | Wait or start a new read. A timed-out intent can be reused once it is flushed |
| Another session holds unflushed WAL written after the intent committed | No, if it is not flushed within 1 s (`INTENT_NOT_DURABLE`) | OPEN intent | **A new read.** The new intent's synchronous commit flushes the earlier WAL (AUD-13b). `readEvidence` does this itself when it created the intent: at most `NOT_DURABLE_ATTEMPTS` = 3 attempts in total, each leaving its own request record. A caller-supplied intent is never replaced |
| The intent's COMMIT fails, or the connection is lost before the id arrives | No: the library has no id | Nothing, or an OPEN intent | New read |
| Read refused: NOT_AUTHORIZED | No | OPEN intent | No (final) |
| Read BUSY, cancelled or connection lost during the read | No, or unknown | OPEN intent | Same intent (`retryable`) |
| **Read succeeded, caller rolls back** | **Yes** | **Only the request (OPEN intent).** The release record (consumption, completion row) is erased | The same intent can be reused while unexpired |
| Read succeeded and committed | Yes | CONSUMED intent and completion row | New read |
| A second session uses an intent another session is consuming | No while the first is open (`INTENT_NOT_DURABLE` or `INTENT_USED`) | — | Exactly one release per committed consumption |

**What the records prove:**
1. A durable OPEN or CONSUMED intent proves that this login requested this exact scope at this time, while it held an active grant.
2. CONSUMED, or a completion row, proves a release only if the caller's transaction committed. Its absence proves nothing.
3. Nothing proves delivery or counts releases.

## 5. Residual limitations (not solved here)

1. **No disclosure audit.** Releases under rollback are not recorded. Measured in M3-AUD-02 S3–S6 and S12:
   - before 0010, one intent was released about 620 times in 2 s with no release record;
   - after 0010, about 12 times in 2 s, because each rolled-back read leaves unflushed WAL that the next read must wait for. This only slows reuse; it is not a control.
2. **Content drift.** An intent binds scope, not content. The same intent returned 5 rows instead of 2 after more records were verified (S4).
3. **Restored copies.**
   - A same-cluster logical copy can still accept the original's open intents within their lifetime (S14). No database or cluster binding exists yet (C6).
   - On a foreign cluster, transaction ids alias. The gate maps errors to fixed codes, and the 60 s lifetime remains the bound.
4. **No grant attribution.** The authorizing grant is not recorded (S8, C4).
5. **Unbounded growth.** About 1,200 intents per second per reader, about 200 B each, with no cap and no retention (S16, C5).
6. **Liveness.** A read can fail closed (`INTENT_NOT_DURABLE`) when another session inserted unflushed WAL after the intent committed. Examples are an open writer, a second session consuming the same intent, or background activity: this was observed once in the regular suite, right after crash recovery. A new read resolves it, and the library retries with a new intent (bounded at 3 attempts). Measured with no other sessions active: 0 of 1,500 refusals. PostgreSQL exposes no SQL-observable tighter bound on an intent's commit record, because it does not reveal whether a commit was synchronous, so this cannot be tightened soundly.
7. **Trust boundary.** Superuser and owner remain outside it. There is no out-of-band release record (C2) and no log shipping.
8. **Unchanged blockers:** independent verification of D8/G3, D5b, D7 startup enforcement and scheduling.

## 6. Tests and mutants

| Area | Content |
|---|---|
| `tests/crash/m3-durability-crash.test.mjs` (M3-AUD-03; separate CI step "Crash durability", because it restarts PostgreSQL) | **AUD-12a** async-commit crash durability (SIGKILL crash recovery): an unflushed intent is refused, and no released page loses its intent at the default writer delay. Also 4 crash-detected mutants: wait removed, timeout fails open, target weakened, target taken before the commit is observed |
| `tests/crash/m3-durability-fixtures.test.mjs` (M3-AUD-03; durability CI step since M4-P1, because AUD-12b and AUD-13c use the `wal_writer_delay` fixture) | **AUD-12b** bounded timeout and fail-closed uncertainty: future, foreign, zero and forged ids. **AUD-12c** a concurrently committing creator. **AUD-13a** ordinary reads (median about 4 ms), explicit transactions and savepoints, async read session refused. **AUD-13b** unrelated open writer (fail closed, then a new read succeeds) and racing readers. **AUD-13c** cancellation, revocation and retention expiry around the gate, with emergency-control latency. **AUD-FX** (M4-P1.1, D2): the writer fixture is verified both ways, and ordinary reads right after each verified restore do not wait. **Since M4-P1.2 (R3)** AUD-13a and AUD-FX measure the gate directly instead of a wall-clock bound: each read's own intent commit, located in the WAL, is durable before the read and at the gate (via an instrumented copy that differs by one NOTICE). A new AUD-DM mutant (intent committed asynchronously) proves the measurement is sensitive. Since M4-P1.1 the fixture verifies the requested WAL-writer behaviour instead of sleeping, and AUD-12c and AUD-13a warm each fresh database first |
| AUD-DM mutants (6 in total) | Wait removed; timeout fails open; target weakened to the flush position; target taken before the commit is observed (these four through a real crash, in the crash file); read-session `synchronous_commit` check removed; uncertain transaction id not mapped to a fixed code (these two in the regular suite). Each is detected by a scenario that exercises the failure |
| `tests/reader.test.mjs` | RL-7: bounded new-intent retry on `INTENT_NOT_DURABLE`; a caller-supplied intent is never replaced |
| `tests/db/m3-audit.test.mjs` | AUD-1…AUD-11. **AUD-2 renamed:** it proves the request record survives a rollback and asserts that the release record does not. AUD-3 and AUD-7 were updated for 0010's fail-closed concurrency. The AUD-M mutants now target the 0010 read |
| `tests/db/m3-reader.test.mjs` | RD and RC tests on the 0010 read; the instrumented pause marks itself, so it cannot be confused with the gate's sleeps |
| Migrations | M1j (0010 reversibility, byte for byte); version lists updated to 10 |
| Demonstration | **A1 renamed and measured:** request records lost on rollback = 0, release records lost = 1 (previously a hard-coded 0); limitations wording |
| DR-1 | Also runs AUD-13a on the restored cluster (non-crash) |

## 7. What an independent reviewer should verify

1. The §2.2 ordering argument against the PostgreSQL 16 source, and that `pg_xact_status` cannot report `committed` before the commit record is reserved.
2. That no statement before the target capture can let evidence out, and that statements before it can only make T later, never earlier.
3. That the `created_xid` binding makes a forged id (another committed transaction's id) harmless.
4. That the four crash-based mutant scenarios fail for the stated reason, and the fixture (`wal_writer_delay = 10s`, SIGKILL) is sound.
5. The §2.3 conditions (fsync, primary only, no synchronous standby) as operational requirements.
6. That the documentation nowhere claims disclosure accounting.
