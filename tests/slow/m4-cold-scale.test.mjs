// B-002 M4-P2.2 (N1): the concentrated-history workload at the candidate cap on a database WITHOUT planner statistics.
// One source holds 200,000 observations of one advertiser in 400 runs, built through the product write path; autovacuum
// is disabled on the si tables of the disposable clone and nothing is analyzed (fixture: the state right after bulk
// ingestion, of a freshly migrated database and of a pg_restore'd one). About 2 minutes; slow CI job:
//   node tests/db/run.mjs tests/slow/m4-cold-scale.test.mjs
//
// Measured on 0015 (d0a318a), same workload: the first history page took 8.5 s to more than 10 s (cancelled by the 10 s
// statement timeout: RESOURCE_LIMIT), with a MATERIALIZED readable-run CTE too (the join itself was nested). With 0016:
// 1.4-1.8 s, the bound refused after one page, as with statistics. Both history calls run under a 4 s statement timeout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { asOwner, cfg, connect, createSources, freshDatabase, recordRights, roles } from '../db/helpers.mjs';
import { provisionReaderPrincipal } from '../../dist/persistence/bootstrap.js';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';
import { grantReader } from '../../dist/persistence/reader.js';
import * as INTEL from '../../dist/persistence/intelligence.js';

const MIG15 = readFileSync(new URL('../../db/migrations/0015_intelligence_remediation.up.sql', import.meta.url), 'utf8');
test.before(async () => { const a = await connect(); try { await provisionReaderPrincipal(a, 'si_reader_alice', cfg.rolePassword); } finally { await a.end(); } });

async function coldSource(t, prefix) {
  const db = await freshDatabase(t, prefix);
  const x = await roles(t, db, ['admin', 'si_rights_admin', 'si_collector', 'si_monitor']);
  await x.admin.query(`DO $$ DECLARE r record; BEGIN FOR r IN SELECT c.oid::regclass AS t FROM pg_class c
                         WHERE c.relnamespace = 'si'::regnamespace AND c.relkind = 'r' LOOP
                         EXECUTE format('ALTER TABLE %s SET (autovacuum_enabled = off)', r.t); END LOOP; END $$`);
  const src = 'cold-scale';
  await createSources(x.admin, [src], ['META']); await recordRights(x.si_rights_admin, src, {});
  await grantReader(x.si_rights_admin, 'si_reader_alice', src, 'm4-p2.2 cold scale');
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
  const stats = Number((await x.admin.query(`SELECT count(*) AS c FROM pg_stats WHERE schemaname = 'si' AND tablename IN ('observations', 'collection_runs')`)).rows[0].c);
  assert.equal(stats, 0, 'cold: no planner statistics');
  const alice = await connect({ user: 'si_reader_alice', database: db });
  t.after(() => alice.end().catch(() => {}));
  return { x, src, alice };
}
async function measure(label, f) {
  const t0 = performance.now(); let outcome;
  try { const v = await f(); outcome = `ok:${v.observations?.length ?? v.hits?.length}`; } catch (e) { outcome = `${e.name}:${e.code}`; }
  const ms = Math.round(performance.now() - t0);
  console.log(`# SCALE-2 ${label}: ${outcome}, ${ms} ms`);
  return { outcome, ms };
}

test('SCALE-2 (N1): 200,000 observations of one advertiser without statistics — refused after one page, search and no-match complete', async t => {
  const { src, alice } = await coldSource(t, 'm4coldscale');
  await alice.query(`SET statement_timeout = '4s'`);                         // the history: the same budget as the mutant below
  let requests = 0;
  const counted = { query: (...a) => { if (String(a[0]).includes('si.si_advertiser_history(')) requests++; return alice.query(...a); } };
  const h = await measure('cold library history (bound 5,000)', () => INTEL.advertiserHistory(counted, src, 'Dominant Synthetic'));
  assert.equal(h.outcome, 'IntelligenceFailed:SCAN_LIMIT', 'the bound, not the statement timeout');
  assert.ok(requests <= 3, `one page (NOT_DURABLE retries aside): ${requests}`);
  await alice.query('RESET statement_timeout');                              // searches: the reader's default (10 s)
  assert.equal((await measure('cold concentrated search', () => INTEL.searchAdvertisers(alice, { sources: [src], query: 'dominant' }))).outcome, 'ok:1');
  assert.equal((await measure('cold no-match search', () => INTEL.searchAdvertisers(alice, { sources: [src], query: 'no-such-advertiser' }))).outcome, 'ok:0');
});

test('SCALE-2M: mutant — the 0015 history function (readable runs joined in the page) times out on the same cold workload (killed)', async t => {
  const { x, src, alice } = await coldSource(t, 'm4coldscalem');
  const s = MIG15.indexOf('CREATE OR REPLACE FUNCTION si.si_advertiser_history'), e = 'END $history$;';
  await asOwner(x.admin, a => a.query(MIG15.slice(s, MIG15.indexOf(e, s) + e.length)));
  // The 0015 page takes 8.5 s to more than 10 s on this workload (measured); 0016 takes 1.4-1.8 s. A 4 s reader statement
  // timeout separates them with a margin of at least 2x on either side.
  await alice.query(`SET statement_timeout = '4s'`);
  const h = await measure('cold library history, 0015 function, 4 s statement timeout', () => INTEL.advertiserHistory(alice, src, 'Dominant Synthetic'));
  assert.equal(h.outcome, 'IntelligenceFailed:RESOURCE_LIMIT', 'the defect: the statement timeout cancels the first page');
});
