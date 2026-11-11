// B-002 Milestone 3 part 3C (migration 0008, read entry point replaced by 0009 / M3-AUD-01): controlled
// internal evidence retrieval. Every read here first commits a read intent (si_begin_read). Real disposable
// PostgreSQL 16, synthetic sources only. Reader principals are cluster roles created by the test
// administrator through provisionReaderPrincipal (the documented provisioning path).
//
// Fixtures a product path cannot perform (labelled where used): superuser statements under
// session_replication_role = replica (aging a deadline, disturbing an identity, planting an INVALID
// verdict), and an instrumented copy of si_read_evidence in a disposable database that pauses inside its
// source lock (si.test_pause) to force interleavings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { asOwner, cfg, connect, control, createSources, freshDatabase, lift, pid, recordRights, rejects, roles, settle,
         waitUntilBlocked } from './helpers.mjs';
import { provisionReaderPrincipal } from '../../dist/persistence/bootstrap.js';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';
import { readEvidence, grantReader, revokeReader, ReadFailed, MAX_READ_BYTES } from '../../dist/persistence/reader.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const MIG7 = readFileSync(new URL('../../db/migrations/0007_receipt_verification.up.sql', import.meta.url), 'utf8');
// The read function as last defined (0010 replaces the 0009 read with the durability gate).
const MIG10 = readFileSync(new URL('../../db/migrations/0010_read_durability.up.sql', import.meta.url), 'utf8');
const ROLES = ['admin', 'si_rights_admin', 'si_collector', 'si_retention', 'si_monitor'];
const FIELDS = ['run_id', 'ordinal', 'collected_at', 'network', 'native_ad_id', 'advertiser_name', 'countries', 'seen_at', 'source_url',
                'title', 'source_reported_first_seen', 'source_reported_last_seen', 'content_sha256', 'next_cursor'];
let n = 0;

test.before(async () => {
  const a = await connect();
  try {
    for (const p of ['si_reader_alice', 'si_reader_bob', 'si_reader_carol']) await provisionReaderPrincipal(a, p, cfg.rolePassword);
    // A reader-named principal provisioned WITHOUT the session limits (to prove the read refuses it).
    if (!(await a.query(`SELECT 1 FROM pg_roles WHERE rolname = 'si_reader_lax'`)).rowCount) await a.query('CREATE ROLE si_reader_lax LOGIN');
    await a.query(`ALTER ROLE si_reader_lax PASSWORD ${a.escapeLiteral(cfg.rolePassword)}`);
    await a.query('GRANT si_reader TO si_reader_lax WITH INHERIT TRUE, SET FALSE, ADMIN FALSE');
  } finally { await a.end(); }
});

async function fresh(t, prefix = 'm3rd') {
  const db = await freshDatabase(t, prefix);
  const x = await roles(t, db, ROLES);
  const extra = [];
  t.after(async () => { for (const e of extra) await e.end().catch(() => {}); });
  Object.defineProperty(x, 'db', { value: db, enumerable: false });
  Object.defineProperty(x, 'connect', { enumerable: false, value: async user => { const k = await connect({ user, database: db }); extra.push(k); return k; } });
  return x;
}
const canary = () => `CANARY${randomBytes(8).toString('hex')}`;
const ROW = (id, o = {}) => ({ network: 'META', nativeAdId: id, advertiserName: 'Synthetic Co', countries: ['DE'],
  seenAt: '2026-01-01T00:00:00.000Z', sourceUrl: 'https://example.test/a', destinationUrl: 'https://example.test/dest',
  creativeUrl: 'https://example.test/creative', title: 'Synthetic title', ...o });
