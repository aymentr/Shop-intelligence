# B-002 M3-AUD-01 — durable audit before evidence retrieval (migration 0009)

**Status:** IMPLEMENTED on branch `claude/b002-m3-aud-01`, pending independent acceptance.

**Scope:**
- synthetic data only;
- internal evaluation reads only;
- no customer display, export, sharing or real-evidence access.

**Design:** follows `docs/b002-m3-audit-proposal.md`. Where it differs, §8 says how.

**Decisions:** the M3-AUD-01 design choices are recorded as **FD18 (PROPOSED)** in `docs/b002-m3-design.md` §2.1. They are **not** approved by this implementation.

## 1. What A1 was

Migration 0008 wrote the only audit row of a read (`si.reader_access_log`) inside the caller's transaction. A reader could therefore run `BEGIN; read; ROLLBACK`: the reader kept the records, and the audit row disappeared. The M3-P3D demonstration (A1) and the M3-CLOSE-01 reproduction both showed this.

## 2. The flow after 0009

```
reader (autocommit)                         database
──────────────────────────────────────────  ─────────────────────────────────────────────────────────
SELECT si.si_begin_read(src, cursor, limit) checks: READ COMMITTED; limit 1..100; dedicated reader
                                            principal (session_user); safe session (0008 rules plus
                                            synchronous_commit <> off); cursor belongs to src;
                                            SYNTHETIC source with an active grant
                                            INSERTs si.read_intents (OPEN, 60 s), server-set identity,
                                            time and transaction id; returns intent_id
COMMIT  ← the audit record is now durable ─────────────────────────────────────────────────────────
SELECT * FROM si.si_read_evidence(          all 0008 argument, identity and session checks; then the
          src, intent_id, cursor, limit)    intent must exist, belong to session_user and exactly
                                            (src, sha256(cursor), limit), be COMMITTED
                                            (pg_xact_status), OPEN and unexpired;
                                            then, unchanged from 0008: source FOR SHARE (rank 3,
                                            lock_timeout 2 s), current grant, si_evidence_readable
                                            per run (D8/G3 verdict, retention, suspension,
                                            termination, retirement, rights, networks), bounds;
                                            source lock released; intent UPDATE OPEN → CONSUMED
                                            (rows, bytes); completion row with intent_id; rows out
```

The library (`src/persistence/reader.ts`) works as follows:
- `readEvidence` always sends the two statements in that order.
- `beginRead` exposes step 1 on its own.
- `readEvidence(…, { intentId })` retries a committed intent.
- The library never sends the read unless it received an intent id.

## 3. Invariants and where each is enforced

| ID | Invariant | Enforced by | Tests |
|---|---|---|---|
| AUD-I1 | No evidence is returned without a committed intent of the same login and exact scope | `si_read_evidence`: intent lookup, `pg_xact_status(created_xid) = 'committed'`, scope comparison | AUD-1, AUD-2, AUD-3, AUD-4; mutants AUD-M committed / principal / scope |
| AUD-I2 | Application roles cannot delete or alter an intent; the only transition is OPEN → CONSUMED | owner-only table; `trg_read_intents_guard` (even the owner, including TRUNCATE) | AUD-4, AUD-8; privileges G1 |
| AUD-I3 | Identity comes from `session_user`, never from a parameter; SET ROLE cannot borrow an intent | trigger sets `principal := session_user`; the read compares it with `session_user` | AUD-4, AUD-8, RD-12 |
| AUD-I4 | An intent is single-use once its consumption commits, and expires after 60 s | `UPDATE … WHERE state = 'OPEN'` under a row lock; `expires_at` check; CHECK `read_intents_lifetime` | AUD-4, AUD-6, AUD-7; mutant AUD-M consumption |
| AUD-I5 | A committed intent never overrides current authorization | Every 0008 check runs after the intent check, under the source lock | AUD-5; demo A2; the full RD/RC suite |
| AUD-I6 | Intents are content-free | They store the source id, a SHA-256 of the cursor (never the cursor), the limit and counts | AUD-1, AUD-10 |
| AUD-I7 | Emergency controls are never blocked by intents | `read_intents` has no FK to `sources`; `si_begin_read` takes no source lock; the intent row lock is taken only after the source lock is released | AUD-9, RC-9 |
| AUD-I8 | Down 0009 restores the exact 0008 catalog, including the 0008 read byte for byte | `0009_read_audit.down.sql` | M1i, AUD-11 |
| AUD-I9 | No reader entry point returns evidence without a matching committed record | 0009 drops `si_read_evidence(text, text, int)`. `si_reader` can execute only `si_begin_read` and the new read, and the read is the only function returning `si.evidence_read_row` | AUD-8, SR-0, SD1 |

## 4. Failure, retry and what can be proved

