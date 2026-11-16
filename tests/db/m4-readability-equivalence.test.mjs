// B-002 M4-P3.0: set-based evidence readability (migration 0018) is EQUIVALENT to the authoritative oracle
// si_evidence_readable (0007, unchanged) — identical readable-run SETS, not merely identical search results.
// Real disposable PostgreSQL 16, synthetic sources only.
//
// Reference (the 0016 reader statement, verbatim, with the oracle):  the runs r of the source with COMPLETED, RETAINED,
//   published_count > 0, in the period, and si_evidence_readable(r) — evaluated at ONE instant t through
//   si_test_evidence_readable_at(run, t): a copy of the installed oracle whose only change is clock_timestamp() -> p_t
//   (asserted: exactly one occurrence; the copy's source equals the installed oracle's with that one substitution).
// Candidate: si_readable_runs_at(source, from, to, t) (0018; network statement replaced by 0019), as installed.
//
// Fixtures a product path cannot perform, labelled where used:
//   - ZOO: a disposable clone whose user triggers on sources, rights_versions, source_controls, collection_runs and
//     receipt_verifications are disabled and whose CHECK constraints on those tables are dropped, so that each trial
//     can set any combination of states (including ones the product cannot reach). Primary keys, unique keys, foreign
//     keys and NOT NULL stay, and evidence (ads, observations) is untouched: the ads network CHECK and the composite
//     foreign key observations_ad, on which 0018's network condition relies, are guarded by EQ-0. Each trial runs in a
//     transaction that is rolled back.
//   - replica-mode UPDATEs of retain_until / lease_expires_at in the product-path tests (a run's retention ending,
//     a lease expiring), as in m4-cold-identity.
//
//   EQ-0  the design's dependencies: no network literal in the candidate (0019); observations_ad
//         composite foreign key; NOT NULL network / ad_id; receipt_verifications primary key (run_id); 60 s margin;
//         the oracle copy is the installed oracle with exactly one substitution; the candidate is the active 0018 text.
//   EQ-1  product-path lifecycle at real time (every verdict, pending, EMPTY, FAILED/reaped, RUNNING, purged,
//         suspended/lifted, terminated, retired, retain revocation, rights expiry, network reduction, grant revocation):
//         real si_readable_runs == real oracle, and the injected-time versions agree, after every step.
//   EQ-2  scheduled rights changes and retention ends crossing in real time: exact agreement at the injected instant on
//         every sample; real-time disagreements only where a sample straddles a boundary (the documented single-instant
//         semantics), each explained.
//   EQ-3  concurrent publication, verification, purge, reaping and controls: on every REPEATABLE READ snapshot the
//         candidate equals the reference at the same instant.
//   EQ-4  ZOO: seeded randomized states (reproducible: SI_EQ_SEED, SI_EQ_TRIALS) at boundary instants (t, t ± 1 µs,
//         t ± margin) and periods: candidate == reference (multiset equality; no duplicates). Coverage of every verdict,
//         run status and retention state is asserted.
//   EQ-M  mutants of si_readable_runs_at (each condition removed or weakened, wrong rights version, missing retention,
//         wrong network predicates, missing source status, changed time comparisons, duplicating joins, unknown
//         evidence readable): each is killed on the EQ-4 states, and every disagreeing run is explained by the
//         mutant's intended reason (facts computed independently per run).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { latestDefinition } from './durability-fixtures.mjs';
import { asOwner, cfg, connect, control, createSources, freshDatabase, lift, recordRights, roles } from './helpers.mjs';
import { provisionReaderPrincipal } from '../../dist/persistence/bootstrap.js';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';
import { grantReader, revokeReader } from '../../dist/persistence/reader.js';

const ROLES = ['admin', 'si_rights_admin', 'si_collector', 'si_monitor', 'si_retention'];
const NETWORKS = ['META', 'TIKTOK', 'GOOGLE', 'PINTEREST', 'OTHER'];
let n = 0;
test.before(async () => { const a = await connect(); try { await provisionReaderPrincipal(a, 'si_reader_alice', cfg.rolePassword); } finally { await a.end(); } });

function mutate(text, from, to) { assert.equal(text.split(from).length, 2, `exactly one anchor: ${from.slice(0, 80)}`); return text.replace(from, to); }
const body = (text, tag) => { const a = text.indexOf(`AS ${tag}`) + `AS ${tag}`.length; return text.slice(a, text.indexOf(tag, a)); };

// The oracle: the installed si_evidence_readable (its latest migration text), and the injected-time copy.
const ORACLE = latestDefinition('si_evidence_readable', '$evidence_readable$;');
assert.equal(ORACLE.file, '0007_receipt_verification.up.sql', 'the oracle is the 0007 function, unchanged since');
assert.equal(ORACLE.text.split('clock_timestamp()').length, 2, 'the oracle reads the clock exactly once');
const ORACLE_AT = mutate(mutate(ORACLE.text, 'si.si_evidence_readable(p_run_id uuid)', 'si.si_test_evidence_readable_at(p_run_id uuid, p_t timestamptz)'),
  'clock_timestamp()', 'p_t');
// The reference: the 0016 readable-run statement (verbatim) with the injected-time oracle.
const MIG16 = readFileSync(new URL('../../db/migrations/0016_cold_query_reliability.up.sql', import.meta.url), 'utf8');
const STMT16 = (() => { const a = MIG16.indexOf('    SELECT coalesce(array_agg(r.run_id), '); return MIG16.slice(a, MIG16.indexOf(';', a)); })();
assert.equal(MIG16.split(STMT16).length, 3, 'the same readable-run statement in both 0016 functions');
const REFERENCE = `CREATE FUNCTION si.si_test_reference_runs_at(p_source_id text, p_from timestamptz, p_to timestamptz, p_t timestamptz) RETURNS uuid[]
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $ref$
${mutate(mutate(STMT16, ' INTO readable_runs', ''), 'si.si_evidence_readable(r.run_id)', 'si.si_test_evidence_readable_at(r.run_id, p_t)')}
$ref$;`;
// The candidate: the active definition of si_readable_runs_at.
const READABLE = latestDefinition('si_readable_runs_at', '$readable_runs_at$;');
const READABLE_FN = READABLE.text;

async function installInstruments(admin) {
  await asOwner(admin, async a => { await a.query(ORACLE_AT); await a.query(REFERENCE); });
}
async function fresh(t, prefix) {
  const db = await freshDatabase(t, prefix);
  const x = await roles(t, db, ROLES);
  Object.defineProperty(x, 'db', { value: db, enumerable: false });
  await installInstruments(x.admin);
  return x;
}
const AD = (id, network = 'META') => ({ network, nativeAdId: id, advertiserName: `Advertiser ${id.slice(0, 2)}`, countries: ['DE'],
  seenAt: '2026-01-01T00:00:00.000Z', sourceUrl: `https://example.test/${id}`, destinationUrl: 'https://example.test/d', creativeUrl: 'https://example.test/c', title: `Synthetic ${id}` });
