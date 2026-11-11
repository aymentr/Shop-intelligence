# M3-AUD-01 — durable read audit (proposal, not implemented)

**Status: PROPOSAL for a founder decision. Nothing in this document is implemented.** Baseline:
a0b63183f3c0e16f187287a42d2ab6c9ab5d01fd (migrations 0001–0008). Written for M3-CLOSE-01.

## 1. Problem (A1, reproduced)

`si_read_evidence` (0008) inserts its `si.reader_access_log` row in the caller's transaction. A
reader principal that runs `BEGIN; SELECT … si_read_evidence(…); ROLLBACK;` receives the records,
and the access row disappears with the rollback. Demonstration scenario A1 proves this on every run
(`access_records_lost_on_rollback`), and it reproduced in M3-CLOSE-01 (see the closure report §6).

Consequence: the access log is an accurate record of *committed* reads only. It is not an audit trail
of disclosure. No current test claims otherwise; RD-1 checks the log only for committed reads.

## 2. Goal and non-goals

**Goal.** No evidence record reaches a reader principal unless a durable, content-free record that
*this principal requested this source* has already committed and can no longer be removed by any
application role.

**Non-goals.** Proving *delivery* (the database cannot know what the client received); protecting
against a superuser or `si_owner`/migrator (outside the trust boundary, §13.7 of the design);
preventing credential sharing (operational control, §14.9); customer display, export or new readers.

## 3. Proposed design: committed intent before data

1. `si.reader_access_intents` (owner-only, append-mostly): `intent_id` (random, server-generated),
   `principal` (= `session_user`, never a parameter), `source_id`, `created_at`
   (`clock_timestamp()`), `expires_at` (`created_at + 60 s`), `state` (`OPEN` → `CONSUMED`), and
   `consumed_by_xid`. No content, cursor or row data.
2. `si_begin_read(source_id) RETURNS uuid` — SECURITY DEFINER, EXECUTE for `si_reader` only.
   - It applies the same principal and session checks as the read.
   - It requires an active grant (the grant is checked again at read time).
   - It inserts an OPEN intent and returns its id.
   - It **refuses to run inside an explicit transaction block**. Detection: `statement_timestamp() <> transaction_timestamp()` or `pg_current_xact_id_if_assigned()` before the insert. Validate this in the prototype; §6 lists the alternatives.
3. `si_read_evidence(source_id, intent_id, cursor, limit)` — it adds an argument, so it is a new signature.
   - It requires an intent with these properties:
     - it belongs to the same `session_user` and source;
     - it is OPEN and unexpired;
     - its inserting transaction **committed**, which the read checks with `pg_xact_status(xmin) = 'committed'`, so an intent created in the same uncommitted transaction cannot be used.
   - It locks the intent `FOR UPDATE` and marks it CONSUMED.
   - Only then does it apply every existing check and return data.
   - Every other 0008 rule is unchanged: bounds, cursor binding, lock order, fixed error codes.
4. The completion row (`si.reader_access_log`) stays and remains best-effort: it can still roll back.
   The guarantee is that the **intent** exists, not that the completion row does.
5. Out-of-band copy: the read emits one content-free `RAISE LOG` line. The line carries the intent id, principal, source, row count and byte count. Server logs are not transactional. The existing logging policy already excludes parameters and statement text, so this line must be checked by a canary test.
6. Library: `readEvidence` calls `si_begin_read` in autocommit and then the read, and exposes no option to wrap either call.

## 4. Evaluation against the required threats