| Situation | Evidence released? | Record left | Retry |
|---|---|---|---|
| `si_begin_read` refused (no grant, bad argument, unsafe session) | No | Nothing (refusals raise) | Fix the cause |
| `si_begin_read` inside an open transaction, then read in that transaction | No (`INTENT_UNCOMMITTED`) | Nothing once that transaction ends | Call it in autocommit |
| The intent's COMMIT fails, or the connection is lost before the id arrives | No: the library has no id and sends no read | Nothing, or an OPEN intent if the commit did happen | A new intent |
| Read refused: revoked, NOT_AUTHORIZED | No | OPEN intent: "authorized request at T, refused at retrieval" | No (final) |
| Read BUSY (a control is in progress) or the connection is lost during the read | No, or unknown | OPEN intent (the consumption rolled back) | **Same intent, same scope, until it expires** (`ReadFailed.retryable`) |
| Read succeeded, caller rolls back | **Yes** | **OPEN intent survives.** Only the completion row and the consumption mark roll back | Same intent while unexpired. Each reuse returns the same scope, under current authorization |
| Read succeeded and committed | Yes | CONSUMED intent (rows, bytes) and a completion row naming the intent | `INTENT_USED`; a new intent is needed |
| Two sessions use one intent concurrently | At most one per committed consumption | The second waits on the intent row, then gets `INTENT_USED`, or reads if the first rolled back | — |

**What the records prove:**
1. A committed intent proves that this login requested this exact scope at this time, while it held an active grant.
2. CONSUMED, or a completion row, proves that the server released N rows and the caller's transaction committed.
3. Nothing proves delivery to the client.
4. An OPEN intent means "requested; outcome unknown".
5. A caller who rolls back can reuse one intent for the same scope until it expires. The audit therefore proves at least one authorized request per release window. It does not count releases.

## 5. Tests and mutants added or changed

| Area | Change |
|---|---|
| `tests/db/m3-audit.test.mjs` (new) | AUD-1…AUD-11 (AUD-11: down 0009 with intents present restores the exact 0008 catalog), plus 4 mutants: committed check, principal binding, scope binding and consumption omitted. Each mutant is detected and each baseline is clean |
| `tests/db/m3-reader.test.mjs` | Every read now commits an intent first. The tests read the 0009 read function, the grant mutant revokes between intent and read, and the byte-cap mutant accepts either CHECK. RD-14 and RC-9 take their intent from a second session of the same login |
| `tests/db/privileges.test.mjs` | SD1, G1 and SR-0 cover the 0009 objects and grants |
| `tests/db/migrations.test.mjs`, `migrator.test.mjs` | Schema version 9; new test M1i |
| `tests/reader.test.mjs` | RL-4…RL-6: statement order, an uncertain intent never leads to a read, retry semantics |
| Demonstration | Migrations 0001–0009. A1 now shows the durable audit; new A2 covers revocation between the steps, BUSY, retry and single use; N12 checks both entry points; the grant mutant disables the check in both entry points; the final audit check finds no completion row without an intent |
| DR-1 | Also runs AUD-2, AUD-4 and AUD-8 on the restored cluster |

## 6. Residual limitations (not solved here)

1. **Superuser and `si_owner` remain outside the trust boundary.** They can disable triggers, delete intents or replace functions. Durability against the operator needs log shipping to a separate system, which is not implemented.
2. **Delivery is not provable** (§4).
3. **The audit cannot count releases** that a caller rolls back (§4, point 5).
4. **Asynchronous commit.** The intent refuses `synchronous_commit = off` at creation. A caller could still create the intent in an explicit transaction and then lower `synchronous_commit` before `COMMIT`; a server crash within the WAL-writer delay could then lose a visible intent. Exploiting this needs deliberate misuse plus a crash. PostgreSQL offers no reliable way for a function to detect an explicit transaction block: measured here, `statement_timestamp()` differs from `transaction_timestamp()` even in autocommit under the extended protocol.
5. **Intents are never purged.** They are content-free, but they grow without bound and have no retention rule.
6. **Credential sharing.** One login per person or process remains an operational control.
7. **The out-of-band log copy** from proposal item 5 (`RAISE LOG`) is not implemented.
8. **Each page costs two round trips.** Timings were measured on the test image only.
9. **Not done here:** independent verification of D8/G3, D5b, D7 startup enforcement and scheduling. They are unchanged and still open.

## 7. What an independent reviewer should verify

1. **Entry points:** in the catalog, `si_reader` can execute only `si_begin_read` and `si_read_evidence(text, uuid, text, int)`, and no other path returns `si.evidence_read_row`.
2. **The committed check:**
   - `pg_xact_status(created_xid)` returns `committed` only for committed transactions, including under subtransactions and after a crash or restart;
   - the intent's `created_xid` (`pg_current_xact_id()` in the trigger) is the top-level transaction id;
   - an intent from a rolled-back transaction is never visible.
3. **Ordering:** no evidence is materialized before the intent checks, and nothing is returned if the consumption or completion insert fails.
4. **Lock order:** the intent row lock is never held together with the source lock. Emergency controls still see bounded waits (AUD-9, RC-9).
5. **Mutants and fixtures:** each AUD-M mutant fails against the real migration for the stated reason, and the commit-failure fixture in AUD-3 behaves as described.
6. **Down migration:** it restores the exact 0008 catalog (M1i).
7. **Residual risks:** the synchronous-commit residual (§6.4) and the "at least one request per release window" standard (§4) are acceptable for the next classification step.

## 8. Differences from the proposal

- The intent is also bound to the **cursor digest and limit**, so it covers the exact read scope rather than only the source.
- The explicit-transaction refusal (proposal item 2 and AUD-I5) was **dropped as unreliable** (§6.4). Safety rests on the committed-transaction check alone.
- The intent table has **no foreign key** to `sources`, so emergency controls are never blocked. Source existence is checked in the function instead.
- **Not implemented:** the `RAISE LOG` copy (proposal item 5).
