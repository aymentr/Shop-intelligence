// B-002 M4-P3.0.1 (condition B of M4-P3.0-ACCEPT-01): si_readable_runs_at evaluates its statements on ONE snapshot.
// Real disposable PostgreSQL 16, synthetic sources only, READ COMMITTED (the readers' isolation level).
//
// Why STABLE matters: in PL/pgSQL a STABLE (or IMMUTABLE) function runs every statement on the snapshot of the
// statement that called it; a VOLATILE function takes a NEW snapshot for each of its statements under READ COMMITTED.
// si_readable_runs_at reads the source state (statement 1), the rights versions (2), the unsupported-network evidence
// (3) and the runs (4) separately. On mixed snapshots, a writer committing between them could make the result a
// combination that never existed in any committed state. EQ-3 (m4-readability-equivalence) runs under REPEATABLE
// READ, where every statement shares one snapshot whatever the volatility, so it cannot detect this.
//
// Fixtures a product path cannot perform, labelled where used:
//   - PAUSE: an instrumented COPY of the active si_readable_runs_at whose only change is one pg_sleep between
//     statements 1 and 2 (asserted: copy == active text + that line); the reader waits there while a writer commits.
//   - WRITER: one superuser transaction that removes TIKTOK from the source's supported networks AND records a VALID
//     verdict for a pending run (replica mode for the verdict row), so that the before and after states differ in two
//     statements at once.
//
//   SNAP-1   STABLE copy, writer commits during the pause: the result is exactly the BEFORE set (one snapshot), and a
//            new call afterwards returns exactly the AFTER set (the writer did commit).
//   SNAP-1v  the same through the VOLATILE wrapper si_readable_runs (the readers' entry point).
//   SNAP-M   VOLATILE mutant of the copy: returns exactly BEFORE ∪ AFTER-only, a set that never existed, releasing a
//            run the after-state refuses (unauthorized release) — killed; a setup failure is not counted as a kill.
//   SNAP-0   the catalog: the active si_readable_runs_at is STABLE (also asserted by privileges SD1/volatility).
import test from 'node:test';
import assert from 'node:assert/strict';
import { latestDefinition } from './durability-fixtures.mjs';
import { asOwner, cfg, connect, createSources, freshDatabase, recordRights, roles } from './helpers.mjs';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';

const ACTIVE = latestDefinition('si_readable_runs_at', '$readable_runs_at$;');
const PAUSE_AT = '  -- 2. Per rights version of the source, once each.\n';
const PAUSE = "  PERFORM pg_sleep(coalesce(nullif(current_setting('si.test_pause', true), ''), '0')::float);\n";
function mutate(text, from, to) { assert.equal(text.split(from).length, 2, `exactly one anchor: ${from.slice(0, 70)}`); return text.replace(from, () => to); }
const COPY = mutate(mutate(ACTIVE.text, PAUSE_AT, PAUSE + PAUSE_AT), 'FUNCTION si.si_readable_runs_at(', 'FUNCTION si.si_test_paused_runs_at(');
const VOLATILE_COPY = mutate(COPY, 'LANGUAGE plpgsql STABLE SECURITY INVOKER', 'LANGUAGE plpgsql VOLATILE SECURITY INVOKER');
const WRAPPER = `CREATE FUNCTION si.si_test_paused_runs(p_source_id text) RETURNS uuid[] LANGUAGE sql VOLATILE SET search_path = pg_catalog, pg_temp
  AS $w$ SELECT si.si_test_paused_runs_at(p_source_id, NULL, NULL, clock_timestamp()) $w$;`;
let n = 0;

const AD = (id, network) => ({ network, nativeAdId: id, advertiserName: 'Snapshot Synthetic', countries: ['DE'], seenAt: '2026-01-01T00:00:00.000Z',
  sourceUrl: `https://example.test/${id}`, destinationUrl: 'https://example.test/d', creativeUrl: 'https://example.test/c', title: `Synthetic ${id}` });
async function collect(x, src, rows, verify) {
  const networks = [...new Set(rows.map(r => r.network))].sort();
  const fx = fixtureSha256(rows), sha = requestSha256({ adapterId: src, evidenceKind: 'SYNTHETIC', networks, fixtureSha256: fx });
  const run = (await x.si_collector.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)', [src, `snap${++n}`, sha, 'SYNTHETIC', networks, fx])).rows[0];
  await x.si_collector.query('BEGIN');
  await x.si_collector.query('SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)', [run.run_id, run.lease_token, JSON.stringify(rows)]);
  await x.si_collector.query('COMMIT');
  if (verify) for (let i = 0; i < 20; i++) { const r = await x.si_monitor.query('SELECT * FROM si.si_verify_receipts(500)'); if (!r.rows.length || Number(r.rows[0].verified) === 0) break; }
  return run.run_id;
}
const sorted = a => [...a].sort();

