// B-002 M4-P1.2 (R2): a rights version scheduled BEFORE a scan that takes effect DURING it. Real time only (no fixture
// moves a clock or a version): the publish margin is 60 s, so the scenario needs about 65 s per run; it runs in the
// slow CI job:  node tests/db/run.mjs tests/slow/m4-scheduled-version.test.mjs
//
// Timeline (v1 in effect; v2 scheduled at E = start + 64 s, recorded before the scan):
//   pre-check (start)        v1 in effect, E - 60 s not reached       -> AVAILABLE, token(v1)
//   page 1                   readable
//   wait until E - 59 s      v1's window ends within the margin       -> evidence unreadable
//   page 2                   EMPTY: the scan would end here with 1 of 3 records
//   wait until E + 0.5 s     v2 in effect                             -> available again
//   post-check               AVAILABLE, token(v2)
// (SV-1/SV-M run the client-scan oracle path, which uses si_read_source_availability; SV-2/SV-2M run the server-side path.)
// Only the version-in-effect input of the state token distinguishes the two ends: no control, no source-row change
// and no new version is committed during the scan. Without it the scan returns a truncated success (ok:1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { asOwner, cfg, connect, createSources, freshDatabase, recordRights, roles } from '../db/helpers.mjs';
import { provisionReaderPrincipal } from '../../dist/persistence/bootstrap.js';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';
import { grantReader } from '../../dist/persistence/reader.js';
import * as INTEL from '../../dist/persistence/intelligence.js';

const MIG13 = readFileSync(new URL('../../db/migrations/0013_opaque_availability_state.up.sql', import.meta.url), 'utf8');
const FN = (() => { const s = MIG13.indexOf('CREATE OR REPLACE FUNCTION si.si_read_source_availability'); const e = 'END $read_source_availability$;'; return MIG13.slice(s, MIG13.indexOf(e, s) + e.length); })();
const ANCHOR = ", coalesce(cs.cur_id::text, '-')";
assert.equal(FN.split(ANCHOR).length, 2, 'exactly one anchor');
let n = 0;
test.before(async () => { const a = await connect(); try { await provisionReaderPrincipal(a, 'si_reader_alice', cfg.rolePassword); } finally { await a.end(); } });

