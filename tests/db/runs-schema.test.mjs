// Migration 0002, step 1: schema, CHECK constraints, IA-1 composite foreign keys, uniqueness.
// Step 1 has no write path for application roles and no triggers yet, so fixture rows are
// written as si_owner. Each negative case starts from a valid row and changes one thing.
// The lifecycle rules that need triggers (transitions, computed fields, receipts only for
// COMPLETED runs, errors only for FAILED runs) are steps 2-4 and are NOT asserted here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { asOwner, createSources, freshDatabase, recordRights, rejects, roles } from './helpers.mjs';

const CHECK = '23514', FK = '23503', UNIQUE = '23505';
let db, c;
const cleanups = [];
const fileScope = { after: fn => cleanups.push(fn) };
let VA, VA2, VB;                         // rights_version_id: source rs-a v1, rs-a v2, source rs-b v1
let keySeq = 0;
test.before(async () => {
  db = await freshDatabase(fileScope, 'runschema');
  c = await roles(fileScope, db, ['admin', 'si_rights_admin']);
  await createSources(c.admin, ['rs-a', 'rs-b']);
  VA = (await recordRights(c.si_rights_admin, 'rs-a')).rights_version_id;
  VA2 = (await recordRights(c.si_rights_admin, 'rs-a', { effective_from_sql: `clock_timestamp() + interval '1 hour'` })).rights_version_id;
  VB = (await recordRights(c.si_rights_admin, 'rs-b')).rights_version_id;
});
test.after(async () => { for (const fn of cleanups.reverse()) await fn(); });

const NOW = () => new Date().toISOString();
const LATER = () => new Date(Date.now() + 300_000).toISOString();
const SHA = 'a'.repeat(64);