| Threat | Outcome under the proposal | Residual |
|---|---|---|
| Rollback | The intent committed before data was released; rolling back the read loses only the consumption mark and completion row | The intent remains OPEN until expiry: "requested, outcome unknown" |
| Intent replay | One intent can be consumed by many rolled-back reads (consumption rolls back). Bound: each such read needed a committed intent within its 60 s lifetime | The guarantee is **existence of a request record per access window**, not a count of deliveries. A strict count is impossible without an autonomous transaction |
| Concurrent reads | `FOR UPDATE` on the intent serializes two reads of one intent; the second sees CONSUMED and is refused (or waits under lock_timeout then refuses) | Lock rank: the intent lock must be ordered after the source (rank 3) — a new rank 3b, before runs — and tested against emergency controls (RC-9 style) |
| Credential sharing | Unchanged: the intent records the login, not the person | Operational: one principal per person/process, credential rotation |
| Connection loss | If the connection drops after the intent commits, the intent stays OPEN and expires | Recorded as "requested, delivery unknown" — the correct conservative audit state |
| Partial response delivery | The database cannot observe client receipt; the completion row records what was *sent* only if it commits | Delivery is not provable; the audit claims request, not receipt |
| Independent audit durability | Intent rows are owner-only and append-only to application roles. The `RAISE LOG` line is a second, non-transactional copy | A superuser can delete both. Durability against the operator needs log shipping to a separate system, which is outside the database |
| Direct database-client bypass | Every reader principal has EXECUTE on the read function only, and the read requires a committed intent. A direct `psql` client must therefore create the intent first | The bypass is closed only for `si_reader_*` logins; superuser and owner remain outside the boundary |

## 5. Invariants (AUD-I)

- **AUD-I1.** No `si_read_evidence` call returns a row unless a committed intent exists for the same principal and source. That intent was created before the read's transaction started.
- **AUD-I2.** Application roles can neither delete nor modify an intent, apart from the single OPEN→CONSUMED transition performed inside the read function.
- **AUD-I3.** The principal is `session_user`. No argument can set it.
- **AUD-I4.** An intent is single-use in committed state and expires.
- **AUD-I5.** `si_begin_read` refuses to run inside an explicit transaction block. If that check proves unreliable, the committed-xmin check of AUD-I1 alone carries the guarantee.
- **AUD-I6.** Intents, log lines and completion rows contain no advertising content, URL, native identifier or cursor.
- **AUD-I7.** Emergency controls are never blocked beyond the existing 2 s bound. These are rights revocation, SUSPEND, TERMINATE and grant revocation.
- **AUD-I8.** The down migration restores the exact 0008 catalog.

## 6. Acceptance tests (proposed IDs)

| ID | Test |
|---|---|
| AUD-1 | Autocommit begin + read: rows returned; intent CONSUMED; completion row present |
| AUD-2 | `BEGIN; read; ROLLBACK` with a committed intent: rows returned, intent row still present (OPEN) after rollback — **the A1 scenario now leaves a durable record** |
| AUD-3 | `BEGIN; si_begin_read; si_read_evidence; …` in one transaction: refused (uncommitted intent / explicit block) |
| AUD-4 | Read without intent, with another principal's intent, another source's intent, an expired or consumed intent: refused with fixed codes, no rows |
| AUD-5 | Two sessions consume one intent concurrently: exactly one succeeds |
| AUD-6 | Connection terminated (`pg_terminate_backend`) after intent commit: intent remains OPEN and expires; status reports it |
| AUD-7 | No application role can UPDATE/DELETE intents (privilege matrix G1/SD1 updated; mutant: grant DELETE → killed) |
| AUD-8 | Log canary: the `RAISE LOG` line carries only principal, source id, intent id and counts; no fixture value appears in server or application logs |
| AUD-9 | Emergency-control timing under concurrent begin/read (RC-9 analogue) |
| AUD-10 | Mutants: omit the committed-xmin check; omit FOR UPDATE; take principal from an argument — each must be detected |
| AUD-11 | Down 0009 → exact 0008 catalog; up re-applies identically; DR-1 restore keeps intents |
| AUD-12 | Demonstration A1 rewritten: expected outcome becomes "durable intent survives rollback" |

## 7. Alternatives considered (not recommended)

- **Autonomous transactions** through `dblink` or `pg_background`. These need an extension and credentials inside the database. They widen the attack surface and the trust boundary.
- **Application-only audit.** Any direct database client bypasses it.
- **Refusing explicit transactions alone**, with no intent. The protection is unreliable, because detecting a transaction block from inside a function is heuristic.
- **Server-log-only audit.** It depends entirely on log retention and integrity, and is not queryable through the database's privilege model.

## 8. Open decisions for the founder

1. Accept "request recorded, delivery unknown" as the audit standard rather than a count of deliveries.
2. Choose the intent lifetime. 60 s is proposed.
3. Decide whether log shipping to a separate system is required before pilot B.
4. Accept a signature change to `si_read_evidence`, which is a breaking change for the library and the demo.
