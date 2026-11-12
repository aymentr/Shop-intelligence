// B-002 M4-P2.1 (D2, D3): the M4-P2-ACCEPT-01 scale workloads on the real 0015 functions. One source holds 200,000
// observations of ONE advertiser (the candidate cap), built through the product write path (400 runs of 500). About
// 1-2 minutes to build; it runs in the slow CI job:  node tests/db/run.mjs tests/slow/m4-remediation-scale.test.mjs
//
// Before 0015 (measured on 61bda9d, docs §12.2): the library history fetched 51 pages (51 audited requests, 93-168 s,
// 4.6-5.1 GB of temporary files) before failing SCAN_LIMIT at its 5,000-observation bound.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cfg, connect, control, createSources, freshDatabase, lift, recordRights, roles } from '../db/helpers.mjs';
import { provisionReaderPrincipal } from '../../dist/persistence/bootstrap.js';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';
import { grantReader } from '../../dist/persistence/reader.js';
import * as INTEL from '../../dist/persistence/intelligence.js';

const TEMP_LIMIT = 256 * 1048576;                                            // pinned temp_file_limit of the two functions (0015)
test.before(async () => { const a = await connect(); try { await provisionReaderPrincipal(a, 'si_reader_alice', cfg.rolePassword); } finally { await a.end(); } });

test('SCALE-1: 200,000 observations of one advertiser — one-page refusal, bounded temporary files, pinned memory, lock wait', async t => {
  const db = await freshDatabase(t, 'm4scale');
  const x = await roles(t, db, ['admin', 'si_rights_admin', 'si_collector', 'si_monitor']);
  const src = 'scale-a';
  await createSources(x.admin, [src], ['META']); await recordRights(x.si_rights_admin, src, {});
  await grantReader(x.si_rights_admin, 'si_reader_alice', src, 'm4-p2.1 scale');
  const t0 = performance.now();
  for (let k = 0; k < 400; k++) {
    const rows = Array.from({ length: 500 }, (_, i) => ({ network: 'META', nativeAdId: `d${k * 500 + i}`, advertiserName: 'Dominant Synthetic', countries: ['DE'],
      seenAt: '2026-01-01T00:00:00.000Z', sourceUrl: `https://example.test/d${k * 500 + i}`, destinationUrl: 'https://example.test/d', creativeUrl: 'https://example.test/c', title: `S ${k}` }));
    const fx = fixtureSha256(rows), sha = requestSha256({ adapterId: src, evidenceKind: 'SYNTHETIC', networks: ['META'], fixtureSha256: fx });
    const run = (await x.si_collector.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)', [src, `scale${k}`, sha, 'SYNTHETIC', ['META'], fx])).rows[0];
    await x.si_collector.query('BEGIN');
    await x.si_collector.query('SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)', [run.run_id, run.lease_token, JSON.stringify(rows)]);
    await x.si_collector.query('COMMIT');
  }
  for (let i = 0; i < 20; i++) {
    await x.si_monitor.query('SELECT * FROM si.si_verify_receipts(500)');
    if (Number((await x.admin.query('SELECT (SELECT count(*) FROM si.collection_runs) - (SELECT count(*) FROM si.receipt_verifications) AS d')).rows[0].d) === 0) break;
  }
  await x.admin.query('VACUUM ANALYZE');
  console.log(`# SCALE-1 built 200,000 observations in ${Math.round((performance.now() - t0) / 1000)} s`);

  const alice = await connect({ user: 'si_reader_alice', database: db });
  t.after(() => alice.end().catch(() => {}));
  const temp = async () => Number((await x.admin.query('SELECT temp_bytes FROM pg_stat_database WHERE datname = current_database()')).rows[0].temp_bytes);
  const consumed = async () => (await x.admin.query(`SELECT count(*)::int AS n FROM si.read_intents`)).rows[0].n;
  const measure = async (label, run) => {
    const tb = await temp(), ib = await consumed(), ts = performance.now();
    let outcome;
    try { const v = await run(); outcome = `ok:${v.observations?.length ?? v.hits?.length}`; } catch (e) { outcome = `${e.name}:${e.code}`; }
    const r = { outcome, ms: Math.round(performance.now() - ts), tempBytes: (await temp()) - tb, requests: (await consumed()) - ib };
    console.log(`# SCALE-1 ${label}: ${r.outcome}, ${r.ms} ms, ${(r.tempBytes / 1048576).toFixed(1)} MB temporary files, ${r.requests} audited request(s)`);
    return r;
  };
  await measure('warm-up (no match)', () => INTEL.searchAdvertisers(alice, { sources: [src], query: 'warm-up' }));

  // D2: refused after the first page, whatever the bound and page size.
  const h = await measure('library history (bound 5,000, page 100)', () => INTEL.advertiserHistory(alice, src, 'Dominant Synthetic'));
  assert.equal(h.outcome, 'IntelligenceFailed:SCAN_LIMIT');
  assert.equal(h.requests, 1, 'one audited request (61bda9d: 51)');
  assert.ok(h.tempBytes <= TEMP_LIMIT, 'temporary files within the pinned limit');
  const h1 = await measure('library history (bound 5,000, page 1)', () => INTEL.advertiserHistory(alice, src, 'Dominant Synthetic', { pageSize: 1 }));
  assert.deepEqual([h1.outcome, h1.requests], ['IntelligenceFailed:SCAN_LIMIT', 1]);

  // D3: concentrated and no-match searches complete within the pinned bounds; a relaxed session changes nothing.
  const c = await measure('concentrated search (200,000 candidates)', () => INTEL.searchAdvertisers(alice, { sources: [src], query: 'dominant' }));
  assert.equal(c.outcome, 'ok:1');
  assert.ok(c.tempBytes > 0 && c.tempBytes <= TEMP_LIMIT, 'the pinned work_mem spills (bounded); a larger session value is not used');
  await alice.query(`SET work_mem = '1GB'`); await alice.query('SET hash_mem_multiplier = 1000');
  const cr = await measure('concentrated search, reader SET work_mem = 1GB', () => INTEL.searchAdvertisers(alice, { sources: [src], query: 'dominant' }));
  await alice.query('RESET work_mem'); await alice.query('RESET hash_mem_multiplier');
  assert.equal(cr.outcome, 'ok:1');
  assert.ok(cr.tempBytes > 0, 'still spills: the reader\'s 1 GB is not in effect inside the function (61bda9d: 0 MB, i.e. relaxed)');
  const nm = await measure('no-match search (200,000 scanned)', () => INTEL.searchAdvertisers(alice, { sources: [src], query: 'nothing-matches' }));
  assert.equal(nm.outcome, 'ok:0');

  // D8 (documented): a control waits for a page that holds the source lock, at most the page's statement time.
  const p = INTEL.searchAdvertisers(alice, { sources: [src], query: 'dominant' }).then(() => 'ok', e => e.code);
  await new Promise(r => setTimeout(r, 300));
  const tl = performance.now(); await control(x.si_rights_admin, src, 'SUSPEND');
  const wait = Math.round(performance.now() - tl);
  console.log(`# SCALE-1 SUSPEND issued during a concentrated search page waited ${wait} ms; the page: ${await p}`);
  assert.ok(wait < 10000, 'bounded by the reader statement timeout (10 s)');
  await lift(x.si_rights_admin, src);
});