/** One scenario: runs A (TIKTOK, VALID), C (META, VALID), B (META, pending). BEFORE = {A, C}; AFTER = {B, C}. */
async function scenario(t, { fnSql, call }) {
  const db = await freshDatabase(t, 'm4snap');
  const x = await roles(t, db, ['admin', 'si_rights_admin', 'si_collector', 'si_monitor']);
  const src = 'snap-a';
  await createSources(x.admin, [src], ['META', 'TIKTOK']);
  await recordRights(x.si_rights_admin, src, {});
  const A = await collect(x, src, [AD('a1', 'TIKTOK')], true);
  const C = await collect(x, src, [AD('c1', 'META')], true);
  const B = await collect(x, src, [AD('b1', 'META')], false);
  await asOwner(x.admin, async a => { await a.query(fnSql); await a.query(WRAPPER); });
  const before = sorted([A, C]), after = sorted([B, C]);
  const reader = await connect({ database: db });
  t.after(() => reader.end().catch(() => {}));
  await reader.query(`SET si.test_pause = '1.5'`);
  assert.equal((await reader.query('SHOW transaction_isolation')).rows[0].transaction_isolation, 'read committed');
  const readerPid = (await reader.query('SELECT pg_backend_pid() AS p')).rows[0].p;
  const pending = reader.query(call, [src]).then(r => ({ ok: r.rows[0].a }), e => ({ err: e }));
  // Barrier: the reader is inside the pause (statement 1 done, statements 2-4 not started).
  let paused = false;
  for (let i = 0; i < 200 && !paused; i++) {
    paused = (await x.admin.query(`SELECT wait_event = 'PgSleep' AS s FROM pg_stat_activity WHERE pid = $1`, [readerPid])).rows[0]?.s === true;
    if (!paused) await new Promise(r => setTimeout(r, 10));
  }
  assert.ok(paused, 'fixture: the reader reached the pause');
  // WRITER: one transaction changes the source's networks and records B's VALID verdict.
  await x.admin.query('BEGIN');
  await x.admin.query(`UPDATE si.sources SET supported_networks = '{META}' WHERE source_id = $1`, [src]);
  await x.admin.query('SET LOCAL session_replication_role = replica');
  await x.admin.query(`INSERT INTO si.receipt_verifications (run_id, source_id, rights_version_id, verdict, reason, commit_xid, commit_ts, window_start, window_end, verified_at, verified_by)
      SELECT r.run_id, r.source_id, r.rights_version_id, 'VALID', 'COMMITTED_IN_WINDOW', 3, r.finished_at, r.finished_at - interval '1 hour', r.finished_at + interval '1 hour', clock_timestamp(), 'fixture'
        FROM si.collection_runs r WHERE r.run_id = $1`, [B]);
  await x.admin.query('COMMIT');
  const stillPaused = (await x.admin.query(`SELECT wait_event = 'PgSleep' AS s FROM pg_stat_activity WHERE pid = $1`, [readerPid])).rows[0]?.s === true;
  assert.ok(stillPaused, 'fixture: the writer committed while the reader was still paused');
  const got = await pending;
  if (got.err) throw new Error(`fixture: the reader failed (${got.err.code}: ${got.err.message}); not counted as a kill`);
  const fresh = sorted((await reader.query(call, [src])).rows[0].a);
  return { got: sorted(got.ok), fresh, before, after, A, B, C };
}
const CALL_AT = 'SELECT si.si_test_paused_runs_at($1, NULL, NULL, clock_timestamp()) AS a';
const CALL_WRAPPED = 'SELECT si.si_test_paused_runs($1) AS a';

test('SNAP-0: the copy is the active text plus one pause; the active function is STABLE', async t => {
  assert.ok(ACTIVE.file >= '0019', `the active definition is from 0019 or later (${ACTIVE.file})`);
  assert.equal(COPY.replace(PAUSE, '').replace('si.si_test_paused_runs_at(', 'si.si_readable_runs_at('), ACTIVE.text, 'only the pause differs');
  assert.match(ACTIVE.text, /LANGUAGE plpgsql STABLE SECURITY INVOKER/);
  const db = await freshDatabase(t, 'm4snap0');
  const x = await roles(t, db, ['admin']);
  const v = (await x.admin.query(`SELECT provolatile FROM pg_proc WHERE oid = 'si.si_readable_runs_at(text,timestamptz,timestamptz,timestamptz)'::regprocedure`)).rows[0].provolatile;
  assert.equal(v, 's', 'installed si_readable_runs_at is STABLE');
});

for (const [name, call] of [['SNAP-1', CALL_AT], ['SNAP-1v', CALL_WRAPPED]]) {
  test(`${name}: STABLE, READ COMMITTED, a writer commits between the statements — the result is exactly one snapshot`, async t => {
    const r = await scenario(t, { fnSql: COPY, call });
    console.log(`# ${name} returned ${r.got.length} runs; before ${r.before.length}, after ${r.after.length}`);
    assert.deepEqual(r.got, r.before, 'the call returns exactly the state at its start');
    assert.deepEqual(r.fresh, r.after, 'the writer committed: a new call returns exactly the after-state');
  });
}

test('SNAP-M: VOLATILE mutant — mixed snapshots release a run neither state allows together; killed', async t => {
  const r = await scenario(t, { fnSql: VOLATILE_COPY, call: CALL_AT });
  const mixed = sorted([r.A, r.B, r.C]);
  console.log(`# SNAP-M VOLATILE copy returned ${r.got.length} runs (mixed = ${JSON.stringify(r.got) === JSON.stringify(mixed)})`);
  assert.deepEqual(r.fresh, r.after, 'fixture: the writer committed');
  assert.notDeepEqual(r.got, r.before, 'killed: the result is not the start-state');
  assert.notDeepEqual(r.got, r.after, 'and not the after-state');
  assert.deepEqual(r.got, mixed, 'intended reason: statement 1 saw the old networks, statement 4 the new verdict — A (TIKTOK) released with B');
});
