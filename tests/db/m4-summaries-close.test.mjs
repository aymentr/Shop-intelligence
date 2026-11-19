// B-002 M4-P3.1-CLOSE-01: conditions C1-C3 of M4-P3.1-ACCEPT-01. Real disposable PostgreSQL 16, synthetic sources only.
//
//   CV-1  C1 eligibility equivalence: the 0021 si_summary_coverage returns exactly what the 0020 function returns
//         (installed side by side as si_test_coverage_0020) over seeded randomized states (SI_CV_SEED, SI_CV_TRIALS):
//         missing status, stale fingerprint, open / cleared drift, purged, EMPTY and RUNNING runs, several
//         sources. Each reason (DRIFT, INCOMPLETE, both, none) is reached (asserted).
//   CV-2  C1 the fingerprint is evaluated once per call (statement count, not timing).
//   CC-*  C2 controls. Each runs its scenario on the installed functions (baseline: exactly the stated outcome, with its
//         preconditions asserted) and with one function replaced by a mutant (exactly the defect). A fixture failure
//         throws: it is never counted as a kill.
//     CC-MX5   the commit-time summary check is what refuses an owner completion without a summary
//     CC-MX13  ... and an owner completion whose status does not count every observation
//     CC-MX4   verification reports a fabricated extra summary row even when the status is forged to match it
//     CC-MX12  verification reports an orphan identity
//     CC-MX7   a purge that commits while backfill waits for the source lock is not resurrected (genuinely unbackfilled run)
//     CC-MX8   the fingerprint contains the live ICU collation version and the major version
//   TB-1  C3 trusted-owner boundary (contract B, docs §15.8): the owner can forge drift events and rewrite summaries
//         without disabling a trigger; eligibility and the catalog gate do NOT see it; db/ops/verify-summaries.sql does;
//         after a clean verification, later tampering is again invisible until the next one (time of check / time of use).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { latestDefinition } from './durability-fixtures.mjs';
import { asOwner, connect, createSources, freshDatabase, recordRights, roles, ownerRecovery } from './helpers.mjs';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';
import { migrateUp } from '../../dist/persistence/migrate.js';

const ROLES = ['admin', 'si_rights_admin', 'si_collector', 'si_monitor', 'si_retention'];
const GATE = readFileSync(new URL('../../db/ops/integrity-gate.sql', import.meta.url), 'utf8');
const VERIFY_ALL = readFileSync(new URL('../../db/ops/verify-summaries.sql', import.meta.url), 'utf8');
const M20 = readFileSync(new URL('../../db/migrations/0020_advertiser_summaries.up.sql', import.meta.url), 'utf8');
const COVERAGE_0020 = (() => { const a = M20.indexOf('CREATE FUNCTION si.si_summary_coverage('); const e = '$summary_coverage$;';
  return M20.slice(a, M20.indexOf(e, a) + e.length).replace('FUNCTION si.si_summary_coverage(', 'FUNCTION si.si_test_coverage_0020('); })();