async function source(x, o = {}) {
  const id = `rd-${++n}`;
  await createSources(x.admin, [id], ['META', 'TIKTOK']);
  await recordRights(x.si_rights_admin, id, o.rights ?? {});
  return id;
}
const T2 = 'SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)';
async function collect(x, src, rows) {
  const networks = [...new Set(rows.map(r => r.network))].sort();
  const fx = fixtureSha256(rows), sha = requestSha256({ adapterId: src, evidenceKind: 'SYNTHETIC', networks, fixtureSha256: fx });
  const run = (await x.si_collector.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)',
    [src, `rk${++n}`, sha, 'SYNTHETIC', networks, fx])).rows[0];
  await x.si_collector.query('BEGIN');
  try { await x.si_collector.query(T2, [run.run_id, run.lease_token, JSON.stringify(rows)]); await x.si_collector.query('COMMIT'); }
  catch (e) { await x.si_collector.query('ROLLBACK').catch(() => {}); throw e; }
  return run;
}
const rows = (k, tag = 'r') => Array.from({ length: k }, (_, i) => ROW(`${tag}${++n}-${i}`));
const verify = x => x.si_monitor.query('SELECT * FROM si.si_verify_receipts(500)');
const grant = (x, p, src) => grantReader(x.si_rights_admin, p, src, 'internal synthetic evaluation (test)');
// Two statements: a committed intent (autocommit on `via`, by default the same session), then the read.
const BEGIN_READ = 'SELECT si.si_begin_read($1, $2, $3) AS id';
const READ = 'SELECT * FROM si.si_read_evidence($1, $2, $3, $4)';
const intent = async (c, src, cursor = null, limit = 100) => (await c.query(BEGIN_READ, [src, cursor, limit])).rows[0].id;
// Like the library, a fail-closed SI_READ_INTENT_NOT_DURABLE (unrelated unflushed WAL) is retried with a fresh intent,
// at most 3 attempts; every other outcome, and the last refusal, is returned or thrown unchanged.
const read = async (c, src, cursor = null, limit = 100, via = c) => {
  for (let attempt = 1; ; attempt++) {
    const id = await intent(via, src, cursor, limit);
    try { return (await c.query(READ, [src, id, cursor, limit])).rows; }
    catch (e) { if (attempt < 3 && /^SI_READ_INTENT_NOT_DURABLE/.test(String(e.message))) continue; throw e; }
  }
};
async function replica(x, sql, params) {
  await x.admin.query('BEGIN');
  try { await x.admin.query('SET LOCAL session_replication_role = replica'); await x.admin.query(sql, params); await x.admin.query('COMMIT'); }
  catch (e) { await x.admin.query('ROLLBACK').catch(() => {}); throw e; }
}
function serverLog() {
  const r = spawnSync('docker', ['compose', 'logs', '--no-color', 'db'], { cwd: REPO, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('cannot read the PostgreSQL server log');
  return `${r.stdout}${r.stderr}`;
}
const NOT_AUTH = { code: '42501', message: /^SI_READ_NOT_AUTHORIZED: not authorized$/ };
const BAD_CURSOR = { code: '22023', message: /^SI_READ_BAD_CURSOR/ };
function fnText(mig, startMarker, endMarker) {
  const s = mig.indexOf(startMarker);
  return mig.slice(s, mig.indexOf(endMarker, s) + endMarker.length).replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION');
}
function mutate(text, from, to) {
  assert.equal(text.split(from).length, 2, `exactly one anchor: ${from.slice(0, 60)}`);
  return text.replace(from, to);
}
const READ_FN = fnText(MIG10, 'CREATE OR REPLACE FUNCTION si.si_read_evidence', 'END $read_evidence$;');
const READABLE_FN = fnText(MIG7, 'CREATE FUNCTION si.si_evidence_readable', '$evidence_readable$;\n');
const PAUSE_ANCHOR = '    END IF;\n    FOR rec IN';
// The pause marks itself in application_name, so it cannot be confused with the durability gate's own short sleeps (0010).
const withPause = fn => mutate(fn, PAUSE_ANCHOR,
  `    END IF;\n    IF coalesce(nullif(current_setting('si.test_pause', true), ''), '0')::float8 > 0 THEN PERFORM set_config('application_name', 'si-test-paused', false); END IF;\n    PERFORM pg_sleep(coalesce(nullif(current_setting('si.test_pause', true), ''), '0')::float8);\n    FOR rec IN`);
/** A ready source with `k` verified records readable by alice. */
async function ready(x, k = 3) {
  const src = await source(x);
  const run = await collect(x, src, rows(k));
  await verify(x);
  await grant(x, 'si_reader_alice', src);
  return { src, run };
}

// ------------------------------------------------------------------------------------------------
test('RD-1: an authorized reader receives exactly the permitted fields of VALID synthetic evidence; access is audited', async t => {
  const x = await fresh(t);
  const src = await source(x);
  const run = await collect(x, src, [ROW('rd1-a', { title: 'T1' }), ROW('rd1-b', { network: 'TIKTOK' })]);
  const pending = await collect(x, src, [ROW('rd1-pending')]);
  await x.si_monitor.query(`SELECT * FROM si.si_verify_receipts(1)`);                 // only the first run is verified
  await grant(x, 'si_reader_alice', src);
  const alice = await x.connect('si_reader_alice');
  const got = await read(alice, src);
  assert.deepEqual(Object.keys(got[0]), FIELDS, 'exactly the permitted fields: no destination_url, no creative_url');
  assert.deepEqual(got.map(r => [r.run_id, r.ordinal, r.native_ad_id, r.network, r.title]),
    [[run.run_id, 0, 'rd1-a', 'META', 'T1'], [run.run_id, 1, 'rd1-b', 'TIKTOK', 'Synthetic title']]);
  assert.ok(!got.some(r => r.run_id === pending.run_id), 'unverified evidence is not returned');
  const truth = (await x.admin.query(`SELECT o.source_url, o.content_sha256, r.finished_at FROM si.observations o JOIN si.collection_runs r USING (run_id)
                                      WHERE o.run_id = $1 ORDER BY o.ordinal`, [run.run_id])).rows;
  assert.deepEqual(got.map(r => [r.source_url, r.content_sha256, r.collected_at.getTime()]),
    truth.map(r => [r.source_url, r.content_sha256, r.finished_at.getTime()]));
  const log = (await x.admin.query('SELECT principal, source_id, rows_returned, bytes_returned FROM si.reader_access_log')).rows;
  assert.deepEqual(log.map(l => [l.principal, l.source_id, l.rows_returned]), [['si_reader_alice', src, 2]]);
  assert.ok(log[0].bytes_returned > 0 && log[0].bytes_returned <= MAX_READ_BYTES);
});

test('RD-2: unauthorized principals and every service role get nothing; readers have no other privilege', async t => {
  const x = await fresh(t);
  const { src, run } = await ready(x);
  const bob = await x.connect('si_reader_bob');
  await rejects(assert, read(bob, src), NOT_AUTH);
  for (const role of ['si_collector', 'si_rights_admin', 'si_retention', 'si_monitor']) {
    await rejects(assert, read(x[role], src), { code: '42501', message: /permission denied for function si_begin_read/ });
    await rejects(assert, x[role].query(READ, [src, '00000000-0000-4000-8000-000000000000', null, 100]),
                  { code: '42501', message: /permission denied for function si_read_evidence/ });
  }
  const alice = await x.connect('si_reader_alice');
  for (const sql of ['SELECT 1 FROM si.observations', 'SELECT 1 FROM si.ads', 'SELECT 1 FROM si.receipt_verifications', 'SELECT 1 FROM si.reader_grants',
                     'SELECT 1 FROM si.reader_access_log', 'SELECT 1 FROM si.collection_runs', 'SELECT 1 FROM si.sources', 'DELETE FROM si.observations',
                     `SELECT si.si_evidence_readable('${run.run_id}')`, 'SELECT * FROM si.si_purge_due(1)', 'SELECT * FROM si.si_verify_receipts(1)',
                     `SELECT si.si_grant_reader('si_reader_alice', '${src}', 'x')`, `SELECT * FROM si.si_record_source_control('${src}', 'SUSPEND', 'x', NULL, NULL, NULL, NULL, NULL)`,
                     `SELECT * FROM si.si_begin_run('${src}', 'k', repeat('a', 64), 'SYNTHETIC', '{META}')`]) {
    await rejects(assert, alice.query(sql), { code: '42501' });
  }
  assert.equal((await read(alice, src)).length, 3);
});

test('RD-3: cross-source access and cross-source cursors are refused', async t => {
  const x = await fresh(t);
  const a = await ready(x, 3), b = await ready(x, 3);
  const other = await source(x);
  await collect(x, other, rows(2)); await verify(x);
  const alice = await x.connect('si_reader_alice');
  await rejects(assert, read(alice, other), NOT_AUTH);
  for (const s of ['rd-no-such-source', 'X', '', null, "rd'; --"]) await rejects(assert, read(alice, s), NOT_AUTH);
  const page = await read(alice, a.src, null, 1);
  await rejects(assert, read(alice, b.src, page[0].next_cursor), BAD_CURSOR);
  await rejects(assert, read(alice, other, page[0].next_cursor), BAD_CURSOR);
  assert.equal((await read(alice, a.src, page[0].next_cursor)).length, 2);
});

test('RD-4: missing, INVALID and UNVERIFIABLE verifications are never returned', async t => {
  const x = await fresh(t);
  const src = await source(x);
  const valid = await collect(x, src, rows(1, 'ok')), unver = await collect(x, src, rows(1, 'un')), inval = await collect(x, src, rows(1, 'in'));
  await replica(x, 'UPDATE si.publication_receipts SET receipt_at = receipt_at WHERE run_id = $1', [unver.run_id]);
  await x.si_monitor.query('SELECT * FROM si.si_verify_receipts(2)');                    // valid + unverifiable
  // Superuser fixture: an INVALID verdict (a real one needs a real deadline: slow job VR-2).
  await replica(x, `INSERT INTO si.receipt_verifications (run_id, source_id, rights_version_id, verdict, reason, commit_xid, commit_ts,
      window_start, window_end, verified_at, verified_by)
    SELECT r.run_id, r.source_id, r.rights_version_id, 'INVALID', 'COMMITTED_AFTER_WINDOW', 3, r.finished_at, r.finished_at - interval '1 hour',
           r.finished_at, clock_timestamp(), 'fixture' FROM si.collection_runs r WHERE r.run_id = $1`, [inval.run_id]);
  const pending = await collect(x, src, rows(1, 'pe'));
  await grant(x, 'si_reader_alice', src);
  const verdicts = (await x.admin.query('SELECT run_id, verdict FROM si.receipt_verifications')).rows;
  assert.equal(verdicts.length, 3);
  const alice = await x.connect('si_reader_alice');
  assert.deepEqual([...new Set((await read(alice, src)).map(r => r.run_id))], [valid.run_id], 'only the VALID run');
  assert.ok(pending.run_id);
});

test('RD-5/RD-6: expired, purged, suspended, terminated and retired evidence is refused; LIFT restores access', async t => {
  const x = await fresh(t);
  const alice = await x.connect('si_reader_alice');
  const cases = {};
  for (const k of ['ok', 'expired', 'purged', 'suspended', 'terminated', 'retired', 'revokedRights']) cases[k] = await ready(x, 2);
  await replica(x, `UPDATE si.collection_runs SET retain_until = clock_timestamp() - interval '1 minute' WHERE run_id = $1`, [cases.expired.run.run_id]);
  await replica(x, `UPDATE si.collection_runs SET retain_until = clock_timestamp() - interval '1 minute' WHERE run_id = $1`, [cases.purged.run.run_id]);
  for (;;) { const p = (await x.si_retention.query('SELECT * FROM si.si_purge_due(20)')).rows[0]; if (p.outcome !== 'PURGED') break; }
  await control(x.si_rights_admin, cases.suspended.src, 'SUSPEND');
  await control(x.si_rights_admin, cases.terminated.src, 'TERMINATE_RETENTION');
  await x.si_rights_admin.query('UPDATE si.sources SET retired_at = clock_timestamp() WHERE source_id = $1', [cases.retired.src]);
  await recordRights(x.si_rights_admin, cases.revokedRights.src, { retain: 'DENIED' });
  const got = {};
  for (const [k, v] of Object.entries(cases)) got[k] = (await read(alice, v.src)).length;
  assert.deepEqual(got, { ok: 2, expired: 0, purged: 0, suspended: 0, terminated: 0, retired: 0, revokedRights: 0 });
  await lift(x.si_rights_admin, cases.suspended.src);
  assert.equal((await read(alice, cases.suspended.src)).length, 2, 'after LIFT');
});

test('RD-7: grant and revocation semantics; revoked grants and their cursors are refused; grants cannot be forged', async t => {
  const x = await fresh(t);
  const { src } = await ready(x, 2);
  const alice = await x.connect('si_reader_alice');
  const page = await read(alice, src, null, 1);
  await rejects(assert, grant(x, 'si_reader_alice', src), { code: '23514', message: /^SI_READER_GRANT_EXISTS/ });
  await revokeReader(x.si_rights_admin, 'si_reader_alice', src, 'evaluation finished');
  await rejects(assert, read(alice, src), NOT_AUTH);
  await rejects(assert, read(alice, src, page[0].next_cursor), NOT_AUTH, 'a cursor is never a capability');
  await rejects(assert, revokeReader(x.si_rights_admin, 'si_reader_alice', src, 'again'), { code: '23514', message: /^SI_READER_GRANT_NOT_FOUND/ });
  await grant(x, 'si_reader_alice', src);
  assert.equal((await read(alice, src)).length, 2, 're-granted');
  const g = (await x.admin.query('SELECT principal, granted_by, revoked_by, revoke_reason FROM si.reader_grants ORDER BY grant_id')).rows;
  assert.deepEqual(g, [{ principal: 'si_reader_alice', granted_by: 'si_rights_admin', revoked_by: 'si_rights_admin', revoke_reason: 'evaluation finished' },
                       { principal: 'si_reader_alice', granted_by: 'si_rights_admin', revoked_by: null, revoke_reason: null }]);
  for (const p of ['si_monitor', 'si_reader', 'si_reader_nobody', 'si_bootstrap', 'si_reader_lax_', '']) {
    await rejects(assert, grantReader(x.si_rights_admin, p, src, 'x'), { code: '23514', message: /^SI_READER_GRANT_REFUSED/ });
  }
  await rejects(assert, grantReader(x.si_rights_admin, 'si_reader_bob', 'rd-missing', 'x'), { code: '23514', message: /^SI_READER_GRANT_REFUSED/ });
  for (const sql of [`UPDATE si.reader_grants SET reason = 'x'`, `UPDATE si.reader_grants SET revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL`,
                     'DELETE FROM si.reader_grants', 'TRUNCATE si.reader_grants']) {
    await rejects(assert, asOwner(x.admin, a => a.query(sql)), { code: '23514', message: /^SI_READER_GRANT_IMMUTABLE/ });
  }
  for (const role of ['si_collector', 'si_monitor', 'si_retention']) {
    await rejects(assert, x[role].query(`SELECT si.si_grant_reader('si_reader_bob', $1, 'x')`, [src]), { code: '42501' });
  }
  await rejects(assert, x.si_rights_admin.query(`INSERT INTO si.reader_grants (principal, source_id, purpose, reason, granted_by, granted_at)
                                                 VALUES ('si_reader_bob', $1, 'INTERNAL_SYNTHETIC_EVALUATION', 'x', 'x', now())`, [src]), { code: '42501' });
});

test('RD-8: malformed cursors are refused with a fixed code', async t => {
  const x = await fresh(t);
  const { src, run } = await ready(x, 2);
  const alice = await x.connect('si_reader_alice');
  const ok = (await read(alice, src, null, 1))[0].next_cursor;
  assert.match(ok, /^v1\|rd-\d+\|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\|[0-9a-f-]{36}\|0$/);
  const bad = ['garbage', '', 'v2' + ok.slice(2), ok.replace(/\|0$/, '|500'), ok.replace(/\|0$/, '|-1'), ok.replace(run.run_id, 'not-a-uuid'),
               ok.replace(/\d{4}-\d{2}-\d{2}/, '2026-13-45'), ok + '|extra', ok + 'x'.repeat(200), ok.replace('|', '||'), ok.toUpperCase()];
  for (const c of bad) await rejects(assert, read(alice, src, c), BAD_CURSOR);
});

test('RD-9: keyset pagination is deterministic, complete and without overlap', async t => {
  const x = await fresh(t);
  const src = await source(x);
  for (let i = 0; i < 3; i++) await collect(x, src, rows(7));
  await verify(x);
  await grant(x, 'si_reader_alice', src);
  const alice = await x.connect('si_reader_alice');
  const all = (await read(alice, src)).map(r => `${r.run_id}/${r.ordinal}`);
  assert.equal(all.length, 21);
  const paged = [];
  let cursor = null;
  for (;;) { const p = await readEvidence(alice, src, { cursor, limit: 5 }); if (!p.records.length) break; paged.push(...p.records.map(r => `${r.runId}/${r.ordinal}`)); cursor = p.nextCursor; }
  assert.deepEqual(paged, all, 'pages concatenate to the full ordered set');
  assert.deepEqual((await read(alice, src)).map(r => `${r.run_id}/${r.ordinal}`), all, 'repeatable');
  const later = await collect(x, src, rows(2)); await verify(x);
  const more = await readEvidence(alice, src, { cursor });
  assert.deepEqual(more.records.map(r => r.runId), [later.run_id, later.run_id], 'new evidence appears after the old cursor, in order');
});

test('RD-10: row and byte limits are enforced', async t => {
  const x = await fresh(t);
  const src = await source(x);
  await collect(x, src, rows(150));
  const heavy = await collect(x, src, Array.from({ length: 100 }, (_, i) => ROW(`hv${i}`, { title: '𝔸'.repeat(1000), advertiserName: '𝔹'.repeat(1000) })));
  await verify(x);
  await grant(x, 'si_reader_alice', src);
  const alice = await x.connect('si_reader_alice');
  for (const bad of [0, 101, null, -1]) await rejects(assert, read(alice, src, null, bad), { code: '22023', message: /^SI_READ_BAD_ARGUMENT/ });
  const first = await read(alice, src, null, 100);
  assert.equal(first.length, 100, 'at most 100 records');
  let cursor = first[99].next_cursor, seen = 100, pages = 0;
  for (;;) {
    const page = await read(alice, src, cursor, 100);
    if (!page.length) break;
    const bytes = (await x.admin.query('SELECT sum(octet_length(row_to_json(r)::text))::int AS b FROM jsonb_populate_recordset(NULL::si.evidence_read_row, $1::jsonb) r',
      [JSON.stringify(page)])).rows[0].b;
    assert.ok(bytes <= MAX_READ_BYTES, `page bytes ${bytes} <= ${MAX_READ_BYTES}`);
    seen += page.length; pages++; cursor = page[page.length - 1].next_cursor;
  }
  assert.equal(seen, 250, 'every record is reachable');
  assert.ok(pages >= 3, 'heavy records were split across pages by the byte cap');
  const caps = (await x.admin.query('SELECT max(bytes_returned) AS m, min(rows_returned) FILTER (WHERE rows_returned > 0) AS r FROM si.reader_access_log')).rows[0];
  assert.ok(caps.m <= MAX_READ_BYTES && caps.r < 100, 'some page was truncated below 100 records by bytes');
  assert.ok(heavy.run_id);
});

test('RD-11: evidence is absent from server and application logs; library errors are fixed codes', async t => {
  const x = await fresh(t);
  const mark = canary();
  const src = await source(x);
  await collect(x, src, [ROW(mark, { title: mark, advertiserName: mark, sourceUrl: `https://example.test/${mark}` })]);
  await verify(x);
  await grant(x, 'si_reader_alice', src);
  const alice = await x.connect('si_reader_alice'), bob = await x.connect('si_reader_bob');
  const out = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  for (const k of Object.keys(orig)) console[k] = (...a) => out.push(a.map(String).join(' '));
  let page, err;
  try {
    page = await readEvidence(alice, src);
    err = await readEvidence(bob, src).catch(e => e);
  } finally { Object.assign(console, orig); }
  assert.equal(page.records[0].nativeAdId, mark, 'the reader receives the record');
  assert.equal(out.length, 0, 'the library logged nothing');
  assert.ok(err instanceof ReadFailed);
  assert.deepEqual([err.message, err.code, err.sqlstate], ['READ_FAILED: NOT_AUTHORIZED', 'NOT_AUTHORIZED', '42501']);
  await sleep(200);
  const texts = [serverLog(), JSON.stringify((await x.admin.query('SELECT * FROM si.reader_access_log')).rows), String(err.stack)];
  assert.ok(!texts.some(s => s.includes(mark)), 'no evidence value in the server log, the access log or the error');
});

test('RD-12: no impersonation through SET ROLE, non-dedicated principals or service roles', async t => {
  const x = await fresh(t);
  const { src } = await ready(x, 2);
  const a = await connect();
  t.after(() => a.end());
  await a.query('GRANT si_reader_alice TO si_reader_carol');                      // carol may SET ROLE alice
  if (!(await a.query(`SELECT 1 FROM pg_roles WHERE rolname = 'evil_reader'`)).rowCount) await a.query('CREATE ROLE evil_reader LOGIN');
  await a.query(`ALTER ROLE evil_reader PASSWORD ${a.escapeLiteral(cfg.rolePassword)}`);
  await a.query('GRANT si_reader TO evil_reader WITH INHERIT TRUE');
  await a.query(`GRANT CONNECT ON DATABASE ${x.db} TO evil_reader`);
  try {
    const carol = await x.connect('si_reader_carol');
    await carol.query('SET ROLE si_reader_alice');
    assert.equal((await carol.query('SELECT current_user AS u, session_user AS s')).rows[0].u, 'si_reader_alice');
    await rejects(assert, read(carol, src), NOT_AUTH, 'the grant follows the login (session_user), not SET ROLE');
    const evil = await x.connect('evil_reader');
    await rejects(assert, read(evil, src), NOT_AUTH, 'not a dedicated si_reader_<name> principal');
    await rejects(assert, grantReader(x.si_rights_admin, 'evil_reader', src, 'x'), { code: '23514', message: /^SI_READER_GRANT_REFUSED/ });
    const fn = (await x.admin.query(`SELECT pg_get_function_identity_arguments('si.si_read_evidence'::regproc) AS a,
                                            pg_get_function_identity_arguments('si.si_begin_read'::regproc) AS b`)).rows[0];
    assert.deepEqual(fn, { a: 'p_source_id text, p_intent_id uuid, p_cursor text, p_limit integer', b: 'p_source_id text, p_cursor text, p_limit integer' },
                     'no caller-supplied principal');
  } finally {
    await a.query('REVOKE si_reader_alice FROM si_reader_carol');
    await a.query('REVOKE si_reader FROM evil_reader');
    await a.query(`REVOKE CONNECT ON DATABASE ${x.db} FROM evil_reader`);
  }
});

test('RD-13: sessions that could log or hold work unboundedly are refused', async t => {
  const x = await fresh(t);
  const { src } = await ready(x, 1);
  const lax = await x.connect('si_reader_lax');
  await rejects(assert, read(lax, src), { code: '55000', message: /^SI_READ_UNSAFE_SESSION: [a-z_]+$/ }, 'a principal provisioned without the session limits');
  const alice = await x.connect('si_reader_alice');
  for (const [k, v] of [['statement_timeout', '0'], ['statement_timeout', '1h'], ['idle_in_transaction_session_timeout', '0']]) {
    await alice.query(`SET ${k} = '${v}'`);
    await rejects(assert, read(alice, src), { code: '55000', message: new RegExp(`^SI_READ_UNSAFE_SESSION: ${k}$`) });
    await alice.query(`RESET ${k}`);
  }
  await rejects(assert, alice.query(`SET log_statement = 'all'`), { code: '42501' }, 'logging settings are superuser-only');
  await alice.query(`SET default_transaction_isolation = 'repeatable read'`);
  await rejects(assert, read(alice, src), { code: '25000', message: /^SI_ISOLATION/ });
  await alice.query('RESET default_transaction_isolation');
  assert.equal((await read(alice, src)).length, 1);
});

test('RD-14: collection, verification and purge are unchanged by grants and concurrent reads', async t => {
  const x = await fresh(t);
  const { src } = await ready(x, 2);
  const alice = await x.connect('si_reader_alice'), alice2 = await x.connect('si_reader_alice');
  await alice.query('BEGIN');
  assert.equal((await read(alice, src, null, 100, alice2)).length, 2, 'intent committed by another session of the same login');
  const run2 = await collect(x, src, rows(3));                                   // T2 while the reader's transaction is open
  assert.equal((await verify(x)).rows[0].valid, 1);
  await alice.query('COMMIT');
  assert.equal((await read(alice, src)).length, 5);
  await control(x.si_rights_admin, src, 'TERMINATE_RETENTION');
  let p; do { p = (await x.si_retention.query('SELECT * FROM si.si_purge_due(20)')).rows[0]; } while (p.outcome === 'PURGED' && p.purged_source !== src);
  assert.equal(p.purged_source, src);
  assert.equal((await read(alice, src)).length, 0);
  assert.ok(run2.run_id);
});

// ------------------------------------------------------------------------------------------------
// Forced interleavings (instrumented read pausing inside its source lock).
async function paused(x, src, who = 'si_reader_alice') {
  const c = await x.connect(who);
  const cp = await pid(c);
  const id = await intent(c, src);
  await c.query(`SET si.test_pause = '1.5'`);
  const done = { at: null };
  const p = settle(c.query(READ, [src, id, null, 100]).then(r => { done.at = performance.now(); return r.rows; }));
  for (let i = 0; ; i++) {
    const w = (await x.admin.query('SELECT wait_event, application_name FROM pg_stat_activity WHERE pid = $1', [cp])).rows[0];
    if (w?.wait_event === 'PgSleep' && w.application_name === 'si-test-paused') break;
    assert.ok(i < 300, 'the read reached its pause');
    await sleep(5);
  }
  return { c, cp, p, done };
}
async function instrumented(t) {
  const x = await fresh(t, 'm3rdc');
  await asOwner(x.admin, a => a.query(withPause(READ_FN)));
  return x;
}
const CHANGES = {
  'rights revocation': (x, c, src) => recordRights(c, src, { retain: 'DENIED' }),
  SUSPEND: (x, c, src) => control(c, src, 'SUSPEND'),
  TERMINATE: (x, c, src) => control(c, src, 'TERMINATE_RETENTION'),
  retirement: (x, c, src) => c.query('UPDATE si.sources SET retired_at = clock_timestamp() WHERE source_id = $1', [src]),
  'grant revocation': (x, c, src) => revokeReader(c, 'si_reader_alice', src, 'revoked during a read')
};

test('RC-1..RC-6: a change during a read waits for it; the read is consistent; the next read sees the change', async t => {
  const x = await instrumented(t);
  const results = [];
  for (const [name, change] of Object.entries(CHANGES)) {
    const { src } = await ready(x, 2);
    const ra = await x.connect('si_rights_admin');
    const rp = await pid(ra);
    const r = await paused(x, src);
    const t0 = performance.now();
    const ch = settle(change(x, ra, src).then(v => ({ v, at: performance.now() })));
    await waitUntilBlocked(x.admin, rp, r.cp, 3000);                            // the change waits for the read
    const got = await r.p, chg = await ch;
    assert.equal(got.status, 'ok', `${name}: ${got.message ?? ''}`);
    assert.equal(chg.status, 'ok', `${name}: ${chg.message ?? ''}`);
    assert.equal(got.value.length, 2, `${name}: the read returned the evidence authorized when it started`);
    assert.ok(chg.value.at - t0 >= 1000, `${name}: the change waited for the read (its pause inside the lock)`);
    await r.c.query('RESET si.test_pause');
    const after = await settle(read(r.c, src));
    assert.ok(after.status === 'db-error' ? after.code === '42501' : after.value.length === 0, `${name}: the next read sees the change`);
    results.push(`${name}: change waited ${(chg.value.at - t0).toFixed(0)} ms`);
  }
  // Purge: never waits for a read (SKIP LOCKED) — the held source is skipped (BUSY) and purged afterwards.
  for (;;) { const q = (await x.si_retention.query('SELECT * FROM si.si_purge_due(20)')).rows[0]; if (q.outcome !== 'PURGED') break; }   // drain earlier cases
  const { src, run } = await ready(x, 2);
  await control(x.si_rights_admin, src, 'TERMINATE_RETENTION');
  const r = await paused(x, src);
  assert.equal((await x.si_retention.query('SELECT * FROM si.si_purge_due(20)')).rows[0].outcome, 'BUSY');
  assert.equal((await r.p).value.length, 0, 'terminated before the read: nothing returned');
  let p; do { p = (await x.si_retention.query('SELECT * FROM si.si_purge_due(20)')).rows[0]; } while (p.outcome === 'PURGED' && p.purged_source !== src);
  assert.equal(p.purged_source, src);
  assert.ok(run.run_id);
  console.log(`# RC ${results.join('; ')}`);
});

test('RC-7: a change in progress makes a read wait (bounded), then the read sees it; past the bound the read is BUSY', async t => {
  const x = await fresh(t);
  const { src } = await ready(x, 2);
  const alice = await x.connect('si_reader_alice'), ra = await x.connect('si_rights_admin');
  const [ap, rp] = [await pid(alice), await pid(ra)];
  await ra.query('BEGIN');
  await control(ra, src, 'SUSPEND');
  const rd = settle(read(alice, src));
  await waitUntilBlocked(x.admin, ap, rp);
  await ra.query('COMMIT');
  assert.deepEqual([(await rd).status, (await rd).value.length], ['ok', 0], 'the read waited and saw the suspension');
  await lift(x.si_rights_admin, src);
  await ra.query('BEGIN');
  await control(ra, src, 'SUSPEND');
  const t0 = performance.now();
  const busy = await settle(read(alice, src));
  const waited = performance.now() - t0;
  await ra.query('ROLLBACK');
  assert.deepEqual([busy.status, busy.code], ['lock-timeout', '55P03']);
  assert.match(busy.message, /^SI_READ_BUSY/);
  assert.ok(waited < 3500, `bounded wait (${waited.toFixed(0)} ms, lock_timeout 2 s)`);
});

test('RC-8: reads versus receipt verification and versus retention expiry', async t => {
  const x = await fresh(t);
  const src = await source(x);
  const run = await collect(x, src, rows(2));
  await grant(x, 'si_reader_alice', src);
  const alice = await x.connect('si_reader_alice'), mon = await x.connect('si_monitor');
  await mon.query('BEGIN');
  await mon.query('SELECT * FROM si.si_verify_receipts(10)');
  assert.equal((await read(alice, src)).length, 0, 'an uncommitted VALID verdict is not visible');
  await mon.query('COMMIT');
  assert.equal((await read(alice, src)).length, 2, 'visible once committed');
  await replica(x, `UPDATE si.collection_runs SET retain_until = clock_timestamp() + interval '61 seconds' WHERE run_id = $1`, [run.run_id]);
  assert.equal((await read(alice, src)).length, 2, 'more than the 60 s margin left');
  await sleep(1500);
  assert.equal((await read(alice, src)).length, 0, 'inside the margin before the effective end: refused');
});

test('RC-9 (gates): an open reader transaction never holds the source; concurrent reads keep emergency controls fast', async t => {
  const x = await fresh(t);
  const srcs = [];
  for (let i = 0; i < 2; i++) srcs.push((await ready(x, 50)).src);
  const alice = await x.connect('si_reader_alice'), ra = await x.connect('si_rights_admin'), alice2 = await x.connect('si_reader_alice');
  await alice.query('BEGIN');
  assert.equal((await read(alice, srcs[0], null, 100, alice2)).length, 50);
  const t0 = performance.now();
  await control(ra, srcs[0], 'SUSPEND');                                         // the reader's transaction is still open
  const openTxnWait = performance.now() - t0;
  await alice.query('COMMIT');
  // Four readers loop on the second source while SUSPEND and TERMINATE are issued.
  const readers = [];
  for (let i = 0; i < 4; i++) readers.push(await x.connect('si_reader_alice'));
  let stop = false, reads = 0;
  const loops = readers.map(async c => { while (!stop) { await read(c, srcs[1]).catch(() => {}); reads++; } });
  await sleep(200);
  const waits = [];
  for (const kind of ['SUSPEND', 'TERMINATE_RETENTION']) { const s = performance.now(); await control(ra, srcs[1], kind); waits.push(performance.now() - s); }
  stop = true; await Promise.all(loops);
  console.log(`# RC-9 control with an open reader transaction: ${openTxnWait.toFixed(0)} ms; under ${reads} concurrent reads: ${waits.map(w => w.toFixed(0)).join(' / ')} ms`);
  assert.ok(openTxnWait < 1000, 'an open reader transaction does not hold the source lock');
  assert.ok(Math.max(...waits) < 2000, 'emergency controls stay fast under concurrent reads');
});

// ------------------------------------------------------------------------------------------------
// Negative-control mutants.
async function scnGrant(x) {                                 // detected = a principal whose grant was revoked reads
  const { src } = await ready(x, 1);
  await grant(x, 'si_reader_bob', src);
  const bob = await x.connect('si_reader_bob');
  const id = await intent(bob, src);                         // committed while the grant was active
  await revokeReader(x.si_rights_admin, 'si_reader_bob', src, 'revoked between intent and read');
  const r = await settle(bob.query(READ, [src, id, null, 100]).then(q => q.rows));
  return r.status === 'ok' && r.value.length > 0;
}
async function scnVerdict(x) {                               // detected = UNVERIFIABLE evidence is returned
  const src = await source(x);
  const run = await collect(x, src, rows(1));
  await replica(x, 'UPDATE si.publication_receipts SET receipt_at = receipt_at WHERE run_id = $1', [run.run_id]);
  await verify(x);
  await grant(x, 'si_reader_alice', src);
  return (await read(await x.connect('si_reader_alice'), src)).length > 0;
}
async function scnRetention(x) {                             // detected = evidence past its effective end is returned
  const { src, run } = await ready(x, 1);
  await replica(x, `UPDATE si.collection_runs SET retain_until = clock_timestamp() - interval '1 minute' WHERE run_id = $1`, [run.run_id]);
  return (await read(await x.connect('si_reader_alice'), src)).length > 0;
}
async function scnLock(x) {                                  // detected = a revocation commits while the read is paused inside its decision, and the read still returns rows
  const { src } = await ready(x, 2);
  const ra = await x.connect('si_rights_admin');
  const r = await paused(x, src);
  const t0 = performance.now();
  await revokeReader(ra, 'si_reader_alice', src, 'mid-read');
  const revokeWait = performance.now() - t0;                  // with the lock it waits for the 1.5 s pause
  const got = await r.p;
  return got.status === 'ok' && got.value.length > 0 && revokeWait < 1000;
}
async function scnCap(x) {                                   // detected = a page exceeds the byte cap
  const src = await source(x);
  await collect(x, src, Array.from({ length: 100 }, (_, i) => ROW(`cap${i}`, { title: '𝔸'.repeat(1000), advertiserName: '𝔹'.repeat(1000) })));
  await verify(x);
  await grant(x, 'si_reader_alice', src);
  const r = await settle(read(await x.connect('si_reader_alice'), src, null, 100));
  // Second, independent layer: the intent and access-log CHECKs refuse to record a page above the cap.
  if (r.status !== 'ok') return r.code === '23514' && /(read_intents|reader_access_log)_bytes_returned_check/.test(r.message);
  const page = r.value;
  const bytes = (await x.admin.query('SELECT sum(octet_length(row_to_json(r)::text))::int AS b FROM jsonb_populate_recordset(NULL::si.evidence_read_row, $1::jsonb) r',
    [JSON.stringify(page)])).rows[0].b;
  return bytes > MAX_READ_BYTES;
}
const MUTANTS = [
  { name: 'grant check omitted', scenario: scnGrant,
    sql: mutate(READ_FN, 'IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM si.reader_grants g', 'IF NOT FOUND OR false AND NOT EXISTS (SELECT 1 FROM si.reader_grants g') },
  { name: 'verdict check omitted', scenario: scnVerdict, sql: mutate(READABLE_FN, `SELECT rv.verdict = 'VALID'`, 'SELECT true') },
  { name: 'retention check omitted', scenario: scnRetention,
    sql: mutate(READABLE_FN, '       AND n.t + si.si_publish_margin() < si.si_effective_retention_end(r.source_id, v.version, r.retain_until)\n', '') },
  { name: 'source lock omitted', scenario: scnLock, pause: true,
    sql: mutate(withPause(READ_FN), 'PERFORM 1 FROM si.sources s WHERE s.source_id = p_source_id FOR SHARE;', 'PERFORM 1 FROM si.sources s WHERE s.source_id = p_source_id;') },
  { name: 'output byte cap omitted', scenario: scnCap, sql: mutate(READ_FN, '      EXIT WHEN bytes + sz > cap;\n', '') }
];
for (const m of MUTANTS) {
  test(`RD-M (${m.name}): the baseline passes the scenario and the targeted mutant is detected`, async t => {
    const bx = await fresh(t, 'm3rdmb');
    if (m.pause) await asOwner(bx.admin, a => a.query(withPause(READ_FN)));
    const base = await m.scenario(bx);
    const x = await fresh(t, 'm3rdmm');
    await asOwner(x.admin, a => a.query(m.sql));
    const killed = await m.scenario(x);
    console.log(`# RD-M ${m.name}: baseline ${base ? 'DETECTED (unexpected)' : 'clean'}, mutant ${killed ? 'KILLED' : 'SURVIVED'}`);
    assert.equal(base, false, `${m.name}: the unmutated code passes`);
    assert.equal(killed, true, `${m.name}: the mutant is detected`);
  });
}