/** A valid row of the given shape; `o` overrides columns. Each call uses a fresh request key. */
function row(shape, o = {}) {
  const base = { source_id: 'rs-a', request_key: `k-${++keySeq}`, request_sha256: SHA, attempt: 1,
                 conflict_policy: 'FAIL_RUN', start_control_seq: 0 };
  const shapes = {
    REJECTED_NO_RIGHTS: { status: 'REJECTED', outcome_code: 'NO_RIGHTS', rights_version_id: null, finished_at: NOW() },
    REJECTED_TERMINATED: { status: 'REJECTED', outcome_code: 'RIGHTS_TERMINATED', rights_version_id: VA, finished_at: NOW() },
    RUNNING: { status: 'RUNNING', rights_version_id: VA, lease_token: randomUUID(), lease_expires_at: LATER() },
    EMPTY: { status: 'COMPLETED', rights_version_id: VA, finished_at: NOW(), rights_checked_at: NOW(),
             retention_state: 'EMPTY', publish_control_seq: 0 },
    RETAINED: { status: 'COMPLETED', rights_version_id: VA, finished_at: NOW(), rights_checked_at: NOW(),
                retention_state: 'RETAINED', retain_until: LATER(), received_count: 3, published_count: 2,
                duplicate_count: 1, publish_control_seq: 0 },
    FAILED: { status: 'FAILED', rights_version_id: VA, outcome_code: 'LEASE_EXPIRED', finished_at: NOW() }
  };
  return { ...base, ...shapes[shape], ...o };
}
async function insertRun(r) {
  const cols = Object.keys(r);
  return asOwner(c.admin, x => x.query(
    `INSERT INTO si.collection_runs (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING run_id`,
    cols.map(k => r[k]))).then(res => res.rows[0].run_id);
}
async function insertAs(table, r) {
  const cols = Object.keys(r);
  return asOwner(c.admin, x => x.query(
    `INSERT INTO si.${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map(k => r[k])));
}
/** Expects a CHECK failure on one of the named constraints. */
async function refusedBy(r, names, code = CHECK) {
  const err = await rejects(assert, insertRun(r), { code });
  if (names) assert.ok([].concat(names).some(n => err.message.includes(n)), `expected ${names}, got: ${err.message}`);
}

test('S1: one valid row of every shape is accepted (REJECTED x2, RUNNING, COMPLETED EMPTY and RETAINED, FAILED)', async () => {
  for (const shape of ['REJECTED_NO_RIGHTS', 'REJECTED_TERMINATED', 'RUNNING', 'EMPTY', 'RETAINED', 'FAILED']) {
    assert.ok(await insertRun(row(shape)), shape);
  }
  assert.ok(await insertRun(row('FAILED', { outcome_code: 'VALIDATION_FAILED', error_count: 150 })), 'error_count may exceed the 100 stored errors');
  assert.ok(await insertRun(row('RETAINED', { conflict_policy: 'KEEP_FIRST', conflict_count: 1 })), 'KEEP_FIRST may record conflicts');
  assert.ok(await insertRun(row('EMPTY', { start_control_seq: 3, publish_control_seq: 7 })));
});

test('S2: 2.1 per-status shapes', async () => {
  await refusedBy(row('REJECTED_NO_RIGHTS', { finished_at: null }), 'runs_rejected_shape');
  await refusedBy(row('REJECTED_NO_RIGHTS', { received_count: 1 }), 'runs_rejected_shape');
  await refusedBy(row('REJECTED_TERMINATED', { lease_token: randomUUID() }), 'runs_rejected_shape');
  await refusedBy(row('RUNNING', { lease_token: null }), 'runs_running_shape');
  await refusedBy(row('RUNNING', { lease_expires_at: null }), 'runs_running_shape');
  await refusedBy(row('RUNNING', { finished_at: NOW() }), 'runs_running_shape');
  await refusedBy(row('RUNNING', { outcome_code: 'LEASE_EXPIRED' }), 'runs_running_shape');
  await refusedBy(row('RETAINED', { received_count: 4 }), 'runs_completed_shape');
  await refusedBy(row('EMPTY', { rights_checked_at: null }), 'runs_completed_shape');
  await refusedBy(row('EMPTY', { lease_token: randomUUID() }), 'runs_completed_shape');
  await refusedBy(row('EMPTY', { outcome_code: 'LEASE_EXPIRED' }), 'runs_completed_shape');
  await refusedBy(row('FAILED', { outcome_code: null }), 'runs_failed_shape');
  await refusedBy(row('FAILED', { finished_at: null }), 'runs_failed_shape');
  await refusedBy(row('FAILED', { published_count: 1, received_count: 1 }), 'runs_failed_shape');
  await refusedBy(row('RUNNING', { retention_state: 'RETAINED' }), ['runs_retention_iff_completed', 'runs_empty_iff']);
  await refusedBy(row('EMPTY', { retention_state: 'NONE' }), ['runs_retention_iff_completed', 'runs_empty_iff']);
  await refusedBy(row('RETAINED', { retention_state: 'PARTIALLY_PURGED' }), 'runs_first_purged');
  await refusedBy(row('RETAINED', { retention_state: 'PURGED', first_purged_at: NOW() }), 'runs_purged_at');
  await refusedBy(row('RETAINED', { purged_at: NOW() }), 'runs_purged_at');
});

test('S3: Amendment A2 EMPTY rules (E3 schema part)', async () => {
  await refusedBy(row('EMPTY', { received_count: 1, published_count: 1 }), 'runs_empty_iff_none_published');      // EMPTY + published > 0
  await refusedBy(row('EMPTY', { retain_until: LATER() }), 'runs_empty_iff_no_deadline');                         // EMPTY + deadline
  await refusedBy(row('RETAINED', { published_count: 0, received_count: 1, duplicate_count: 1 }),
    ['runs_empty_iff_none_published', 'runs_duplicates_cannot_empty']);                                            // RETAINED + 0 published
  await refusedBy(row('RETAINED', { retain_until: null }), 'runs_empty_iff_no_deadline');                         // RETAINED without deadline
  await refusedBy(row('EMPTY', { first_purged_at: NOW() }), 'runs_empty_final');
  await refusedBy(row('EMPTY', { retention_state: 'PURGED', first_purged_at: NOW(), purged_at: NOW() }), 'runs_empty_iff');   // EMPTY -> PURGED shape
});

test('S4 (EC1, EC2, error-count rule): D4 consistency constraints', async () => {
  // EC1: duplicates alone cannot produce an empty completion
  await refusedBy(row('EMPTY', { received_count: 3, duplicate_count: 3 }), 'runs_duplicates_cannot_empty');
  assert.ok(await insertRun(row('EMPTY', { received_count: 0, duplicate_count: 0 })));
  // EC2: FAIL_RUN never completes with conflicts
  await refusedBy(row('RETAINED', { conflict_count: 1 }), 'runs_fail_run_no_conflicts');
  // errors only on FAILED runs
  await refusedBy(row('REJECTED_NO_RIGHTS', { error_count: 1 }), 'runs_errors_only_failed');
  await refusedBy(row('RUNNING', { error_count: 1 }), 'runs_errors_only_failed');
  await refusedBy(row('EMPTY', { error_count: 1 }), ['runs_errors_only_failed', 'runs_completed_shape']);
});

test('S5 (Q2/D6): outcome codes are restricted per status; Q3 means no SOURCE_SUSPENDED rejection row', async () => {
  await refusedBy(row('REJECTED_TERMINATED', { outcome_code: 'SOURCE_SUSPENDED' }), 'runs_rejected_codes');
  await refusedBy(row('REJECTED_TERMINATED', { outcome_code: 'LEASE_EXPIRED' }), 'runs_rejected_codes');
  await refusedBy(row('FAILED', { outcome_code: 'NO_RIGHTS' }), 'runs_failed_codes');
  await refusedBy(row('FAILED', { outcome_code: 'EVALUATION_NOT_ALLOWED' }), 'runs_failed_codes');
  await refusedBy(row('FAILED', { outcome_code: 'NOT_A_CODE' }), 'outcome_code_check');
  for (const code of ['SOURCE_SUSPENDED', 'RIGHTS_TERMINATED', 'SOURCE_RETIRED', 'RIGHTS_CHANGED', 'RIGHTS_EXPIRING', 'LOCK_TIMEOUT', 'PERSISTENCE_ERROR']) {
    assert.ok(await insertRun(row('FAILED', { outcome_code: code })), `FAILED ${code}`);
  }
  for (const code of ['RIGHTS_EXPIRED', 'RIGHTS_EXPIRING', 'SOURCE_RETIRED', 'RETAIN_NOT_ALLOWED']) {
    assert.ok(await insertRun(row('REJECTED_TERMINATED', { outcome_code: code })), `REJECTED ${code}`);
  }
});

test('S6 (Amendment C): control-sequence columns', async () => {
  await refusedBy(row('EMPTY', { publish_control_seq: null }), 'runs_publish_seq_iff_completed');
  await refusedBy(row('RUNNING', { publish_control_seq: 0 }), 'runs_publish_seq_iff_completed');
  await refusedBy(row('FAILED', { publish_control_seq: 0 }), 'runs_publish_seq_iff_completed');
  await refusedBy(row('EMPTY', { start_control_seq: 5, publish_control_seq: 4 }), 'runs_publish_seq_after_start');
  await refusedBy(row('RUNNING', { start_control_seq: -1 }), 'start_control_seq_check');
  await refusedBy(row('RUNNING', { start_control_seq: null }), null, '23502');
});

test('S7 (IA1, IA1b): a run\'s rights version must belong to its source; NULL only for NO_RIGHTS rejections', async () => {
  await refusedBy(row('RUNNING', { rights_version_id: VB }), 'runs_ia1_rights_version_source', FK);         // version of another source
  await refusedBy(row('FAILED', { source_id: 'rs-b', rights_version_id: VA }), 'runs_ia1_rights_version_source', FK);
  await refusedBy(row('RUNNING', { rights_version_id: 999999 }), 'runs_ia1_rights_version_source', FK);     // unknown version
  assert.ok(await insertRun(row('RUNNING', { source_id: 'rs-b', rights_version_id: VB })));
  assert.ok(await insertRun(row('RUNNING', { rights_version_id: VA2 })), 'a scheduled version of the same source satisfies the FK');
  await refusedBy(row('REJECTED_TERMINATED', { outcome_code: 'RIGHTS_EXPIRED', rights_version_id: null }), 'runs_version_required');
  await refusedBy(row('FAILED', { rights_version_id: null }), ['runs_version_required', 'runs_running_shape']);
  await refusedBy(row('RUNNING', { rights_version_id: null }), ['runs_version_required', 'runs_running_shape']);
  await refusedBy(row('RUNNING', { source_id: 'no-such-source', rights_version_id: null }), null);          // FK / CHECK either way
});

test('S8: identity columns, attempt range and partial unique indexes', async () => {
  await refusedBy(row('RUNNING', { attempt: 0 }), 'attempt_check');
  await refusedBy(row('RUNNING', { attempt: 21 }), 'attempt_check');
  await refusedBy(row('RUNNING', { request_key: 'has space' }), 'request_key_check');
  await refusedBy(row('RUNNING', { request_key: 'x'.repeat(129) }), 'request_key_check');
  await refusedBy(row('RUNNING', { request_sha256: 'A'.repeat(64) }), 'request_sha256_check');
  await refusedBy(row('RUNNING', { conflict_policy: 'MERGE' }), 'conflict_policy_check');
  for (const col of ['received_count', 'published_count', 'duplicate_count', 'conflict_count', 'suppressed_count', 'error_count']) {
    await refusedBy(row('FAILED', { [col]: -1 }), `${col}_check`);
  }
  const key = 'same-key';
  await insertRun(row('RUNNING', { request_key: key, attempt: 1 }));
  await refusedBy(row('RUNNING', { request_key: key, attempt: 2 }), 'runs_one_running', UNIQUE);
  await refusedBy(row('FAILED', { request_key: key, attempt: 1 }), 'collection_runs_source_id_request_key_attempt_key', UNIQUE);
  assert.ok(await insertRun(row('FAILED', { request_key: key, attempt: 2 })), 'FAILED alongside RUNNING');
  assert.ok(await insertRun(row('EMPTY', { request_key: key, attempt: 3 })));
  await refusedBy(row('RETAINED', { request_key: key, attempt: 4 }), 'runs_one_completed', UNIQUE);
  assert.ok(await insertRun(row('RUNNING', { source_id: 'rs-b', rights_version_id: VB, request_key: key, attempt: 1 })), 'keys are per source');
});

test('S9 (IA1c, EC4 schema part): receipts name exactly their run\'s source and rights version', async () => {
  const run = await insertRun(row('EMPTY'));
  const runB = await insertRun(row('EMPTY', { source_id: 'rs-b', rights_version_id: VB }));
  const receipt = o => insertAs('publication_receipts', { run_id: run, source_id: 'rs-a', rights_version_id: VA, ...o });
  await rejects(assert, receipt({ rights_version_id: VA2 }), { code: FK, message: /receipts_match_run/ });             // other version, same source
  await rejects(assert, receipt({ source_id: 'rs-b', rights_version_id: VB }), { code: FK, message: /receipts_match_run|receipts_ia1/ });
  await rejects(assert, receipt({ source_id: 'rs-b' }), { code: FK, message: /receipts_match_run|receipts_ia1/ });       // version of another source
  await rejects(assert, receipt({ run_id: runB }), { code: FK, message: /receipts_match_run/ });                         // another run
  await rejects(assert, receipt({ run_id: randomUUID() }), { code: FK, message: /receipts_match_run/ });
  await rejects(assert, receipt({ within_validity: true }), { code: CHECK, message: /receipts_validity_needs_commit_ts/ });
  await receipt({});
  await rejects(assert, receipt({}), { code: UNIQUE });                                                                 // one per run
  await insertAs('publication_receipts', { run_id: runB, source_id: 'rs-b', rights_version_id: VB, commit_ts: NOW(), within_validity: true });
  const r = (await c.admin.query(`SELECT receipt_at IS NOT NULL AS stamped FROM si.publication_receipts WHERE run_id = $1`, [run])).rows[0];
  assert.equal(r.stamped, true);
});

test('S10: run_errors hold codes, indices and field names only', async () => {
  const run = await insertRun(row('FAILED', { outcome_code: 'VALIDATION_FAILED', error_count: 2 }));
  const err = o => insertAs('run_errors', { run_id: run, seq: 1, code: 'INVALID_TIMESTAMP', row_index: 0, field: 'seenAt', correlation_id: randomUUID(), ...o });
  await err({});
  await rejects(assert, err({}), { code: UNIQUE });
  for (const bad of [{ seq: 0 }, { seq: 101 }, { code: 'lowercase' }, { code: 'AB' }, { code: 'HAS SPACE' }, { row_index: -1 },
                     { field: 'rawPayload' }]) {
    await rejects(assert, err({ seq: 2, ...bad }), { code: CHECK });
  }
  await rejects(assert, err({ seq: 2, correlation_id: null }), { code: '23502' });
  await rejects(assert, err({ seq: 2, run_id: randomUUID() }), { code: FK });
  await err({ seq: 2, row_index: null, field: null });
  const cols = (await c.admin.query(`SELECT array_agg(attname::text ORDER BY attnum) AS c FROM pg_attribute
                                     WHERE attrelid = 'si.run_errors'::regclass AND attnum > 0 AND NOT attisdropped`)).rows[0].c;
  assert.deepEqual(cols, ['run_id', 'seq', 'code', 'row_index', 'field', 'correlation_id'], 'no free-text column exists');
});

test('step-1 scope: 0002 adds no functions and no user triggers yet', async () => {
  const fns = (await c.admin.query(`SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace = 'si'::regnamespace
                                      AND proname IN ('si_request_lock_key','si_complete_run','trg_runs_insert','trg_runs_transition',
                                                      'trg_runs_publish_check','trg_runs_no_delete')`)).rows[0].n;
  assert.equal(fns, 0);
  const trg = (await c.admin.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal
                                      AND tgrelid IN ('si.collection_runs'::regclass, 'si.publication_receipts'::regclass, 'si.run_errors'::regclass)`)).rows[0].n;
  assert.equal(trg, 0);
});