let n = 0;
function mutate(text, from, to) { assert.equal(text.split(from).length, 2, `exactly one anchor: ${from.slice(0, 70)}`); return text.replace(from, () => to); }
function rng(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const AD = (id, name, network = 'META') => ({ network, nativeAdId: id, advertiserName: name, countries: ['DE'], seenAt: '2026-01-01T00:00:00.000Z',
  sourceUrl: `https://example.test/${id}`, destinationUrl: 'https://example.test/d', creativeUrl: 'https://example.test/c', title: `Synthetic ${id}` });
async function begin(x, src, rows) {
  const nets = [...new Set(rows.map(r => r.network))].sort();
  const fx = fixtureSha256(rows), sha = requestSha256({ adapterId: src, evidenceKind: 'SYNTHETIC', networks: nets.length ? nets : ['META'], fixtureSha256: fx });
  return (await x.si_collector.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)', [src, `cl${++n}`, sha, 'SYNTHETIC', nets.length ? nets : ['META'], fx])).rows[0];
}
async function collect(x, src, rows) {
  const run = await begin(x, src, rows);
  await x.si_collector.query('BEGIN');
  try { await x.si_collector.query('SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)', [run.run_id, run.lease_token, JSON.stringify(rows)]); await x.si_collector.query('COMMIT'); }
  catch (e) { await x.si_collector.query('ROLLBACK').catch(() => {}); throw e; }
  return run.run_id;
}
async function fresh(t, prefix, opts) {
  const db = await freshDatabase(t, prefix, opts);
  const x = await roles(t, db, ROLES);
  Object.defineProperty(x, 'db', { value: db, enumerable: false });
  return x;
}
async function source(x, id) { await createSources(x.admin, [id], ['META', 'TIKTOK', 'GOOGLE']); await recordRights(x.si_rights_admin, id, {}); return id; }
async function ownerQ(c, sql, p) { let rows; await asOwner(c, async a => { rows = (await a.query(sql, p)).rows; }); return rows; }
async function replica(c, sql, p) { await c.query('BEGIN'); await c.query('SET LOCAL session_replication_role = replica');
  try { const r = await c.query(sql, p); await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK'); throw e; } }
const coverage = async (c, s) => (await ownerQ(c, 'SELECT eligible, reasons FROM si.si_summary_coverage($1)', [s]))[0];
const verify = async (c, s) => (await ownerQ(c, 'SELECT finding FROM si.si_verify_summaries($1)', [s])).map(r => r.finding).sort();
const gate = async c => (await c.query(GATE)).rows.map(r => `${r.check}:${r.detail}`);
async function verifyAll(c) { let rows; await asOwner(c, async a => { rows = (await a.query(VERIFY_ALL)).rows; }); return rows.map(r => `${r.source_id}:${r.finding}`).sort(); }

// ------------------------------------------------------------------------------------------------ C1
test('CV-1: 0021 eligibility == 0020 eligibility over randomized states (missing, stale, drift, purged, EMPTY, RUNNING)', { timeout: 900000 }, async t => {
  const x = await fresh(t, 'm4cv1');
  const c = x.admin;
  await ownerQ(c, COVERAGE_0020);
  const SRC = [await source(x, 'cv-a'), await source(x, 'cv-b'), await source(x, 'cv-c'), await source(x, 'cv-empty')];
  const runs = [];
  for (let k = 0; k < 36; k++) {
    const s = SRC[k % 3];
    runs.push({ s, id: await collect(x, s, k % 6 === 5 ? [] : [AD(`cv${k}a`, `CV ${k % 4}`), AD(`cv${k}b`, `CV ${k % 5}`, 'TIKTOK')]) });
  }
  for (const s of SRC.slice(0, 3)) await begin(x, s, [AD(`run-${s}`, 'Running Co')]);          // a RUNNING run per source
  const seed = Number(process.env.SI_CV_SEED ?? 20261116), trials = Number(process.env.SI_CV_TRIALS ?? 60);
  const rand = rng(seed), pick = a => a[Math.floor(rand() * a.length)];
  const seen = new Set(); let comparisons = 0, backfillRefused = 0;
  const compare = async label => {
    for (const s of SRC) {
      const [a] = await ownerQ(c, 'SELECT eligible, reasons FROM si.si_summary_coverage($1)', [s]);
      const [b] = await ownerQ(c, 'SELECT eligible, reasons FROM si.si_test_coverage_0020($1)', [s]);
      assert.deepEqual(a, b, `${label} ${s}: 0021 == 0020`);
      seen.add(a.reasons.join('+') || 'eligible'); comparisons++;
    }
  };
  await compare('initial');
  // Deterministic: each reason ALONE on an otherwise eligible source (the randomized phase can mask one by another).
  const one = runs.find(r => r.s === 'cv-c').id;
  const isolated = async (label, change, want, repair) => {
    await change(); await compare(label);
    const [a] = await ownerQ(c, 'SELECT eligible, reasons FROM si.si_summary_coverage($1)', ['cv-c']);
    assert.deepEqual(a, want, `${label}: isolated outcome`);
    await repair(); await compare(`${label} repaired`);
    assert.deepEqual((await ownerQ(c, 'SELECT eligible, reasons FROM si.si_summary_coverage($1)', ['cv-c']))[0], { eligible: true, reasons: [] }, `${label}: repaired`);
  };
  const backfill = () => ownerQ(c, 'SELECT * FROM si.si_backfill_summaries(100)');
  await isolated('one stale status', () => replica(c, `UPDATE si.run_summary_status SET normalizer = 'v0|stale' WHERE run_id = $1`, [one]),
    { eligible: false, reasons: ['INCOMPLETE'] }, backfill);
  await isolated('one unsummarized run', async () => { await replica(c, 'DELETE FROM si.run_advertiser_summaries WHERE run_id = $1', [one]); await replica(c, 'DELETE FROM si.run_summary_status WHERE run_id = $1', [one]); },
    { eligible: false, reasons: ['INCOMPLETE'] }, backfill);
  await isolated('open drift', () => ownerQ(c, `INSERT INTO si.summary_events (source_id, kind, finding) VALUES ('cv-c', 'DRIFT_DETECTED', 'MISSING')`),
    { eligible: false, reasons: ['DRIFT'] }, () => ownerRecovery(c, 'cv-c'));                     // 0025: a clean sweep + authorized clearance
  await isolated('stale status of a purged run (not eligible: no effect)', async () => {
      await replica(c, `UPDATE si.collection_runs SET retention_state = 'PURGED', first_purged_at = clock_timestamp(), purged_at = clock_timestamp() WHERE run_id = $1`, [one]);
      await replica(c, `UPDATE si.run_summary_status SET normalizer = 'v0|stale' WHERE run_id = $1`, [one]); },
    { eligible: true, reasons: [] }, async () => {});
  for (let i = 0; i < trials; i++) {
    const r = pick(runs);
    const op = Math.floor(rand() * 9);
    // States reachable through the product or a recovery path (each composite FK holds; replica bypasses the guards only).
    if (op === 0) { await replica(c, 'DELETE FROM si.run_advertiser_summaries WHERE run_id = $1', [r.id]); await replica(c, 'DELETE FROM si.run_summary_status WHERE run_id = $1', [r.id]); } // unsummarized
    else if (op === 8) await replica(c, 'DELETE FROM si.run_summary_status WHERE run_id = $1', [r.id]);                               // status alone missing
    else if (op === 1) await replica(c, `UPDATE si.run_summary_status SET normalizer = 'v0|stale' WHERE run_id = $1`, [r.id]);       // stale fingerprint
    else if (op === 2) await ownerQ(c, `INSERT INTO si.summary_events (source_id, kind, finding) VALUES ($1, 'DRIFT_DETECTED', 'MISSING')`, [r.s]);
    else if (op === 3) await ownerQ(c, `INSERT INTO si.summary_events (source_id, kind) VALUES ($1, 'DRIFT_CLEARED')`, [r.s]);
    else if (op === 4) await replica(c, `UPDATE si.collection_runs SET retention_state = 'PURGED', first_purged_at = coalesce(first_purged_at, clock_timestamp()), purged_at = clock_timestamp() WHERE run_id = $1 AND retention_state = 'RETAINED'`, [r.id]);
    else if (op === 5) await replica(c, `UPDATE si.run_summary_status SET normalizer = 'v0|stale' WHERE source_id = $1`, [r.s]);     // a whole source stale
    else if (op === 6) await ownerQ(c, 'SELECT * FROM si.si_backfill_summaries(5)').catch(async e => {                                // repair some
      backfillRefused++; assert.match(e.message, /run_advertiser_summaries_pkey/);
      // R-40 runbook equivalent: rows of runs without a status are removed (superuser here), then backfill re-derives them
      await replica(c, `DELETE FROM si.run_advertiser_summaries x WHERE NOT EXISTS (SELECT 1 FROM si.run_summary_status s WHERE s.run_id = x.run_id)`);
      await ownerQ(c, 'SELECT * FROM si.si_backfill_summaries(5)'); });
    else if (op === 7) await ownerQ(c, 'SELECT * FROM si.si_verify_summaries($1)', [r.s]);                                           // real detection (0025: it never clears)
    await compare(`seed ${seed} trial ${i} op ${op}`);
  }
  await ownerQ(c, `INSERT INTO si.summary_events (source_id, kind, finding) VALUES ('cv-empty', 'DRIFT_DETECTED', 'ORPHAN_IDENTITY')`);   // drift without runs
  await compare('drift on a source without runs');
  console.log(`# CV-1 seed ${seed}: ${trials} trials, ${comparisons} comparisons, outcomes ${JSON.stringify([...seen].sort())}; backfill batches refused (status alone missing, rows kept: fails closed) ${backfillRefused}`);
  for (const o of ['eligible', 'DRIFT', 'INCOMPLETE', 'DRIFT+INCOMPLETE']) assert.ok(seen.has(o), `outcome ${o} reached`);
});

test('CV-2: the fingerprint is evaluated once per call, independently of the number of runs', async t => {
  const x = await fresh(t, 'm4cv2');
  const c = x.admin, s = await source(x, 'cv-n');
  for (let k = 0; k < 30; k++) await collect(x, s, [AD(`n${k}`, 'Count Co')]);
  await c.query('SELECT pg_stat_reset()'); await c.query(`SET track_functions = 'all'`);   // superuser: count function calls
  const calls = async () => { await c.query('SELECT pg_stat_force_next_flush()'); await c.query('SELECT pg_stat_clear_snapshot()');
    return Number((await c.query(`SELECT coalesce(sum(calls), 0) AS n FROM pg_stat_user_functions WHERE schemaname = 'si' AND funcname = 'si_normalizer_fingerprint'`)).rows[0].n); };
  const before = await calls();
  await c.query('SET ROLE si_owner'); await c.query(`SELECT * FROM si.si_summary_coverage($1)`, [s]); await c.query('RESET ROLE');
  const once = await calls() - before;
  await ownerQ(c, COVERAGE_0020);
  const b2 = await calls();
  await c.query('SET ROLE si_owner'); await c.query(`SELECT * FROM si.si_test_coverage_0020($1)`, [s]); await c.query('RESET ROLE');
  const old = await calls() - b2;
  console.log(`# CV-2 fingerprint evaluations per call with 30 runs: 0021 ${once}, 0020 ${old}`);
  assert.equal(once, 1, '0021: once per call');
  assert.ok(old >= 30, '0020: once per run (the cost removed)');
});

// ------------------------------------------------------------------------------------------------ C2 controls
const CHECK_TRG = latestDefinition('trg_runs_summary_check', 'END $runs_summary_check$;').text;
const VERIFY_FN = latestDefinition('si_verify_summaries', 'END $verify_summaries$;').text;
const BACKFILL = latestDefinition('si_backfill_summaries', 'END $backfill$;').text;
const FINGERPRINT = latestDefinition('si_normalizer_fingerprint', '$normalizer_fingerprint$;').text;

/** Owner completes a RUNNING run directly (receipt + transition), optionally after writing a summary for part of its evidence. */
async function ownerCompletion(t, sqls, { observations, summarizeAfter }) {
  const x = await fresh(t, 'm4ccc');
  const c = x.admin, s = await source(x, 'cc-own');
  await ownerQ(c, 'SELECT 1');                                         // owner path available
  for (const q of sqls) await ownerQ(c, q);
  const run = await begin(x, s, observations ? [AD('x', 'X')] : []);
  try {
    await asOwner(c, async a => {
      for (let i = 0; i < observations; i++) {
        const ad = (await a.query(`INSERT INTO si.ads (source_id, network, native_ad_id, first_run_id) VALUES ($1, 'META', $2, $3) RETURNING ad_id`, [s, `own-${i}`, run.run_id])).rows[0].ad_id;
        await a.query(`INSERT INTO si.observations (run_id, source_id, rights_version_id, ordinal, ad_id, network, native_ad_id, advertiser_name, countries, seen_at, source_url, content_sha256)
            SELECT r.run_id, r.source_id, r.rights_version_id, $2, $3, 'META', $4, 'Owner Co', '{DE}', clock_timestamp(), 'https://example.test/o', repeat('a', 64)
              FROM si.collection_runs r WHERE r.run_id = $1`, [run.run_id, i, ad, `own-${i}`]);
        if (summarizeAfter === i + 1) await a.query(`SELECT si.si_summarize_run($1, 'PUBLICATION')`, [run.run_id]);
      }
      if (summarizeAfter === 0) await a.query(`SELECT si.si_summarize_run($1, 'PUBLICATION')`, [run.run_id]);
      await a.query(`WITH rc AS (INSERT INTO si.publication_receipts (run_id, source_id, rights_version_id) SELECT run_id, source_id, rights_version_id FROM si.collection_runs WHERE run_id = $1 RETURNING run_id)
        UPDATE si.collection_runs x SET status = 'COMPLETED', retention_state = CASE WHEN $2::int = 0 THEN 'EMPTY' ELSE 'RETAINED' END,
          retain_until = CASE WHEN $2::int = 0 THEN NULL ELSE clock_timestamp() + interval '1 day' END,
          received_count = $2, published_count = $2, duplicate_count = 0, suppressed_count = 0, conflict_count = 0,
          finished_at = clock_timestamp(), rights_checked_at = clock_timestamp(), lease_token = NULL, lease_expires_at = NULL,
          publish_control_seq = (SELECT coalesce(max(control_seq), 0) FROM si.source_controls WHERE source_id = x.source_id)
         FROM rc WHERE x.run_id = rc.run_id`, [run.run_id, observations]);
    });
    return 'COMMITTED';
  } catch (e) { return `refused:${e.message.includes('without a complete summary') ? 'SUMMARY_CHECK' : e.message.slice(0, 60)}`; }
}

test('CC-MX5: the commit-time summary check refuses an owner completion without a summary (and only it)', async t => {
  const control = await ownerCompletion(t, [], { observations: 0, summarizeAfter: 0 });     // same path WITH a summary
  const base = await ownerCompletion(t, [], { observations: 0, summarizeAfter: null });
  const mut = await ownerCompletion(t, [mutate(CHECK_TRG, '  IF NOT EXISTS (SELECT 1 FROM si.run_summary_status s', '  IF false AND NOT EXISTS (SELECT 1 FROM si.run_summary_status s')],
    { observations: 0, summarizeAfter: null });
  console.log(`# CC-MX5 owner completion: with summary ${control}; without (baseline) ${base}; without (check removed) ${mut}`);
  assert.equal(control, 'COMMITTED', 'precondition: the owner path reaches commit; every other publication check passes');
  assert.equal(base, 'refused:SUMMARY_CHECK', 'baseline: refused by the 0020 summary check');
  assert.equal(mut, 'COMMITTED', 'mutant: a COMPLETED run without a summary commits');
});

test('CC-MX13: the commit-time check refuses a status that does not count every observation', async t => {
  const control = await ownerCompletion(t, [], { observations: 3, summarizeAfter: 3 });
  const base = await ownerCompletion(t, [], { observations: 3, summarizeAfter: 2 });          // status/rows cover 2 of 3
  const mut = await ownerCompletion(t, [mutate(CHECK_TRG, '                    AND s.observation_count = (SELECT count(*) FROM si.observations o WHERE o.run_id = NEW.run_id)\n', '')],
    { observations: 3, summarizeAfter: 2 });
  console.log(`# CC-MX13 owner completion: complete summary ${control}; stale summary (baseline) ${base}; stale summary (count check removed) ${mut}`);
  assert.equal(control, 'COMMITTED', 'precondition: with a summary of all 3 observations the path commits');
  assert.equal(base, 'refused:SUMMARY_CHECK');
  assert.equal(mut, 'COMMITTED', 'mutant: a summary missing one observation commits (rows and counts agree with each other)');
});

async function fabricatedRow(t, sqls) {
  const x = await fresh(t, 'm4ccv');
  const c = x.admin, s = await source(x, 'cc-v');
  for (const q of sqls) await ownerQ(c, q);
  const R = await collect(x, s, [AD('f1', 'Fab Co'), AD('f2', 'Other Co')]);
  // Superuser: an extra (fabricated) row in GOOGLE for an existing identity, and the status forged to agree with it
  // (summary_rows + 1; observation_count and digest still those of the true evidence).
  await replica(c, `INSERT INTO si.run_advertiser_summaries (run_id, source_id, identity_id, network, observations, ad_ids, names)
      SELECT run_id, source_id, identity_id, 'GOOGLE', observations, ad_ids, names FROM si.run_advertiser_summaries WHERE run_id = $1 ORDER BY identity_id LIMIT 1`, [R]);
  await replica(c, `UPDATE si.run_summary_status SET summary_rows = summary_rows + 1 WHERE run_id = $1`, [R]);
  return verify(c, s);
}
test('CC-MX4: verification reports a fabricated extra row even when the status is forged to agree (the other direction is not redundant)', async t => {
  const base = await fabricatedRow(t, []);
  const mut = await fabricatedRow(t, [mutate(VERIFY_FN, '\n              OR EXISTS (SELECT * FROM si.si_summary_stored(s.run_id) EXCEPT ALL SELECT * FROM si.si_summary_content(s.run_id)))', ')')]);
  console.log(`# CC-MX4 verification: baseline ${JSON.stringify(base)}; one-direction comparison ${JSON.stringify(mut)}`);
  assert.deepEqual(base, ['CONTENT_MISMATCH'], 'baseline: found, and only by the content comparison (no STATUS_MISMATCH masks it)');
  assert.deepEqual(mut, [], 'mutant: the forged state passes verification');
});

async function orphanIdentity(t, sqls) {
  const x = await fresh(t, 'm4cco');
  const c = x.admin, s = await source(x, 'cc-o');
  for (const q of sqls) await ownerQ(c, q);
  const R = await collect(x, s, [AD('o1', 'Kept Co')]);
  await replica(c, `INSERT INTO si.advertiser_identities (source_id, normalizer, advertiser_key, normalized_name, first_run_id)
      VALUES ($1, si.si_normalizer_fingerprint(), sha256(convert_to('orphan co', 'UTF8')), 'orphan co', $2)`, [s, R]);
  const pre = (await c.query(`SELECT count(*)::int AS n FROM si.advertiser_identities i WHERE NOT EXISTS (SELECT 1 FROM si.run_advertiser_summaries x WHERE x.identity_id = i.identity_id)`)).rows[0].n;
  if (pre !== 1) throw new Error(`fixture: ${pre} orphan identities`);
  return verify(c, s);
}
test('CC-MX12: verification reports an identity no summary references', async t => {
  const base = await orphanIdentity(t, []);
  const mut = await orphanIdentity(t, [mutate(VERIFY_FN, '       WHERE i.source_id = p_source_id AND NOT EXISTS (SELECT 1 FROM si.run_advertiser_summaries x WHERE x.identity_id = i.identity_id)', '       WHERE false')]);
  console.log(`# CC-MX12 verification: baseline ${JSON.stringify(base)}; orphan check removed ${JSON.stringify(mut)}`);
  assert.deepEqual(base, ['ORPHAN_IDENTITY']);
  assert.deepEqual(mut, []);
});

/** A run published before 0020 (no summary) is purged while backfill, which selected it, waits for the source lock. */
async function purgeRace(t, sqls) {
  const x = await fresh(t, 'm4ccp', { migrate: false });
  await migrateUp(x.admin, { to: 19 });
  const c = x.admin, s = await source(x, 'cc-race');
  const R = await collect(x, s, [AD('r1', 'Race Co')]);
  const K = await collect(x, s, [AD('k1', 'Keep Co')]);
  await migrateUp(x.admin);
  for (const q of sqls) await ownerQ(c, q);
  const cand = (await c.query(`SELECT count(*)::int AS n FROM si.run_summary_status WHERE run_id = ANY ($1::uuid[])`, [[R, K]])).rows[0].n;
  if (cand !== 0) throw new Error('fixture: the runs must be unbackfilled');
  await replica(c, `UPDATE si.collection_runs SET retain_until = clock_timestamp() - interval '1 minute' WHERE run_id = $1`, [R]);
  const p = await connect({ user: 'si_retention', database: x.db }); t.after(() => p.end().catch(() => {}));
  await p.query('BEGIN');
  const out = (await p.query('SELECT * FROM si.si_purge_due(20)')).rows[0].outcome;     // holds the source lock, uncommitted
  const b = await connect({ database: x.db }); t.after(() => b.end().catch(() => {}));
  const pid = (await b.query('SELECT pg_backend_pid() AS p')).rows[0].p;
  const pending = asOwner(b, a => a.query('SELECT * FROM si.si_backfill_summaries(100)')).then(r => r.rows[0]);
  let waiting = false;
  for (let i = 0; i < 500 && !waiting; i++) {
    waiting = (await c.query(`SELECT wait_event_type = 'Lock' AS w FROM pg_stat_activity WHERE pid = $1`, [pid])).rows[0]?.w === true;
    if (!waiting) await new Promise(r => setTimeout(r, 10));
  }
  if (out !== 'PURGED' || !waiting) { await p.query('ROLLBACK'); throw new Error(`fixture: purge ${out}, backfill waiting ${waiting}`); }
  await p.query('COMMIT');
  const bf = await pending;
  const st = (await c.query(`SELECT r.retention_state, (SELECT count(*) FROM si.run_summary_status WHERE run_id = r.run_id)::int AS status
                               FROM si.collection_runs r WHERE r.run_id = $1`, [R])).rows[0];
  return { bf, st, keep: (await c.query(`SELECT count(*)::int AS n FROM si.run_summary_status WHERE run_id = $1`, [K])).rows[0].n };
}
test('CC-MX7: a purge committed while backfill waits for the lock is not resurrected (genuinely unbackfilled run)', async t => {
  const base = await purgeRace(t, []);
  const mut = await purgeRace(t, [mutate(BACKFILL, "      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM si.collection_runs r WHERE r.run_id = x.run_id\n                                  AND r.status = 'COMPLETED' AND r.retention_state IN ('RETAINED', 'EMPTY'));\n", '')]);
  console.log(`# CC-MX7 baseline ${JSON.stringify(base)}; re-check removed ${JSON.stringify(mut)}`);
  assert.deepEqual(base, { bf: { summarized: 1, remaining: 0 }, st: { retention_state: 'PURGED', status: 0 }, keep: 1 }, 'baseline: the kept run is summarized, the purged one skipped');
  assert.deepEqual(mut.st, { retention_state: 'PURGED', status: 1 }, 'mutant: a status is resurrected for the purged run');
});

async function fingerprintScn(t, sqls) {
  const x = await fresh(t, 'm4ccf');
  for (const q of sqls) await ownerQ(x.admin, q);
  const fp = (await ownerQ(x.admin, 'SELECT si.si_normalizer_fingerprint() AS f'))[0].f;
  const want = (await x.admin.query(`SELECT 'v1|icu=' || pg_collation_actual_version(c.oid) || '|pg=' || (current_setting('server_version_num')::int / 10000) AS w,
      pg_collation_actual_version(c.oid) AS icu FROM pg_collation c WHERE c.collname = 'und-x-icu' AND c.collnamespace = 'pg_catalog'::regnamespace`)).rows[0];
  if (!want?.icu) throw new Error('fixture: no und-x-icu collation version on this server');
  return fp === want.w ? 'EXACT' : `DIFFERS:${fp}`;
}
test('CC-MX8: the fingerprint carries the live ICU collation version and the server major version', async t => {
  const base = await fingerprintScn(t, []);
  const mut = await fingerprintScn(t, [mutate(FINGERPRINT, "  SELECT 'v1|icu=' || coalesce((SELECT pg_collation_actual_version(c.oid) FROM pg_collation c\n                                 WHERE c.collname = 'und-x-icu' AND c.collnamespace = 'pg_catalog'::regnamespace), 'none')",
    "  SELECT 'v1|icu=' || 'fixed'")]);
  console.log(`# CC-MX8 baseline ${base}; ICU version omitted ${mut}`);
  assert.equal(base, 'EXACT');
  assert.match(mut, /^DIFFERS:v1\|icu=fixed\|pg=16$/);
});

// ------------------------------------------------------------------------------------------------ C3
test('TB-1: trusted-owner boundary — forged drift events and rewritten summaries pass eligibility and the gate; verification finds them; TOCTOU', async t => {
  const x = await fresh(t, 'm4tb1');
  const c = x.admin, s = await source(x, 'tb-a');
  const R1 = await collect(x, s, [AD('t1', 'Trust Co'), AD('t2', 'Other Co', 'TIKTOK')]);
  const R2 = await collect(x, s, [AD('t3', 'Trust Co')]);
  assert.deepEqual(await coverage(c, s), { eligible: true, reasons: [] });
  assert.deepEqual(await verifyAll(c), [], 'verification PASS before');
  // 1-3: as si_owner only (no trigger disabled, no superuser): forge drift, rewrite R1's summary, forge clearance.
  await asOwner(c, async a => {
    await a.query(`INSERT INTO si.summary_events (source_id, kind, finding) VALUES ($1, 'DRIFT_DETECTED', 'MISSING')`, [s]);
    await a.query(`DELETE FROM si.run_advertiser_summaries WHERE run_id = $1 AND network = 'TIKTOK'`, [R1]);   // admitted: drift is "open"
    await a.query(`INSERT INTO si.summary_events (source_id, kind) VALUES ($1, 'DRIFT_CLEARED')`, [s]);
  });
  // 4: eligibility and the gate do not see it (documented: the owner is trusted).
  assert.deepEqual(await coverage(c, s), { eligible: true, reasons: [] }, 'eligibility: still eligible (limitation, docs §15.8)');
  assert.deepEqual(await gate(c), [], 'catalog gate: PASS (no catalog change was needed)');
  // 5: verification does.
  const v = await verifyAll(c);
  console.log(`# TB-1 after owner tampering: eligibility eligible, gate PASS, verify-summaries.sql ${JSON.stringify(v)}`);
  assert.deepEqual(v, [`${s}:CONTENT_MISMATCH`, `${s}:ORPHAN_IDENTITY`, `${s}:STATUS_MISMATCH`], 'the rewritten run, and the identity it orphaned');
  assert.deepEqual(await coverage(c, s), { eligible: false, reasons: ['DRIFT'] }, 'after verification: not eligible');
  // Recovery from the authoritative observations, then a clean verification clears the drift.
  await ownerQ(c, 'SELECT si.si_rebuild_run_summaries($1)', [R1]);
  assert.deepEqual(await verifyAll(c), [], 'rebuilt: verification PASS');
  assert.deepEqual(await coverage(c, s), { eligible: false, reasons: ['DRIFT'] }, '0025: a clean verification does not clear');
  assert.equal(await ownerRecovery(c, s), 'COMPLETED_CLEAN');                   // the authorized recovery
  assert.deepEqual(await coverage(c, s), { eligible: true, reasons: [] });
  // TOCTOU: tampering after a clean verification is invisible until the next verification.
  await asOwner(c, async a => {
    await a.query(`INSERT INTO si.summary_events (source_id, kind, finding) VALUES ($1, 'DRIFT_DETECTED', 'MISSING')`, [s]);
    await a.query(`DELETE FROM si.run_advertiser_summaries WHERE run_id = $1`, [R2]);
    await a.query(`INSERT INTO si.summary_events (source_id, kind) VALUES ($1, 'DRIFT_CLEARED')`, [s]);
  });
  assert.deepEqual(await coverage(c, s), { eligible: true, reasons: [] }, 'TOCTOU: eligible between verifications');
  assert.notDeepEqual(await verifyAll(c), [], 'the next verification finds it');
  // Ordinary roles cannot take any step of this sequence.
  for (const role of ['si_collector', 'si_monitor', 'si_retention', 'si_rights_admin'])
    await assert.rejects(x[role].query(`INSERT INTO si.summary_events (source_id, kind) VALUES ($1, 'DRIFT_CLEARED')`, [s]), { code: '42501' }, `${role}: no access`);
});