async function begin(x, src, networks, rows = [], collector = x.si_collector) {
  const fx = fixtureSha256(rows), sha = requestSha256({ adapterId: src, evidenceKind: 'SYNTHETIC', networks, fixtureSha256: fx });
  return { fx, ...(await collector.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)', [src, `eq${++n}`, sha, 'SYNTHETIC', networks, fx])).rows[0] };
}
async function collect(x, src, rows, { verify = true, networks } = {}) {
  const nets = networks ?? [...new Set(rows.map(r => r.network))].sort();
  const run = await begin(x, src, nets.length ? nets : ['META'], rows);
  await x.si_collector.query('BEGIN');
  try { await x.si_collector.query('SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)', [run.run_id, run.lease_token, JSON.stringify(rows)]); await x.si_collector.query('COMMIT'); }
  catch (e) { await x.si_collector.query('ROLLBACK').catch(() => {}); throw e; }
  if (verify) await verifyAll(x);
  return run.run_id;
}
async function verifyAll(x) {
  for (let i = 0; i < 20; i++) { const r = await x.si_monitor.query('SELECT * FROM si.si_verify_receipts(500)'); if (!r.rows.length || Number(r.rows[0].verified) === 0) break; }
}
async function replica(x, sql, params) {
  await x.admin.query('BEGIN');
  try { await x.admin.query('SET LOCAL session_replication_role = replica'); await x.admin.query(sql, params); await x.admin.query('COMMIT'); }
  catch (e) { await x.admin.query('ROLLBACK').catch(() => {}); throw e; }
}
const sorted = a => [...a].sort();

/** Real time: the production si_readable_runs vs the real oracle in one statement, plus both at that statement's instant. */
async function compareNow(c, src, label, from = null, to = null) {
  const r = (await c.query(`SELECT clock_timestamp() AS t0, si.si_readable_runs($1, $2, $3) AS cand,
      ARRAY(SELECT r.run_id FROM si.collection_runs r WHERE r.source_id = $1 AND r.status = 'COMPLETED' AND r.retention_state = 'RETAINED'
              AND r.published_count > 0 AND ($2::timestamptz IS NULL OR (r.finished_at >= $2 AND r.finished_at < $3)) AND si.si_evidence_readable(r.run_id)) AS oracle,
      clock_timestamp() AS t1`, [src, from, to])).rows[0];
  assert.deepEqual(sorted(r.cand), sorted(r.oracle), `${label}: si_readable_runs == the real oracle (real time)`);
  const at = (await c.query('SELECT si.si_readable_runs_at($1, $2, $3, $4) AS cand, si.si_test_reference_runs_at($1, $2, $3, $4) AS ref',
    [src, from, to, r.t0])).rows[0];
  assert.deepEqual(sorted(at.cand), sorted(at.ref), `${label}: candidate == reference at the same instant`);
  assert.equal(new Set(r.cand).size, r.cand.length, `${label}: no duplicate run`);
  return sorted(r.cand);
}

// ------------------------------------------------------------------------------------------------
test('EQ-0: the dependencies of the set-based design hold, and the instruments are the installed functions', async t => {
  const x = await fresh(t, 'm4eq0');
  const q = async (sql, p) => (await x.admin.query(sql, p)).rows;
  // The candidate enumerates no network: it derives the values stored for the source's evidence (0019, condition A of
  // M4-P3.0-ACCEPT-01); an observation's network is its ad's (composite FK, below). The current domain, for the record:
  const [chk] = await q(`SELECT pg_get_constraintdef(c.oid) AS d FROM pg_constraint c WHERE c.conrelid = 'si.ads'::regclass AND c.contype = 'c'
                          AND pg_get_constraintdef(c.oid) LIKE '%network%'`);
  const domain = [...chk.d.matchAll(/'([A-Z]+)'::text/g)].map(m => m[1]);
  assert.deepEqual(domain, NETWORKS, 'ads.network CHECK domain');
  for (const nw of NETWORKS) assert.ok(!READABLE_FN.includes(`'${nw}'`), `the candidate does not name the network ${nw}`);
  assert.match(READABLE_FN, /NOT \(n\.net = ANY \(supported\)\)/, 'unsupported = the oracle\'s test on stored network values');
  const [fk] = await q(`SELECT pg_get_constraintdef(oid) AS d, confmatchtype, confdeltype FROM pg_constraint WHERE conname = 'observations_ad' AND conrelid = 'si.observations'::regclass`);
  assert.equal(fk.d, 'FOREIGN KEY (ad_id, source_id, network, native_ad_id) REFERENCES si.ads(ad_id, source_id, network, native_ad_id) ON DELETE RESTRICT');
  const nn = await q(`SELECT attname, attnotnull FROM pg_attribute WHERE attrelid = 'si.observations'::regclass AND attname IN ('ad_id','network','source_id','run_id') ORDER BY attname`);
  assert.ok(nn.every(a => a.attnotnull), 'observation ad_id, network, source_id, run_id are NOT NULL (the composite FK is always checked)');
  const [pk] = await q(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'si.receipt_verifications'::regclass AND contype = 'p'`);
  assert.equal(pk.d, 'PRIMARY KEY (run_id)', 'one verdict per run: the verdict join cannot duplicate a run');
  assert.equal((await q(`SELECT si.si_publish_margin()::text AS m`))[0].m, '00:01:00');
  // The instruments are the installed functions.
  const src = async name => (await q(`SELECT prosrc FROM pg_proc WHERE oid = $1::regprocedure`, [name]))[0].prosrc;
  const live = await src('si.si_evidence_readable(uuid)');
  assert.equal(live, body(ORACLE.text, '$evidence_readable$'), 'the oracle text used is the installed oracle');
  assert.equal(await src('si.si_test_evidence_readable_at(uuid,timestamptz)'), live.replace('clock_timestamp()', 'p_t'), 'the copy differs by exactly one substitution');
  assert.equal(await src('si.si_readable_runs_at(text,timestamptz,timestamptz,timestamptz)'), body(READABLE_FN, '$readable_runs_at$'), 'the candidate is the active text');
  assert.equal(READABLE.file, '0019_readability_hardening.up.sql');
  assert.doesNotMatch(READABLE_FN, /si_evidence_readable\s*\(/, 'the candidate never calls the oracle');
  // Both M4 readers call the candidate exactly once and never the oracle.
  for (const f of ['si.si_search_advertisers(text,uuid,text,text[],timestamptz,timestamptz,text,boolean,integer)',
                   'si.si_advertiser_history(text,uuid,text,text[],timestamptz,timestamptz,text,integer)']) {
    const s = await src(f);
    assert.equal(s.split('si.si_readable_runs(p_source_id, p_from, p_to)').length, 2, `${f}: one set-based evaluation`);
    assert.doesNotMatch(s, /si_evidence_readable\s*\(/, `${f}: no per-run oracle call`);
  }
  // si_read_evidence and si_read_source_status still use the oracle (unchanged callers).
  for (const f of ['si.si_read_evidence(uuid,uuid,uuid,integer)', 'si.si_read_source_status(text)']) {
    const p = (await q(`SELECT oid FROM pg_proc WHERE proname = $1 AND pronamespace = 'si'::regnamespace`, [f.slice(3, f.indexOf('('))]));
    assert.ok(p.length >= 1, `${f} exists`);
  }
});

// ------------------------------------------------------------------------------------------------
test('EQ-1: product-path lifecycle — after every step the set-based runs equal the oracle (real time and same instant)', async t => {
  const x = await fresh(t, 'm4eq1');
  const src = 'eq-life', other = 'eq-other';
  await createSources(x.admin, [src, other], ['META', 'TIKTOK', 'GOOGLE']);
  await recordRights(x.si_rights_admin, src, {}); await recordRights(x.si_rights_admin, other, {});
  await grantReader(x.si_rights_admin, 'si_reader_alice', src, 'm4-p3.0 equivalence');
  const c = x.admin;
  const step = async (label, expectSize) => { const s = await compareNow(c, src, label); if (expectSize !== undefined) assert.equal(s.length, expectSize, `${label}: readable runs`); return s; };
  await step('empty source', 0);
  const meta = await collect(x, src, [AD('m1'), AD('m2')]);
  const tiktok = await collect(x, src, [AD('t1', 'TIKTOK')]);
  const mixed = await collect(x, src, [AD('x1', 'META'), AD('x2', 'TIKTOK'), AD('x3', 'GOOGLE')]);
  await collect(x, other, [AD('o1')]);                                        // another source: never in this set
  await step('three VALID runs', 3);
  const pending = await collect(x, src, [AD('p1')], { verify: false });
  await step('a pending verdict is not readable', 3);
  await verifyAll(x);
  await step('verified', 4);
  const empty = await collect(x, src, [], { networks: ['META'] }).catch(e => e);
  await step(`EMPTY run (${empty instanceof Error ? empty.code : 'completed'})`, 4);
  const running = await begin(x, src, ['META']);
  await step('RUNNING run', 4);
  await replica(x, `UPDATE si.collection_runs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE run_id = $1`, [running.run_id]);
  assert.equal((await x.si_collector.query('SELECT si.si_reap_expired_runs(10) AS n')).rows[0].n, 1);
  await step('reaped (FAILED) run', 4);
  // INVALID and UNVERIFIABLE verdicts (fixture: the verifier's other outcomes, inserted as it would record them).
  const inv = await collect(x, src, [AD('i1')], { verify: false });
  const unv = await collect(x, src, [AD('u1')], { verify: false });
  await replica(x, `INSERT INTO si.receipt_verifications (run_id, source_id, rights_version_id, verdict, reason, commit_xid, commit_ts, window_start, window_end, verified_at, verified_by)
    SELECT r.run_id, r.source_id, r.rights_version_id, 'INVALID', 'COMMITTED_AFTER_WINDOW', 3, r.finished_at, r.finished_at - interval '1 hour', r.finished_at, clock_timestamp(), 'fixture'
      FROM si.collection_runs r WHERE r.run_id = $1`, [inv]);
  await replica(x, `INSERT INTO si.receipt_verifications (run_id, source_id, rights_version_id, verdict, reason, commit_xid, commit_ts, window_start, window_end, verified_at, verified_by)
    SELECT r.run_id, r.source_id, r.rights_version_id, 'UNVERIFIABLE', 'NO_EVIDENCE', NULL, NULL, r.finished_at - interval '1 hour', r.finished_at, clock_timestamp(), 'fixture'
      FROM si.collection_runs r WHERE r.run_id = $1`, [unv]);
  await step('INVALID and UNVERIFIABLE verdicts', 4);
  // Retention boundary (well away from the margin, real time) and purge.
  await replica(x, `UPDATE si.collection_runs SET retain_until = clock_timestamp() + interval '30 seconds' WHERE run_id = $1`, [pending]);
  await step('retain_until within the margin', 3);
  await replica(x, `UPDATE si.collection_runs SET retain_until = clock_timestamp() + interval '10 minutes' WHERE run_id = $1`, [pending]);
  await step('retain_until beyond the margin', 4);
  await replica(x, `UPDATE si.collection_runs SET retain_until = clock_timestamp() - interval '1 minute' WHERE run_id = $1`, [pending]);
  await step('retention ended, not yet purged', 3);
  for (;;) { const p = (await x.si_retention.query('SELECT * FROM si.si_purge_due(20)')).rows[0]; if (p.outcome !== 'PURGED') break; }
  assert.equal((await c.query('SELECT retention_state FROM si.collection_runs WHERE run_id = $1', [pending])).rows[0].retention_state, 'PURGED');
  await step('purged', 3);
  // Grant revocation does not change readability (the grant is checked separately, under the source lock).
  await revokeReader(x.si_rights_admin, 'si_reader_alice', src, 'm4-p3.0');
  await step('grant revoked', 3);
  // Network reduction: TIKTOK no longer supported -> the TIKTOK run and the mixed run are not readable.
  await asOwner(c, a => a.query(`UPDATE si.sources SET supported_networks = '{META,GOOGLE}' WHERE source_id = $1`, [src]));
  assert.deepEqual(await step('TIKTOK unsupported', 1), [meta]);
  await asOwner(c, a => a.query(`UPDATE si.sources SET supported_networks = '{META,TIKTOK,GOOGLE}' WHERE source_id = $1`, [src]));
  assert.deepEqual(await step('networks restored'), sorted([meta, tiktok, mixed]));
  // Suspend / lift.
  await control(x.si_rights_admin, src, 'SUSPEND');
  await step('suspended', 0);
  await lift(x.si_rights_admin, src);
  await step('lifted', 3);
  // Rights: a new version that denies retention ends data collected under earlier versions (retain revocation).
  await recordRights(x.si_rights_admin, src, { retain: 'DENIED', retention_days: null });
  await step('retain revoked by v2 (also: current version does not allow retention)', 0);
  await recordRights(x.si_rights_admin, src, {});
  await step('v3 allows again; v1 data stays ended', 0);
  const v3run = await collect(x, src, [AD('v3a')]);
  assert.deepEqual(await step('a v3 run is readable'), [v3run]);
  // Rights expiry within the margin.
  await recordRights(x.si_rights_admin, src, { expires_at_sql: "clock_timestamp() + interval '30 seconds'" });
  await step('current version expires within the margin', 0);
  await recordRights(x.si_rights_admin, src, { expires_at_sql: "clock_timestamp() + interval '1 day'" });
  await step('v5 expires in a day (v3 data still readable: v4 expiry ends only data collected under <= v4)');
  // Termination of retention.
  await control(x.si_rights_admin, src, 'TERMINATE_RETENTION');
  await step('retention terminated', 0);
  // Retirement (future, beyond the margin, then within).
  await asOwner(c, a => a.query(`UPDATE si.sources SET retired_at = clock_timestamp() + interval '1 day' WHERE source_id = $1`, [other]));
  assert.equal((await compareNow(c, other, 'other: retiring in a day')).length, 1);
  await asOwner(c, a => a.query(`UPDATE si.sources SET retired_at = clock_timestamp() + interval '30 seconds' WHERE source_id = $1`, [other]));
  assert.equal((await compareNow(c, other, 'other: retiring within the margin')).length, 0);
  // Periods: equal at the period boundaries.
  const fins = (await c.query(`SELECT finished_at FROM si.collection_runs WHERE source_id = $1 AND status = 'COMPLETED' ORDER BY finished_at`, [other])).rows;
  await compareNow(c, other, 'period', fins[0].finished_at, fins[0].finished_at);
});

// ------------------------------------------------------------------------------------------------
test('EQ-2: scheduled changes and retention ends crossing in real time — exact at the instant; real-time differences only straddle a boundary', async t => {
  const x = await fresh(t, 'm4eq2');
  const src = 'eq-clock';
  await createSources(x.admin, [src], ['META']);
  await recordRights(x.si_rights_admin, src, {});
  const runs = [];
  for (let i = 0; i < 6; i++) runs.push(await collect(x, src, [AD(`c${i}`)]));
  const c = x.admin;
  // Boundaries spread over the next ~5 s (each is a "becomes unreadable at E - 60 s" instant): per-run retain_until,
  // and a scheduled v2 (retain DENIED) whose effective_from closes v1's window and ends v1 data.
  const now = (await c.query('SELECT clock_timestamp() AS t')).rows[0].t;
  const ms = k => new Date(now.getTime() + k);
  const bounds = [];
  for (let i = 0; i < 4; i++) { const e = ms(60000 + 800 + i * 700); bounds.push(new Date(e.getTime() - 60000));
    await replica(x, 'UPDATE si.collection_runs SET retain_until = $2 WHERE run_id = $1', [runs[i], e]); }
  const v2 = ms(60000 + 4500); bounds.push(new Date(v2.getTime() - 60000), v2);
  await recordRights(x.si_rights_admin, src, { retain: 'DENIED', retention_days: null, effective_from_sql: `'${v2.toISOString()}'::timestamptz` });
  let exact = 0, straddles = 0, equal = 0;
  const sizes = new Set();
  const until = now.getTime() + 6500;
  while (Date.now() < until + 200) {
    const r = (await c.query(`SELECT clock_timestamp() AS t0, si.si_readable_runs($1, NULL, NULL) AS cand,
        ARRAY(SELECT r.run_id FROM si.collection_runs r WHERE r.source_id = $1 AND r.status = 'COMPLETED' AND r.retention_state = 'RETAINED'
                AND r.published_count > 0 AND si.si_evidence_readable(r.run_id)) AS oracle, clock_timestamp() AS t1`, [src])).rows[0];
    const at = (await c.query('SELECT si.si_readable_runs_at($1, NULL, NULL, $2) AS cand, si.si_test_reference_runs_at($1, NULL, NULL, $2) AS ref', [src, r.t0])).rows[0];
    assert.deepEqual(sorted(at.cand), sorted(at.ref), `exact agreement at ${r.t0.toISOString()}`); exact++;
    sizes.add(at.ref.length);
    if (JSON.stringify(sorted(r.cand)) === JSON.stringify(sorted(r.oracle))) { equal++; continue; }
    // A real-time difference: the oracle read the clock per run during [t0, t1]; it must straddle a known boundary.
    const t0 = r.t0.getTime() - 5, t1 = r.t1.getTime() + 5;                   // timestamps are microseconds; Date ms
    assert.ok(bounds.some(b => b.getTime() >= t0 && b.getTime() <= t1), `real-time difference at [${r.t0.toISOString()}, ${r.t1.toISOString()}] straddles a boundary`);
    straddles++;
  }
  console.log(`# EQ-2 samples ${exact}: exact at the instant ${exact}, real-time equal ${equal}, straddling a boundary ${straddles}; readable-set sizes seen ${[...sizes].sort().join(',')}`);
  assert.ok(sizes.size >= 4, 'the samples crossed the boundaries');
  assert.deepEqual(sorted((await c.query('SELECT si.si_readable_runs($1, NULL, NULL) AS a', [src])).rows[0].a), [], 'after v2: nothing readable');
});

// ------------------------------------------------------------------------------------------------
test('EQ-3: concurrent publication, verification, purge, reaping and controls — candidate == reference on every snapshot', async t => {
  const x = await fresh(t, 'm4eq3');
  const src = 'eq-conc';
  await createSources(x.admin, [src], ['META', 'TIKTOK']);
  await recordRights(x.si_rights_admin, src, {});
  for (let i = 0; i < 5; i++) await collect(x, src, [AD(`s${i}`), AD(`s${i}t`, 'TIKTOK')]);
  const reader = await connect({ database: x.db }), purger = await connect({ database: x.db });
  t.after(() => Promise.all([reader.end(), purger.end()]).catch(() => {}));
  const deadline = Date.now() + 8000;
  const counts = { publish: 0, purge: 0, reap: 0, controls: 0, snapshots: 0, sizes: new Set() };
  const reaper = await connect({ user: 'si_collector', database: x.db });
  t.after(() => reaper.end().catch(() => {}));
  const publisher = (async () => { while (Date.now() < deadline) {
    try { await collect(x, src, [AD(`p${n}a`), AD(`p${n}b`, n % 2 ? 'TIKTOK' : 'META')], { verify: n % 3 !== 0 }); counts.publish++; }
    catch { counts.rejected = (counts.rejected ?? 0) + 1; await new Promise(r => setTimeout(r, 20)); } }    // refused while suspended
    await verifyAll(x); })();
  const purging = (async () => {
    while (Date.now() < deadline) {
      await purger.query('BEGIN'); await purger.query('SET LOCAL session_replication_role = replica');
      await purger.query(`UPDATE si.collection_runs SET retain_until = clock_timestamp() - interval '1 minute'
                           WHERE run_id = (SELECT run_id FROM si.collection_runs WHERE source_id = $1 AND retention_state = 'RETAINED' ORDER BY random() LIMIT 1)`, [src]);
      await purger.query('COMMIT');
      const p = (await x.si_retention.query('SELECT * FROM si.si_purge_due(5)')).rows[0]; if (p.outcome === 'PURGED') counts.purge++;
      const r = await begin(x, src, ['META'], [], reaper).catch(e => ({ status: e.code }));          // refused while suspended
      if (r.status === 'RUNNING') {
        await purger.query('BEGIN'); await purger.query('SET LOCAL session_replication_role = replica');
        await purger.query(`UPDATE si.collection_runs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE run_id = $1`, [r.run_id]); await purger.query('COMMIT');
      }
      counts.reap += (await reaper.query('SELECT si.si_reap_expired_runs(10) AS n')).rows[0].n;
      await new Promise(res => setTimeout(res, 50));
    }
  })();
  const controlling = (async () => { while (Date.now() < deadline) { await control(x.si_rights_admin, src, 'SUSPEND'); await new Promise(r => setTimeout(r, 120));
    await lift(x.si_rights_admin, src); counts.controls++; await new Promise(r => setTimeout(r, 400)); } })();
  const reading = (async () => {
    while (Date.now() < deadline) {
      await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const tt = (await reader.query('SELECT clock_timestamp() AS t')).rows[0].t;
      const r = (await reader.query('SELECT si.si_readable_runs_at($1, NULL, NULL, $2) AS cand, si.si_test_reference_runs_at($1, NULL, NULL, $2) AS ref', [src, tt])).rows[0];
      await reader.query('COMMIT');
      assert.deepEqual(sorted(r.cand), sorted(r.ref), `snapshot ${counts.snapshots}: candidate == reference`);
      assert.equal(new Set(r.cand).size, r.cand.length);
      counts.snapshots++; counts.sizes.add(r.ref.length);
    }
  })();
  await Promise.all([publisher, purging, controlling, reading]);
  console.log(`# EQ-3 ${counts.snapshots} snapshots equal; concurrently ${counts.publish} publications, ${counts.purge} purges, ${counts.reap} reaped runs, ${counts.controls} suspend/lift cycles; ${counts.sizes.size} distinct set sizes (max ${Math.max(...counts.sizes)})`);
  assert.ok(counts.snapshots >= 50 && counts.publish >= 5 && counts.purge >= 3 && counts.reap >= 3 && counts.controls >= 3 && counts.sizes.size >= 3);
});

// ------------------------------------------------------------------------------------------------
// EQ-4 / EQ-M: the ZOO. A deterministic PRNG (mulberry32) drives every choice; the seed is printed.
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const B = '2030-06-01T00:00:00Z';
const OFF = ['-86400', '-3600', '-61', '-60.000001', '-60', '-59.999999', '-59', '-1', '-0.000001', '0', '0.000001', '1', '59', '59.999999', '60', '60.000001', '61', '3600', '86400'];
const T_OFF = ['0', '-60', '1', '-0.000001', '0.000001'];
const at = off => `(timestamptz '${B}' + interval '${off} seconds')`;

/** Mutants: [name, edit(text) -> text, reason(fact, ctx) -> the disagreement is explained]. */
const M = (from, to) => s => mutate(s, from, to);
const MUTANTS = [
  ['verdict condition removed', M("     AND (SELECT rv.verdict FROM si.receipt_verifications rv WHERE rv.run_id = r.run_id) = 'VALID'\n", ''), f => f.verdict !== 'VALID'],
  ['unknown (pending) verdict treated as readable', M("(SELECT rv.verdict FROM si.receipt_verifications rv WHERE rv.run_id = r.run_id) = 'VALID'",
    "coalesce((SELECT rv.verdict FROM si.receipt_verifications rv WHERE rv.run_id = r.run_id), 'VALID') = 'VALID'"), f => f.verdict === null],
  ['run status condition removed', M("r.status = 'COMPLETED' AND ", ''), f => f.status !== 'COMPLETED'],
  ['retention state condition removed', M(" AND r.retention_state = 'RETAINED'", ''), f => f.retention_state !== 'RETAINED'],
  ['published_count condition removed', M(' AND r.published_count > 0', ''), f => !(f.published_count > 0)],
  ['evidence kind condition removed', M("     AND s.evidence_kind = 'SYNTHETIC'\n", ''), f => f.evidence_kind !== 'SYNTHETIC'],
  ['retirement condition removed (missing source-status check)', M('     AND (s.retired_at IS NULL OR tm < s.retired_at)\n', ''), f => f.retired_blocks],
  ['retirement margin removed', M('tm < s.retired_at', 'p_t < s.retired_at'), f => f.retired_in_margin],
  ['retirement comparison < changed to <=', M('tm < s.retired_at', 'tm <= s.retired_at'), f => f.retired_eq],
  ['suspension condition removed (missing source-status check)', M('     AND NOT si.si_source_suspended(s.source_id)\n', ''), f => f.suspended],
  ['current rights condition removed', M('     AND EXISTS (SELECT 1 FROM si.rights_versions cur', '     AND EXISTS (SELECT 1 UNION ALL SELECT 1 FROM si.rights_versions cur'), f => !f.cur_ok],
  ['wrong rights version: latest version ignoring effective_from', M('WHERE m.source_id = s.source_id AND m.effective_from <= p_t)', 'WHERE m.source_id = s.source_id)'), f => f.scheduled],
  ['wrong rights version: first version instead of current', M('(SELECT max(m.version)', '(SELECT min(m.version)'), f => f.cur_version !== f.min_version],
  ['effective_from <= changed to <', s => mutate(mutate(s, 'cur.effective_from <= p_t', 'cur.effective_from < p_t'), 'm.effective_from <= p_t)', 'm.effective_from < p_t)'), f => f.version_at_t],
  ['current evaluation condition removed', M("cur.evaluation = 'ALLOWED' AND ", ''), f => f.cur_evaluation !== 'ALLOWED'],
  ['current retain condition removed', M(" AND cur.retain = 'ALLOWED'", ''), f => f.cur_retain !== 'ALLOWED'],
  ['rights window condition removed', M('\n                    AND tm < si.si_window_end(cur.rights_version_id)', ''), f => f.window_blocks],
  ['rights window margin removed', M('tm < si.si_window_end(', 'p_t < si.si_window_end('), f => f.window_in_margin],
  ['rights window comparison < changed to <=', M('tm < si.si_window_end(', 'tm <= si.si_window_end('), f => f.window_eq],
  ['retention termination condition removed', M(' AND NOT si.si_retention_terminated(p_source_id, v.version)', ''), f => f.terminated],
  ['retention condition removed (missing retention)', s => mutate(mutate(mutate(mutate(s, '     AND (r.retain_until IS NULL OR tm < r.retain_until)\n', ''),
      '(r.retain_until IS NOT NULL AND r.rights_version_id = ANY (versions_unbounded))', 'r.rights_version_id = ANY (versions_unbounded)'),
      'FILTER (WHERE e.retention_end IS NOT NULL AND tm < e.retention_end)', 'FILTER (WHERE false)'), 'FILTER (WHERE e.retention_end IS NULL)', 'FILTER (WHERE true)'), f => f.eff_blocks],
  ['retention: run retain_until ignored', s => mutate(mutate(s, '     AND (r.retain_until IS NULL OR tm < r.retain_until)\n', ''),
      '(r.retain_until IS NOT NULL AND r.rights_version_id = ANY (versions_unbounded))', 'r.rights_version_id = ANY (versions_unbounded)'), f => f.retain_until_blocks],
  ['retention: rights retention end ignored', s => mutate(mutate(s, 'FILTER (WHERE e.retention_end IS NOT NULL AND tm < e.retention_end)', 'FILTER (WHERE false)'),
      'FILTER (WHERE e.retention_end IS NULL)', 'FILTER (WHERE true)'), f => f.retention_end_blocks || f.retain_until_null],
  ['retention comparison < changed to <=', s => mutate(mutate(s, 'tm < e.retention_end', 'tm <= e.retention_end'), 'tm < r.retain_until', 'tm <= r.retain_until'), f => f.eff_eq],
  ['retention margin removed', s => mutate(mutate(s, 'tm < e.retention_end', 'p_t < e.retention_end'), 'tm < r.retain_until', 'p_t < r.retain_until'), f => f.eff_in_margin],
  ['network condition removed', M('\n     AND NOT (r.run_id = ANY (unsupported_runs))', ''), f => f.unsupported],
  ['incorrect network predicate: only the first unsupported network', M('a.network = ANY (unsupported_networks)', 'a.network = unsupported_networks[1]'), f => f.unsupported],
  ['incorrect network predicate: only the first observation of a run', M('JOIN si.observations o ON o.ad_id = a.ad_id', 'JOIN si.observations o ON o.ad_id = a.ad_id AND o.ordinal = 0'), f => f.unsupported],
  ['incorrect network predicate: supported read as unsupported', M('AND NOT (n.net = ANY (supported))', 'AND n.net = ANY (supported)'), f => f.unsupported || f.has_supported],
  ['network enumeration stops after the first stored value', M('FROM nets WHERE nets.net IS NOT NULL)', 'FROM nets WHERE false)'), f => f.unsupported],
  ['unknown network comparison (NULL in supported_networks) treated as unsupported', M('AND NOT (n.net = ANY (supported))', 'AND NOT coalesce(n.net = ANY (supported), false)'), f => f.unknown_network],
  ['period end inclusive', M('r.finished_at < p_to', 'r.finished_at <= p_to'), (f, c) => c.from !== null && f.finished_eq_to],
  ['period start exclusive', M('r.finished_at >= p_from', 'r.finished_at > p_from'), (f, c) => c.from !== null && f.finished_eq_from],
  ['source filter removed (runs of another source)', s => mutate(mutate(s, '   WHERE r.source_id = p_source_id AND r.status', '   WHERE r.status'),
      '   WHERE v.source_id = p_source_id AND NOT', '   WHERE NOT'), (f, c) => f.run_source !== c.src],
  ['unsafe join duplicating runs (one row per observation)', M('    FROM si.collection_runs r\n', '    FROM si.collection_runs r LEFT JOIN si.observations dup ON dup.run_id = r.run_id\n'), 'duplicate'],
  ['unsafe join duplicating runs (verdicts joined by source)', M('    FROM si.collection_runs r\n',
      "    FROM si.collection_runs r JOIN si.receipt_verifications rvs ON rvs.source_id = r.source_id AND rvs.verdict = 'VALID'\n"), 'duplicate'],
];
const mutantSql = (k, edit) => edit(READABLE_FN).replace('FUNCTION si.si_readable_runs_at(', `FUNCTION si.si_test_mutant_${k}(`);

const FACTS = `
  WITH p AS (SELECT $2::timestamptz AS t, $2::timestamptz + si.si_publish_margin() AS tm)
  SELECT r.run_id, r.source_id AS run_source, r.status, r.retention_state, r.published_count, rv.verdict, s.evidence_kind,
         coalesce(NOT (s.retired_at IS NULL OR p.tm < s.retired_at), true) AS retired_blocks,
         coalesce(s.retired_at > p.t AND s.retired_at <= p.tm, false) AS retired_in_margin,
         coalesce(s.retired_at = p.tm, false) AS retired_eq,
         si.si_source_suspended(r.source_id) AS suspended,
         coalesce(si.si_retention_terminated(r.source_id, v.version), true) AS terminated,
         coalesce(NOT (p.tm < least(r.retain_until, si.si_retention_end(r.source_id, v.version))), true) AS eff_blocks,
         coalesce(p.tm = least(r.retain_until, si.si_retention_end(r.source_id, v.version)), false) AS eff_eq,
         coalesce(least(r.retain_until, si.si_retention_end(r.source_id, v.version)) > p.t
                  AND least(r.retain_until, si.si_retention_end(r.source_id, v.version)) <= p.tm, false) AS eff_in_margin,
         coalesce(NOT (p.tm < r.retain_until), true) AS retain_until_blocks, r.retain_until IS NULL AS retain_until_null,
         coalesce(NOT (p.tm < si.si_retention_end(r.source_id, v.version)), false) AS retention_end_blocks,
         cur.version AS cur_version, cur.evaluation AS cur_evaluation, cur.retain AS cur_retain,
         (cur.version IS NOT NULL AND cur.evaluation = 'ALLOWED' AND cur.retain = 'ALLOWED' AND coalesce(p.tm < si.si_window_end(cur.rights_version_id), false)) AS cur_ok,
         coalesce(NOT (p.tm < si.si_window_end(cur.rights_version_id)), true) AS window_blocks,
         coalesce(si.si_window_end(cur.rights_version_id) > p.t AND si.si_window_end(cur.rights_version_id) <= p.tm, false) AS window_in_margin,
         coalesce(si.si_window_end(cur.rights_version_id) = p.tm, false) AS window_eq,
         EXISTS (SELECT 1 FROM si.rights_versions w WHERE w.source_id = r.source_id AND w.effective_from > p.t
                  AND w.version > coalesce(cur.version, 0)) AS scheduled,
         (SELECT min(w.version) FROM si.rights_versions w WHERE w.source_id = r.source_id AND w.effective_from <= p.t) AS min_version,
         EXISTS (SELECT 1 FROM si.rights_versions w WHERE w.source_id = r.source_id AND w.effective_from = p.t) AS version_at_t,
         EXISTS (SELECT 1 FROM si.observations o WHERE o.run_id = r.run_id AND NOT (o.network = ANY (s.supported_networks))) AS unsupported,
         EXISTS (SELECT 1 FROM si.observations o WHERE o.run_id = r.run_id AND o.network = ANY (s.supported_networks)) AS has_supported,
         EXISTS (SELECT 1 FROM si.observations o WHERE o.run_id = r.run_id AND (o.network = ANY (s.supported_networks)) IS NULL) AS unknown_network,
         coalesce(r.finished_at = $3, false) AS finished_eq_from, coalesce(r.finished_at = $4, false) AS finished_eq_to
    FROM si.collection_runs r CROSS JOIN p
    JOIN si.sources s ON s.source_id = r.source_id
    LEFT JOIN si.receipt_verifications rv ON rv.run_id = r.run_id
    LEFT JOIN si.rights_versions v ON v.rights_version_id = r.rights_version_id
    LEFT JOIN LATERAL (SELECT c.* FROM si.rights_versions c WHERE c.source_id = r.source_id AND c.effective_from <= p.t
                         AND c.version = (SELECT max(m.version) FROM si.rights_versions m WHERE m.source_id = r.source_id AND m.effective_from <= p.t)) cur ON true
   WHERE r.run_id = ANY ($1::uuid[])`;

async function buildZoo(t) {
  const x = await fresh(t, 'm4eqz');
  const c = x.admin;
  await asOwner(c, async a => { for (const [k, [, edit]] of MUTANTS.entries()) await a.query(mutantSql(k, edit)); });
  const sources = { 'eq-a': ['META', 'TIKTOK', 'GOOGLE'], 'eq-b': ['META', 'TIKTOK'], 'eq-c': NETWORKS };
  await createSources(c, ['eq-a'], sources['eq-a']); await createSources(c, ['eq-b'], sources['eq-b']); await createSources(c, ['eq-c'], sources['eq-c']);
  for (const s of Object.keys(sources)) {
    const nets = sources[s];
    await recordRights(x.si_rights_admin, s, {});
    for (let v = 0; v < 2; v++) {
      if (v === 1) await recordRights(x.si_rights_admin, s, {});
      await collect(x, s, [AD(`${s}${v}m1`), AD(`${s}${v}m2`)]);                               // single network
      await collect(x, s, [AD(`${s}${v}t1`, 'TIKTOK')]);
      await collect(x, s, [AD(`${s}${v}x1`), AD(`${s}${v}x2`, 'TIKTOK'), ...nets.slice(2).map((nw, i) => AD(`${s}${v}y${i}`, nw))]);   // mixed
      await collect(x, s, [AD(`${s}${v}x3`, 'TIKTOK'), AD(`${s}${v}x4`)]);                     // mixed, the unsupported one first
      if (nets.length > 2) await collect(x, s, [AD(`${s}${v}g1`, nets[2])]);
      await collect(x, s, [], { networks: ['META'] }).catch(() => {});                         // EMPTY (if the product allows)
      await begin(x, s, ['META']);                                                             // RUNNING
    }
  }
  await verifyAll(x);
  // ZOO fixture: user triggers off and CHECK constraints dropped on the five state tables (FK / PK / UNIQUE / NOT NULL stay).
  const TABLES = ['sources', 'rights_versions', 'source_controls', 'collection_runs', 'receipt_verifications'];
  for (const tb of TABLES) {
    await c.query(`ALTER TABLE si.${tb} DISABLE TRIGGER USER`);
    for (const { conname } of (await c.query(`SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'`, [`si.${tb}`])).rows)
      await c.query(`ALTER TABLE si.${tb} DROP CONSTRAINT ${conname}`);
  }
  const runs = (await c.query(`SELECT run_id, source_id, rights_version_id IS NOT NULL AS has_version FROM si.collection_runs ORDER BY source_id, started_at, run_id`)).rows;
  const versions = (await c.query(`SELECT rights_version_id, source_id, version FROM si.rights_versions ORDER BY source_id, version`)).rows;
  return { x, c, sources, runs, versions };
}

/** One trial: normalize, perturb (seeded), then compare at every instant and period. Inside a rolled-back transaction. */
async function trial(z, rand, onEval) {
  const { c, sources, runs, versions } = z;
  const pick = a => a[Math.floor(rand() * a.length)];
  const chance = p => rand() < p;
  const q = (sql, p) => c.query(sql, p);
  await q('BEGIN');
  try {
    // Normalized: everything readable, v1 then v2 in effect, runs finished one minute apart.
    await q(`UPDATE si.rights_versions SET evaluation = 'ALLOWED', retain = 'ALLOWED', expires_at = NULL,
               effective_from = timestamptz '${B}' - interval '1 day' * (3 - version)`);
    await q(`UPDATE si.collection_runs r SET retain_until = timestamptz '${B}' + interval '30 days',
               finished_at = CASE WHEN r.status = 'RUNNING' THEN NULL ELSE timestamptz '${B}' - interval '12 hours' + interval '1 minute' * o.k END
               FROM (SELECT run_id, row_number() OVER (ORDER BY source_id, started_at, run_id) AS k FROM si.collection_runs) o WHERE o.run_id = r.run_id`);
    // Sources.
    for (const [s, nets] of Object.entries(sources)) {
      const sup = chance(0.55) ? nets : chance(0.6) ? NETWORKS.filter(() => chance(0.6)) : pick([[], ['META', null], [null], ['FOO'], ['TIKTOK', 'META']]);
      await q(`UPDATE si.sources SET supported_networks = $2::text[], evidence_kind = $3, retired_at = ${chance(0.75) ? 'NULL' : at(pick(OFF))} WHERE source_id = $1`,
        [s, sup, chance(0.95) ? 'SYNTHETIC' : 'REAL']);
      let seq = 0;
      const nControls = pick([0, 0, 0, 1, 1, 2, 3]);
      for (let i = 0; i < nControls; i++) {
        const kind = pick(['SUSPEND', 'LIFT', 'TERMINATE_RETENTION', 'LIFT']);
        await q(`INSERT INTO si.source_controls (source_id, control_seq, kind, through_version, reason, occurred_at) VALUES ($1, $2, $3, $4, 'zoo', ${at(pick(OFF))})`,
          [s, ++seq, kind, kind === 'TERMINATE_RETENTION' ? pick([0, 1, 2, 3]) : null]);
      }
      if (chance(0.15)) await q(`INSERT INTO si.rights_versions (source_id, version, evaluation, retain, subscriber_display, media_mirror, export, retention_days, basis, change_reason, effective_from, expires_at)
          SELECT $1, 3, $2, $3, 'DENIED', 'DENIED', 'DENIED', 30, 'zoo', 'zoo', ${at(pick(OFF))}, ${chance(0.7) ? 'NULL' : at(pick(OFF))}`,
          [s, chance(0.6) ? 'ALLOWED' : pick(['DENIED', 'UNKNOWN']), chance(0.6) ? 'ALLOWED' : pick(['DENIED', 'UNKNOWN'])]);
    }
    for (const v of versions) {
      if (!chance(0.45)) continue;
      await q(`UPDATE si.rights_versions SET evaluation = $2, retain = $3, effective_from = ${chance(0.5) ? 'effective_from' : at(pick(OFF))},
                 expires_at = ${chance(0.6) ? 'NULL' : at(pick(OFF))} WHERE rights_version_id = $1`,
        [v.rights_version_id, chance(0.75) ? 'ALLOWED' : pick(['DENIED', 'UNKNOWN']), chance(0.75) ? 'ALLOWED' : pick(['DENIED', 'UNKNOWN'])]);
    }
    for (const r of runs) {
      if (chance(0.2)) await q(`UPDATE si.collection_runs SET status = $2 WHERE run_id = $1`, [r.run_id, pick(['REJECTED', 'RUNNING', 'COMPLETED', 'FAILED', 'COMPLETED'])]);
      if (chance(0.2)) await q(`UPDATE si.collection_runs SET retention_state = $2 WHERE run_id = $1`, [r.run_id, pick(['NONE', 'EMPTY', 'RETAINED', 'PARTIALLY_PURGED', 'PURGED'])]);
      if (chance(0.1)) await q(`UPDATE si.collection_runs SET published_count = $2 WHERE run_id = $1`, [r.run_id, pick([0, 1, 7])]);
      if (chance(0.3)) await q(`UPDATE si.collection_runs SET retain_until = ${chance(0.1) ? 'NULL' : at(pick(OFF))} WHERE run_id = $1`, [r.run_id]);
      if (chance(0.1)) await q(`UPDATE si.collection_runs SET finished_at = ${chance(0.3) ? 'NULL' : at(pick(OFF))} WHERE run_id = $1`, [r.run_id]);
      const roll = rand();
      if (roll < 0.1) await q('DELETE FROM si.receipt_verifications WHERE run_id = $1', [r.run_id]);
      else if (roll < 0.25) await q('UPDATE si.receipt_verifications SET verdict = $2 WHERE run_id = $1', [r.run_id, pick(['VALID', 'INVALID', 'UNVERIFIABLE'])]);
      else if (roll < 0.33 && r.has_version) await q(`INSERT INTO si.receipt_verifications (run_id, source_id, rights_version_id, verdict, reason, window_start, window_end, verified_at, verified_by)
          SELECT run_id, source_id, rights_version_id, 'VALID', 'COMMITTED_IN_WINDOW', started_at, started_at, started_at, 'zoo' FROM si.collection_runs WHERE run_id = $1
          ON CONFLICT (run_id) DO NOTHING`, [r.run_id]);
    }
    // Evaluate.
    const fin = (await q(`SELECT finished_at FROM si.collection_runs WHERE finished_at IS NOT NULL ORDER BY random() LIMIT 2`)).rows.map(r => r.finished_at).sort((a, b) => a - b);
    const periods = [[null, null], [fin[0] ?? null, fin[1] ?? null]];
    const cols = MUTANTS.map((_, k) => `si.si_test_mutant_${k}($1, $2, $3, $4) AS m${k}`).join(', ');
    for (const src of Object.keys(sources)) for (const toff of T_OFF) for (const [from, to] of periods) {
      const tt = (await q(`SELECT ${at(toff)} AS t`)).rows[0].t;
      const r = (await q(`SELECT si.si_test_reference_runs_at($1, $2, $3, $4) AS ref, si.si_readable_runs_at($1, $2, $3, $4) AS cand, ${cols}`, [src, from, to, tt])).rows[0];
      await onEval({ src, t: tt, from, to, r, q });
    }
    const states = (await q(`SELECT r.status, r.retention_state, coalesce(v.verdict, 'PENDING') AS verdict FROM si.collection_runs r
                               LEFT JOIN si.receipt_verifications v USING (run_id)`)).rows;
    return states;
  } finally { await q('ROLLBACK'); }
}

/** Multiset difference: elements of a not matched in b. */
function minus(a, b) { const m = new Map(); for (const v of b) m.set(v, (m.get(v) ?? 0) + 1); const out = []; for (const v of a) { const k = m.get(v) ?? 0; if (k > 0) m.set(v, k - 1); else out.push(v); } return out; }

test('EQ-4 / EQ-M: seeded randomized states at boundary instants — candidate == reference; every mutant killed for its intended reason', { timeout: 1800000 }, async t => {
  const z = await buildZoo(t);
  const seed = Number(process.env.SI_EQ_SEED ?? 20261114), trials = Number(process.env.SI_EQ_TRIALS ?? 120);
  const rand = rng(seed);
  const stats = { evals: 0, readable: 0, unreadable: 0, nonEmptyRefs: 0 };
  const killed = MUTANTS.map(() => ({ kills: 0, unexplained: [] }));
  const seen = { status: new Set(), retention_state: new Set(), verdict: new Set() };
  const runSources = new Map(z.runs.map(r => [r.run_id, r.source_id]));
  for (let i = 0; i < trials; i++) {
    const states = await trial(z, rand, async ({ src, t: tt, from, to, r, q }) => {
      stats.evals++;
      const ref = sorted(r.ref), cand = sorted(r.cand);
      assert.deepEqual(cand, ref, `seed ${seed} trial ${i}: candidate == reference (source ${src}, t ${tt.toISOString()}, period ${from?.toISOString() ?? '-'}..${to?.toISOString() ?? '-'})`);
      if (ref.length) stats.nonEmptyRefs++;
      const all = z.runs.filter(x => x.source_id === src).length;
      stats.readable += ref.length; stats.unreadable += all - ref.length;
      for (const [k, [, , reason]] of MUTANTS.entries()) {
        const mut = r[`m${k}`];
        const extra = minus(mut, ref), missing = minus(ref, mut);
        if (!extra.length && !missing.length) continue;
        killed[k].kills++;
        if (reason === 'duplicate') {
          if (missing.length || !extra.every(v => ref.includes(v))) killed[k].unexplained.push({ i, extra, missing });
          continue;
        }
        const ids = [...new Set([...extra, ...missing])];
        const facts = (await q(FACTS, [ids, tt, from, to])).rows;
        for (const f of facts) if (!reason(f, { src, from })) killed[k].unexplained.push({ i, run: f.run_id, src: runSources.get(f.run_id), dir: extra.includes(f.run_id) ? 'extra' : 'missing' });
      }
    });
    for (const s of states) { seen.status.add(s.status); seen.retention_state.add(s.retention_state); seen.verdict.add(s.verdict); }
  }
  console.log(`# EQ-4 seed ${seed}, ${trials} trials, ${stats.evals} comparisons (sources x instants x periods): all equal; readable run-evaluations ${stats.readable}, unreadable ${stats.unreadable}, non-empty sets ${stats.nonEmptyRefs}`);
  assert.ok(stats.readable > 0 && stats.unreadable > 0 && stats.nonEmptyRefs > stats.evals / 10, 'both outcomes are well represented');
  assert.deepEqual([...seen.status].sort(), ['COMPLETED', 'FAILED', 'REJECTED', 'RUNNING'], 'every run status');
  assert.deepEqual([...seen.retention_state].sort(), ['EMPTY', 'NONE', 'PARTIALLY_PURGED', 'PURGED', 'RETAINED'], 'every retention state');
  assert.deepEqual([...seen.verdict].sort(), ['INVALID', 'PENDING', 'UNVERIFIABLE', 'VALID'], 'every verdict and pending');
  for (const [k, [name]] of MUTANTS.entries()) {
    console.log(`# EQ-M ${name}: killed in ${killed[k].kills} comparisons, unexplained disagreements ${killed[k].unexplained.length}`);
  }
  // Mutants whose condition is decisive only in states the random trials may or may not draw are killed
  // deterministically elsewhere (named here); every other mutant must be killed on every seed.
  const DETERMINISTIC = { 'retention termination condition removed': 'EQ-7' };
  for (const [k, [name]] of MUTANTS.entries()) {
    if (killed[k].kills === 0 && DETERMINISTIC[name]) { console.log(`# EQ-M ${name}: not drawn by seed ${seed}; killed deterministically by ${DETERMINISTIC[name]}`); continue; }
    assert.ok(killed[k].kills > 0, `mutant "${name}" is killed`);
    assert.deepEqual(killed[k].unexplained.slice(0, 3), [], `mutant "${name}": every disagreement is explained by its intended reason`);
  }
});

// ------------------------------------------------------------------------------------------------
// M4-P3.0.1 (condition A of M4-P3.0-ACCEPT-01): the network domain is not assumed.
const M18 = readFileSync(new URL('../../db/migrations/0018_set_based_readability.up.sql', import.meta.url), 'utf8');
const F0018 = (() => { const a = M18.indexOf('CREATE FUNCTION si.si_readable_runs_at'); const e = '$readable_runs_at$;';
  return M18.slice(a, M18.indexOf(e, a) + e.length).replace('FUNCTION si.si_readable_runs_at(', 'FUNCTION si.si_test_f0018_runs_at('); })();
/** Observations whose composite references do not hold (what the FKs observations_ad / observations_run guarantee). */
const FK_AUDIT = readFileSync(new URL('../../db/ops/fk-audit.sql', import.meta.url), 'utf8');   // the file operations run (docs §14.9)
async function atNow(c, src) {
  const r = (await c.query(`SELECT clock_timestamp() AS t`)).rows[0];
  const v = (await c.query(`SELECT si.si_readable_runs_at($1, NULL, NULL, $2) AS cand, si.si_test_reference_runs_at($1, NULL, NULL, $2) AS ref,
      si.si_test_f0018_runs_at($1, NULL, NULL, $2) AS f0018`, [src, r.t])).rows[0];
  return { cand: sorted(v.cand), ref: sorted(v.ref), f0018: sorted(v.f0018) };
}

test('EQ-5: a network added to the domain later (simulated) is excluded unless supported — exactly as the oracle; the 0018 literal form is killed', async t => {
  const x = await fresh(t, 'm4eq5');
  const c = x.admin;
  await asOwner(c, a => a.query(F0018));
  const src = 'eq-snap';
  await createSources(c, [src], ['META']);
  await recordRights(x.si_rights_admin, src, {});
  const R1 = await collect(x, src, [AD('s1')]);
  const R2 = await collect(x, src, [AD('s2')]);
  const R3 = await collect(x, src, [AD('s3'), AD('s4')]);
  assert.deepEqual((await c.query(FK_AUDIT)).rows, [], 'fixture: all references hold');
  // Fixture: a later migration extends the domain (CHECKs of ads.network and of supported_networks), and evidence in
  // the new network exists — rows built consistent with every composite FK (asserted by FK_AUDIT); replica mode only
  // bypasses the append-only and completion triggers.
  for (const [tb, col] of [['ads', 'network'], ['sources', 'supported_networks']]) {
    const k = (await c.query(`SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE $2`, [`si.${tb}`, `%${col}%`])).rows;
    assert.equal(k.length, 1, `fixture: one ${tb}.${col} CHECK`);
    await c.query(`ALTER TABLE si.${tb} DROP CONSTRAINT ${k[0].conname}`);
  }
  await c.query(`ALTER TABLE si.ads ADD CONSTRAINT ads_network_check CHECK (network IN ('META','TIKTOK','GOOGLE','PINTEREST','OTHER','SNAP'))`);
  await c.query('BEGIN'); await c.query('SET LOCAL session_replication_role = replica');
  for (const [run, ord] of [[R2, 1], [R3, 2]]) {
    const ad = (await c.query(`INSERT INTO si.ads (source_id, network, native_ad_id, first_run_id) VALUES ($1, 'SNAP', $2, $3) RETURNING ad_id`, [src, `snap-${ord}-${run.slice(0, 8)}`, run])).rows[0].ad_id;
    await c.query(`INSERT INTO si.observations (run_id, source_id, rights_version_id, ordinal, ad_id, network, native_ad_id, advertiser_name, countries, seen_at, source_url, content_sha256)
        SELECT o.run_id, o.source_id, o.rights_version_id, $2, $3, 'SNAP', a.native_ad_id, o.advertiser_name, o.countries, o.seen_at, o.source_url, o.content_sha256
          FROM si.observations o JOIN si.ads a ON a.ad_id = $3 WHERE o.run_id = $1 AND o.ordinal = 0`, [run, ord, ad]);
  }
  await c.query('COMMIT');
  assert.deepEqual((await c.query(FK_AUDIT)).rows, [], 'fixture: the SNAP evidence satisfies every composite reference');
  let r = await atNow(c, src);
  console.log(`# EQ-5 source supports META: reference ${r.ref.length}, candidate ${r.cand.length}, 0018 form ${r.f0018.length}`);
  assert.deepEqual(r.ref, [R1], 'oracle: the runs with SNAP evidence are not readable (SNAP unsupported)');
  assert.deepEqual(r.cand, r.ref, 'candidate == oracle');
  assert.deepEqual(r.f0018, sorted([R1, R2, R3]), 'killed: the 0018 literal never lists SNAP and releases R2 and R3');
  await asOwner(c, a => a.query(`UPDATE si.sources SET supported_networks = '{META,SNAP}' WHERE source_id = $1`, [src]));
  r = await atNow(c, src);
  assert.deepEqual(r.ref, sorted([R1, R2, R3]), 'oracle: SNAP supported');
  assert.deepEqual(r.cand, r.ref, 'candidate == oracle');
  await asOwner(c, a => a.query(`UPDATE si.sources SET supported_networks = '{SNAP}' WHERE source_id = $1`, [src]));
  r = await atNow(c, src);
  assert.deepEqual(r.ref, [], 'oracle: META unsupported (every run has META evidence)');
  assert.deepEqual(r.cand, r.ref, 'candidate == oracle');
});

test('EQ-6: references bypassed (disposable adversarial fixture) — exact outcomes characterized; FK_AUDIT detects every such state', async t => {
  const x = await fresh(t, 'm4eq6');
  const c = x.admin;
  await asOwner(c, a => a.query(F0018));
  await createSources(c, ['fk-a'], ['META', 'TIKTOK']); await createSources(c, ['fk-b'], ['TIKTOK']);
  await recordRights(x.si_rights_admin, 'fk-a', {}); await recordRights(x.si_rights_admin, 'fk-b', {});
  const OK = await collect(x, 'fk-a', [AD('ok1')]);
  const [R1, R2, R3, R4] = [await collect(x, 'fk-a', [AD('r1')]), await collect(x, 'fk-a', [AD('r2')]), await collect(x, 'fk-a', [AD('r3')]), await collect(x, 'fk-a', [AD('r4')])];
  const B = await collect(x, 'fk-b', [AD('b1', 'TIKTOK')]);
  const T = await collect(x, 'fk-a', [AD('t1', 'TIKTOK')]);                      // a TIKTOK ad of fk-a (for case iv)
  assert.deepEqual((await c.query(FK_AUDIT)).rows, [], 'fixture: all references hold before the bypass');
  await asOwner(c, a => a.query(`UPDATE si.sources SET supported_networks = '{META}' WHERE source_id = 'fk-a'`));
  // Bypass (replica mode skips FK triggers): each case corrupts exactly one observation.
  await c.query('BEGIN'); await c.query('SET LOCAL session_replication_role = replica');
  await c.query(`UPDATE si.observations SET network = 'TIKTOK' WHERE run_id = $1`, [R1]);                        // (i) network differs from its ad's
  await c.query(`UPDATE si.observations o SET ad_id = b.ad_id, network = b.network, native_ad_id = b.native_ad_id
                   FROM si.observations b WHERE o.run_id = $1 AND b.run_id = $2`, [R2, B]);                         // (ii) another source's ad
  await c.query(`UPDATE si.observations SET ad_id = 999999999, network = 'TIKTOK' WHERE run_id = $1`, [R3]);     // (iii) dangling reference
  await c.query(`UPDATE si.observations o SET ad_id = t.ad_id, native_ad_id = t.native_ad_id
                   FROM si.observations t WHERE o.run_id = $1 AND t.run_id = $2`, [R4, T]);                         // (iv) META row on a TIKTOK ad of the source
  await c.query('COMMIT');
  const audit = (await c.query(FK_AUDIT)).rows.map(r => r.run_id);
  assert.deepEqual(sorted(audit), sorted([R1, R2, R3, R4]), 'FK_AUDIT finds exactly the four corrupted observations');
  const r = await atNow(c, 'fk-a');
  console.log(`# EQ-6 bypassed references: reference ${JSON.stringify(r.ref.map(v => [OK, R1, R2, R3, R4, T].indexOf(v)))}, candidate ${JSON.stringify(r.cand.map(v => [OK, R1, R2, R3, R4, T].indexOf(v)))}`);
  assert.deepEqual(r.ref, sorted([OK, R4]), 'oracle: R1-R3 carry TIKTOK observations (unsupported); R4 carries a META observation');
  assert.deepEqual(r.cand, sorted([OK, R1, R2, R3]),
    'candidate (characterized): the evidence path follows ad networks, so (i)-(iii) are released and (iv) is refused; exact only while the composite FKs hold');
  assert.deepEqual(r.f0018, r.cand, '0018 behaved identically: not a regression of 0019');
});

// ------------------------------------------------------------------------------------------------
// M4-P3.0.1-CLOSE-01: the termination condition, deterministically (M4-P3.0.1-ACCEPT-01 found its mutant killed or not
// depending on the EQ-4 seed). In product-reachable states the condition is redundant: a TERMINATE_RETENTION is recorded
// at its own clock time, which also ends the covered versions' retention (si_retention_end) — so the run is already
// refused by the retention condition. It is decisive only when the recorded termination time lies beyond t + margin.
// Fixture (labelled): a TERMINATE_RETENTION covering version 1 recorded at t + 1 day, followed by a LIFT, inserted with
// the control trigger disabled. The facts are asserted BEFORE the comparison, so a setup failure is never a kill.
test('EQ-7: the retention-termination mutant is killed deterministically, for its reason; the control case is not', async t => {
  const k = MUTANTS.findIndex(m => m[0] === 'retention termination condition removed');
  assert.ok(k >= 0, 'the mutant exists');
  for (const [label, through, killed] of [['covering termination', 1, true], ['control: termination of version 0 only', 0, false]]) {
    const x = await fresh(t, 'm4eq7');
    const c = x.admin;
    await asOwner(c, a => a.query(mutantSql(k, MUTANTS[k][1])));
    const src = 'eq-term';
    await createSources(c, [src], ['META']);
    await recordRights(x.si_rights_admin, src, {});
    const R = await collect(x, src, [AD('t1')]);
    const T = (await c.query(`SELECT clock_timestamp() AS t`)).rows[0].t;
    await c.query('BEGIN');
    await c.query('ALTER TABLE si.source_controls DISABLE TRIGGER USER');
    await c.query(`INSERT INTO si.source_controls (source_id, control_seq, kind, through_version, reason, occurred_at, wall_clock_at,
                                                   expected_max_version, expected_control_seq)
                   VALUES ($1, 1, 'TERMINATE_RETENTION', $2, 'fixture', $3::timestamptz + interval '1 day', $3::timestamptz, NULL, NULL),
                          ($1, 2, 'LIFT', NULL, 'fixture', $3::timestamptz, $3::timestamptz, 1, 1)`, [src, through, T]);
    await c.query('ALTER TABLE si.source_controls ENABLE TRIGGER USER');
    await c.query('COMMIT');
    const f = (await c.query(`SELECT si.si_retention_terminated($1, 1) AS terminated, si.si_source_suspended($1) AS suspended,
        coalesce(si.si_retention_end($1, 1) > $2::timestamptz + si.si_publish_margin(), true) AS retention_open,   -- NULL: no end
        si.si_window_end((SELECT rights_version_id FROM si.rights_versions WHERE source_id = $1 AND version = 1)) > $2::timestamptz + si.si_publish_margin() AS window_open`,
      [src, T])).rows[0];
    assert.deepEqual(f, { terminated: through >= 1, suspended: false, retention_open: true, window_open: true }, `${label}: fixture facts (not a kill if wrong)`);
    const r = (await c.query(`SELECT si.si_test_reference_runs_at($1, NULL, NULL, $2) AS ref, si.si_readable_runs_at($1, NULL, NULL, $2) AS cand,
        si.si_test_mutant_${k}($1, NULL, NULL, $2) AS mut`, [src, T])).rows[0];
    console.log(`# EQ-7 ${label}: reference ${r.ref.length}, candidate ${r.cand.length}, mutant ${r.mut.length}`);
    assert.deepEqual(sorted(r.cand), sorted(r.ref), `${label}: candidate == reference`);
    if (killed) {
      assert.deepEqual(r.ref, [], 'reference: the terminated version\'s run is refused');
      assert.deepEqual(r.mut, [R], 'killed for its reason: without the termination condition the run is released');
    } else {
      assert.deepEqual(r.ref, [R], 'control: version 1 is not terminated, the run is readable');
      assert.deepEqual(r.mut, r.ref, 'control: the mutant agrees where the condition is not decisive');
    }
  }
});