const MIG14 = readFileSync(new URL('../../db/migrations/0014_server_side_intelligence.up.sql', import.meta.url), 'utf8');
const STATE_FN = (() => { const s = MIG14.indexOf('CREATE FUNCTION si.si_availability_state'); const e = 'END $availability_state$;'; return MIG14.slice(s, MIG14.indexOf(e, s) + e.length).replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION'); })();

async function scenario(t, mutantSql, kind = 'client') {
  const db = await freshDatabase(t, 'm4sched');
  const x = await roles(t, db, ['admin', 'si_rights_admin', 'si_collector', 'si_monitor']);
  if (mutantSql) await asOwner(x.admin, a => a.query(mutantSql));
  const src = `sched-${++n}`;
  await createSources(x.admin, [src], ['META']); await recordRights(x.si_rights_admin, src, {});
  await grantReader(x.si_rights_admin, 'si_reader_alice', src, 'scheduled-version scenario');
  for (let i = 0; i < 3; i++) {
    const rows = [{ network: 'META', nativeAdId: `sv${n}-${i}`, advertiserName: 'Northwind Synthetic', countries: ['DE'], seenAt: '2026-01-01T00:00:00.000Z',
      sourceUrl: 'https://example.test/a', destinationUrl: 'https://example.test/d', creativeUrl: 'https://example.test/c', title: 'S' }];
    const fx = fixtureSha256(rows), sha = requestSha256({ adapterId: src, evidenceKind: 'SYNTHETIC', networks: ['META'], fixtureSha256: fx });
    const run = (await x.si_collector.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)', [src, `sv${n}-${i}`, sha, 'SYNTHETIC', ['META'], fx])).rows[0];
    await x.si_collector.query('BEGIN');
    await x.si_collector.query('SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)', [run.run_id, run.lease_token, JSON.stringify(rows)]);
    await x.si_collector.query('COMMIT');
  }
  await x.si_monitor.query('SELECT * FROM si.si_verify_receipts(100)');
  await recordRights(x.si_rights_admin, src, { effective_from_sql: "clock_timestamp() + interval '64 seconds'", change_reason: 'scheduled before the scan' });
  const eff = (await x.admin.query(`SELECT max(effective_from) AS e FROM si.rights_versions WHERE source_id = $1`, [src])).rows[0].e.getTime();
  const alice = await connect({ user: 'si_reader_alice', database: db });
  t.after(() => alice.end().catch(() => {}));
  const until = async ms => { while (Date.now() < ms) await new Promise(r => setTimeout(r, 100)); };
  const page2 = [];
  let page = 0;
  const client = { query: async (...q) => {
    const r = await alice.query(...q);
    if (kind === 'client' && typeof q[0] === 'string' && q[0].includes('si.si_read_evidence(')) {
      page++;
      if (page === 1) await until(eff - 59000);                                  // into v1's margin
      if (page === 2) { page2.push(r.rows.length); await until(eff + 500); }      // v2 in effect before the post-check
    }
    if (kind === 'server' && typeof q[0] === 'string' && q[0].includes('si.si_advertiser_history(')) {
      page++;
      if (page === 1) { page2.push(r.rows[0].doc.observations.length); await until(eff + 500); }   // v2 in effect before page 2
    }
    return r;
  } };
  let outcome;
  try {
    const h = kind === 'client' ? await INTEL.advertiserHistoryClientScan(client, src, 'Northwind Synthetic', { pageSize: 1 })
                                : await INTEL.advertiserHistory(client, src, 'Northwind Synthetic', { pageSize: 1 });
    outcome = `ok:${h.observations.length}`;
  }
  catch (e) { outcome = e?.name === 'IntelligenceFailed' ? `INTEL:${e.code}` : `${e?.name}:${e?.code}`; }
  return { outcome, page2: page2[0] };
}

test('SV-1: real 0013 — a version that takes effect during the scan fails it closed (AVAILABILITY_CHANGED)', async t => {
  const r = await scenario(t, null);
  console.log(`# SV-1 page 2 rows during v1's margin: ${r.page2}; outcome ${r.outcome}`);
  assert.equal(r.page2, 0, 'the interleaving happened: page 2 was empty');
  assert.equal(r.outcome, 'INTEL:AVAILABILITY_CHANGED');
});

test('SV-M: mutant — token without the version in effect returns the truncated result (killed)', async t => {
  const r = await scenario(t, FN.replace(ANCHOR, ''));
  console.log(`# SV-M page 2 rows: ${r.page2}; outcome ${r.outcome}`);
  assert.equal(r.page2, 0);
  assert.equal(r.outcome, 'ok:1', 'the defect: a successful but incomplete result');
});

// M4-P2: the server-side path. Each page is computed atomically under the source lock, so a page never returns a
// silently empty result; the version-in-effect input of the server state token (si_availability_state) is what makes
// the second page refuse a changed state (here: v2 took effect between pages).
test('SV-2: real 0014 — a version that takes effect between server-side history pages fails AVAILABILITY_CHANGED', async t => {
  const r = await scenario(t, null, 'server');
  console.log(`# SV-2 page 1 observations: ${r.page2}; outcome ${r.outcome}`);
  assert.equal(r.page2, 1);
  assert.equal(r.outcome, 'INTEL:AVAILABILITY_CHANGED');
});

test('SV-2M: mutant — server state token without the version in effect accepts the changed state (killed)', async t => {
  const r = await scenario(t, STATE_FN.replace(ANCHOR, ''), 'server');
  console.log(`# SV-2M page 1 observations: ${r.page2}; outcome ${r.outcome}`);
  assert.equal(r.outcome, 'ok:3', 'the defect: a change of the version in effect between pages is not reported');
});
