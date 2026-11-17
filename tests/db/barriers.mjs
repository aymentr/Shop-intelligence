// B-002 M4-P3.1-TEST-CLOSE-01: deterministic synchronization for concurrency tests (R-43, R-44). Test code only.
//
// 1. Marked pause (R-43). An INSTRUMENTED COPY of a function (test databases only) holds its session at an exact point:
//    it sets a per-run marker as the transaction-local application_name, then polls a transaction-level advisory lock
//    that the test holds. The session stays there until the test releases the lock; no elapsed time decides anything.
//    The pause is a try-lock loop, not a blocking lock wait, so the function's own lock_timeout cannot fire. The marker is
//    transaction-local (set_config(..., true)): it reverts when the reader's transaction ends, so it can never be
//    observed outside the pause, and it carries a random nonce, so a marker from another run cannot match.
// 2. Control observation (R-44). A control call is tracked as not-started / running / blocked (by the expected holder)
//    / completed / failed. The observation never concludes "not blocked" from an idle session whose query may not
//    have started yet: only the call's own completion or failure ends an unblocked observation.
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { classifyError } from './helpers.mjs';

/** A fresh marker and the advisory key derived from it. */
export function pauseMarker() {
  const mark = `si-pause-${randomBytes(6).toString('hex')}`;
  return { mark, key: BigInt.asIntN(64, BigInt(`0x${randomBytes(8).toString('hex')}`)).toString() };
}
/** The SQL fragment inserted into an instrumented function copy: a no-op unless the session set si.test_mark/si.test_key. */
export const PAUSE_SQL =
  "  IF coalesce(current_setting('si.test_mark', true), '') <> '' THEN\n" +
  "    PERFORM set_config('application_name', current_setting('si.test_mark'), true);\n" +
  "    WHILE NOT pg_try_advisory_xact_lock(current_setting('si.test_key')::bigint) LOOP PERFORM pg_sleep(0.005); END LOOP;\n" +
  "  END IF;\n";

/** Takes the pause lock (session-level, held by `holder`) before the instrumented call is made. */
export async function armPause(holder, session, { mark, key }) {
  await holder.query('SELECT pg_advisory_lock($1::bigint)', [key]);
  await session.query(`SELECT set_config('si.test_mark', $1, false), set_config('si.test_key', $2, false)`, [mark, key]);
}
export async function releasePause(holder, { key }) {
  await holder.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
}
/** True iff session `pid` is inside the marked pause right now (its marker is set and it is polling the pause lock). */
export async function inMarkedPause(admin, pid, mark) {
  return (await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1 AND application_name = $2 AND state = 'active'`,
    [pid, mark])).rows[0].n === 1;
}
/** Diagnostic snapshot of sessions and their locks (kept in full in assertion messages). */
export async function snapshot(admin, pids) {
  const act = (await admin.query(`SELECT pid, usename, application_name, state, wait_event_type, wait_event, pg_blocking_pids(pid) AS blocked_by,
                                         left(query, 120) AS query FROM pg_stat_activity WHERE pid = ANY ($1) ORDER BY pid`, [pids])).rows;
  const locks = (await admin.query(`SELECT pid, locktype, coalesce(relation::regclass::text, '') AS rel, mode, granted, objid
                                      FROM pg_locks WHERE pid = ANY ($1) AND locktype IN ('relation', 'advisory', 'tuple', 'transactionid')
                                     ORDER BY pid, granted, locktype`, [pids])).rows;
  return JSON.stringify({ activity: act, locks });
}
/** Waits until `pid` is in the marked pause; throws with a full snapshot after `ms`. */
export async function awaitMarkedPause(admin, pid, mark, ms = 15000) {
  const t0 = performance.now();
  while (!(await inMarkedPause(admin, pid, mark))) {
    if (performance.now() - t0 > ms) throw new Error(`barrier: session ${pid} never reached the marked pause ${mark}: ${await snapshot(admin, [pid])}`);
    await sleep(5);
  }
}

/**
 * Starts `call()` (a control or any statement on `session`) and observes it until it is blocked by `holderPid`,
 * completes or fails. Returns { state: 'blocked' | 'completed' | 'failed', trace, result: Promise<settled> }.
 * trace lists every observed state in order (not-started, running, blocked, completed, failed).
 */
export async function observeCall(admin, { waiterPid, holderPid, call, ms = 15000 }) {
  let settledAs = null, value, error;
  const result = call().then(v => { settledAs = 'completed'; value = v; return { status: 'ok', value: v }; },
                             e => { settledAs = 'failed'; error = e; return { status: classifyError(e), code: e.code, message: e.message, detail: e.detail }; });   // = helpers.settle()
  const trace = [];
  const note = s => { if (trace[trace.length - 1] !== s) trace.push(s); };
  const t0 = performance.now();
  for (;;) {
    if (settledAs) { note(settledAs); return { state: settledAs, trace, result, value, error }; }
    const r = (await admin.query(`SELECT state, $2::int = ANY (pg_blocking_pids($1)) AS b FROM pg_stat_activity WHERE pid = $1`, [waiterPid, holderPid])).rows[0];
    if (settledAs) continue;                                   // completed while we sampled: report that, not the sample
    if (r?.b) { note('blocked'); return { state: 'blocked', trace, result }; }
    note(r?.state === 'active' ? 'running' : 'not-started');  // idle (query not yet received) is NOT completion
    if (performance.now() - t0 > ms) {
      throw new Error(`barrier: call on ${waiterPid} neither blocked by ${holderPid} nor settled in ${ms} ms; trace ${trace.join('>')}; ${await snapshot(admin, [waiterPid, holderPid])}`);
    }
    await sleep(1);
  }
}
