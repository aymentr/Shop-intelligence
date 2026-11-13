// Shop Intelligence — M4-P1 (M4-P1.1): synthetic advertiser intelligence demonstration.
//
// SYNTHETIC DATA ONLY. Every advertiser, advertisement and timestamp below is invented for this demonstration.
// Nothing here represents live market conditions, real advertisers or real campaigns, and nothing is
// displayed to a customer, exported or mirrored. There is no network collection.
//
// Drives the REAL implementation (migrations 0001-0016, persistence library in dist/) against a disposable
// PostgreSQL 16.15 container started by demo/run.sh (DEMO_PROGRAM=demo/intelligence.mjs). The reader uses only
// si_begin_read + si_read_evidence + si_read_source_status + si_read_source_availability, through
// src/persistence/intelligence.ts.
//
// Fixtures that no product path can perform (each named in the report):
//   - "time shift": the demo superuser sets finished runs' timestamps to historical instants
//     (session_replication_role = replica), the only way to show several days of history in one run;
//   - "disturbed receipt": one run's receipt identity is disturbed so that verification yields UNVERIFIABLE.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { bootstrapCluster, bootstrapDatabase, LOGIN_ROLES, provisionReaderPrincipal } from '../dist/persistence/bootstrap.js';
import { migrateUp, codeSchemaVersion } from '../dist/persistence/migrate.js';
import { fixtureSha256, requestSha256 } from '../dist/persistence/request-hash.js';
import { t1PreflightScoped, completeRunWithEvidence } from '../dist/persistence/runs.js';
import { verifyReceipts } from '../dist/persistence/verification.js';
import { grantReader, ReadFailed } from '../dist/persistence/reader.js';
import { advertiserHistory, searchAdvertisers, freshness, IntelligenceFailed } from '../dist/persistence/intelligence.js';

const env = process.env;
const DB = 'si_intel_demo';
const cfg = { port: Number(env.DEMO_PGPORT), adminPassword: env.DEMO_ADMIN_PASSWORD, container: env.DEMO_CONTAINER ?? '',
              report: env.DEMO_REPORT ?? '', commit: env.DEMO_COMMIT ?? 'unknown' };
if (!Number.isInteger(cfg.port) || !cfg.adminPassword || !/^si-demo-[A-Za-z0-9-]+$/.test(cfg.container)) {
  console.error('DEMO_REFUSED: run through demo/run.sh (disposable loopback container only)'); process.exit(2);
}
const ROLE_PW = randomBytes(18).toString('hex');
const READER = 'si_reader_demo_analyst';
const clients = [];
async function conn(user, database = DB) {
  const c = new pg.Client({ host: '127.0.0.1', port: cfg.port, user, database, application_name: 'si-intel-demo',
    password: user === 'si_bootstrap' ? cfg.adminPassword : ROLE_PW });
  c.on('error', () => {}); await c.connect(); clients.push(c); return c;
}
const report = { demo: 'shop-intelligence-m4-p1-synthetic-advertiser-intelligence', data: 'SYNTHETIC — not live market data', commit: cfg.commit,
  schema_version: null, scenarios: [], insights: {}, fixtures_used: [
    { fixture: 'time shift: finished runs moved to historical instants by the demo superuser (session_replication_role = replica)' },
    { fixture: 'disturbed receipt identity (one run) so that verification is UNVERIFIABLE' }], limitations: [] };
async function scenario(id, name, fn) {
  const t0 = performance.now(); let outcome = 'PASS', why = null;
  try { await fn(); } catch (e) { outcome = 'FAIL'; why = e instanceof assert.AssertionError ? e.message : `${e.name}:${e.code ?? ''}`; }
  report.scenarios.push({ id, name, outcome, ...(why ? { reason: why } : {}), ms: Math.round(performance.now() - t0) });
  console.log(`${outcome} ${id} ${name}${why ? ` — ${why}` : ''}`);
}
const iso = d => d.toISOString();
const DAY = 86400000;

let A, col, ra, mon, rd;
const SRC = 'synthetic-market-a';
// Two invented advertisers; ids are local to this demonstration.
const AD = (advertiser, id, network = 'META', title = 'Synthetic offer') => ({ network, nativeAdId: `demo-${id}`, advertiserName: advertiser, countries: ['DE'],
  seenAt: '2026-10-01T00:00:00.000Z', sourceUrl: `https://example.org/synthetic/${id}`, destinationUrl: 'https://example.org/d', creativeUrl: 'https://example.org/c', title });
const NW = 'Northwind Outfitters (synthetic)', HG = 'Harbor Grove Foods (synthetic)';
// Day-by-day synthetic history: [day offset from now, rows]
const HISTORY = [
  [-9, [AD(NW, 'nw-1'), AD(NW, 'nw-2', 'TIKTOK'), AD(HG, 'hg-1')]],
  [-7, [AD(NW, 'nw-1'), AD(HG, 'hg-1'), AD(HG, 'hg-2')]],
  [-6, []],                                                                  // a successful collection that found nothing
  [-4, [AD(NW, 'nw-1'), AD(NW, 'nw-3')]],                                     // its receipt will be UNVERIFIABLE (fixture)
  [-2, [AD(HG, 'hg-2'), AD(NW, 'nw-3')]],
  [-1, []]                                                                   // the collector ran yesterday and found nothing
];
try {
  await scenario('E1', 'Disposable PostgreSQL 16 with migrations 0001-0016 and a dedicated reader', async () => {
    const root = await conn('si_bootstrap', 'postgres');
    await bootstrapCluster(root, { passwords: Object.fromEntries(LOGIN_ROLES.map(r => [r, ROLE_PW])) });
    await provisionReaderPrincipal(root, READER, ROLE_PW);
    await root.query(`DROP DATABASE IF EXISTS ${DB}`); await root.query(`CREATE DATABASE ${DB}`);
    A = await conn('si_bootstrap'); await bootstrapDatabase(A);
    assert.deepEqual(await migrateUp(await conn('si_migrator')), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    report.schema_version = codeSchemaVersion();
    [col, ra, mon, rd] = await Promise.all(['si_collector', 'si_rights_admin', 'si_monitor', READER].map(u => conn(u)));
    await A.query('BEGIN'); await A.query('SET LOCAL ROLE si_owner');
    await A.query(`INSERT INTO si.sources (source_id, display_name, evidence_kind, supported_networks, conflict_policy) VALUES ($1, 'Synthetic market A (demo)', 'SYNTHETIC', '{META,TIKTOK}', 'KEEP_FIRST')`, [SRC]);
    await A.query('COMMIT');
    await ra.query(`SELECT * FROM si.si_record_rights_version($1, 'ALLOWED', 'ALLOWED', 'DENIED', 'DENIED', 'DENIED', 30, interval '1 hour',
      'Author-created synthetic data for the M4-P1 demonstration only', 'M4-P1 demonstration', NULL, NULL,
      ARRAY['SYNTHETIC_DECLARATION'], ARRAY['demo/intelligence.mjs'], NULL, ARRAY['synthetic records; URLs are never fetched'])`, [SRC]);
    await grantReader(ra, READER, SRC, 'internal synthetic evaluation (M4-P1 demonstration)');
  });

  await scenario('H1', 'Six collection runs over nine days (two EMPTY, one with an UNVERIFIABLE receipt)', async () => {
    const now = Date.now();
    let k = 0;
    for (const [dayOffset, rows] of HISTORY) {
      const networks = rows.length ? [...new Set(rows.map(r => r.network))].sort() : ['META'];
      const fx = fixtureSha256(rows);
      const t1 = await t1PreflightScoped(col, { sourceId: SRC, requestKey: `intel-demo-${++k}`, evidenceKind: 'SYNTHETIC', networks, fixtureSha256: fx,
        requestSha256: requestSha256({ adapterId: SRC, evidenceKind: 'SYNTHETIC', networks, fixtureSha256: fx }) });
      assert.equal(t1.outcome, 'RUNNING');
      const t2 = await completeRunWithEvidence(col, t1.runId, t1.leaseToken, rows);
      assert.equal(t2.outcome, 'COMPLETED');
      if (dayOffset === -4) {                                                // fixture: disturb this receipt before verification
        await A.query('BEGIN'); await A.query('SET LOCAL session_replication_role = replica');
        await A.query('UPDATE si.publication_receipts SET receipt_at = receipt_at WHERE run_id = $1', [t1.runId]); await A.query('COMMIT');
      }
      await verifyReceipts(mon, 100);
      const when = new Date(Math.floor((now + dayOffset * DAY) / 1000) * 1000);
      await A.query('BEGIN'); await A.query('SET LOCAL session_replication_role = replica');        // fixture: time shift
      await A.query(`UPDATE si.collection_runs SET started_at = $2::timestamptz - interval '5 seconds', finished_at = $2::timestamptz WHERE run_id = $1`, [t1.runId, iso(when)]);
      await A.query('COMMIT');
    }
  });

  const period = { from: new Date(Math.floor((Date.now() - 10 * DAY) / DAY) * DAY), to: new Date(Math.floor((Date.now() + DAY) / DAY) * DAY) };
  await scenario('S1', 'Advertiser search (deterministic, one source, explicit authorization)', async () => {
    const page = await searchAdvertisers(rd, { sources: [SRC], query: 'synthetic', period, limit: 10 });
    report.insights.search = page.hits.map(h => ({ advertiser: h.names[0], observations: h.observations, distinct_ads: h.distinctAds,
      runs_with_evidence: h.runsWithEvidence, first_observed_at: h.firstObservedAt, last_observed_at: h.lastObservedAt, networks: h.networks }));
    assert.deepEqual(page.hits.map(h => h.names[0]), [HG, NW], 'ordered by normalized name');
    assert.deepEqual(page.hits.map(h => [h.observations, h.distinctAds, h.runsWithEvidence]), [[4, 2, 3], [4, 3, 3]], 'only VERIFIED runs count (the UNVERIFIABLE run is excluded)');
  });

  await scenario('A1', 'Advertiser history with provenance (Northwind, synthetic)', async () => {
    const h = await advertiserHistory(rd, SRC, NW, { period, withStatus: true });
    report.insights.history_northwind = { observations: h.observations.length, distinct_ads: h.distinctAds, runs_with_evidence: h.runsWithEvidence,
      first_observed_at: h.firstObservedAt, last_observed_at: h.lastObservedAt, networks: h.networks, end_of_activity: h.endOfActivity,
      provenance_example: h.observations[0] && { source: h.observations[0].sourceId, run: h.observations[0].runId, ordinal: h.observations[0].ordinal,
        content_sha256: h.observations[0].contentSha256, verification: h.observations[0].verification },
      source_run_verdicts: h.sourceVerification && { valid: h.sourceVerification.runsVerifiedValid, unverifiable: h.sourceVerification.runsVerifiedUnverifiable },
      notes: h.notes };
    assert.deepEqual([h.observations.length, h.distinctAds, h.runsWithEvidence], [4, 3, 3]);
    assert.equal(h.endOfActivity, 'UNKNOWN', 'no claim that an ad stopped running');
    assert.equal(h.sourceVerification.runsVerifiedUnverifiable, 1);
  });

  await scenario('F1', 'Freshness and reliability (collection vs. evidence freshness, coverage, verification completeness)', async () => {
    const f = await freshness(rd, SRC, period);
    report.insights.freshness = f;
    assert.equal(f.collectionFreshness.state, 'KNOWN');
    assert.equal(f.evidenceFreshness.state, 'KNOWN');
    assert.ok(f.collectionFreshness.value.ageSeconds < f.evidenceFreshness.value.ageSeconds,
              'the collector ran more recently (EMPTY run) than the newest verified evidence: two different facts');
    assert.deepEqual(f.verificationCompleteness.value, { valid: 3, invalid: 0, unverifiable: 1, pending: 0, runsWithEvidence: 4, ratio: 0.75 });
    assert.equal(f.collectionCoverage.value.daysWithCollection, 6);
    assert.equal(f.evidenceCoverage.value.daysWithVerifiedEvidence, 3);
    const empty = await freshness(rd, SRC, { from: new Date(period.from.getTime() - 200 * DAY), to: new Date(period.from.getTime() - 100 * DAY) });
    report.insights.freshness_unknown_example = { verificationCompleteness: empty.verificationCompleteness, collectionReliability: empty.collectionReliability };
    assert.equal(empty.verificationCompleteness.state, 'UNKNOWN', 'insufficient evidence is UNKNOWN, never zero or a guess');
  });

  await scenario('X1', 'A source suspension immediately blocks further reads, explicitly (not an empty history)', async () => {
    await ra.query(`SELECT * FROM si.si_record_source_control($1, 'SUSPEND', 'demo suspension', NULL, NULL, NULL, NULL, NULL)`, [SRC]);
    const outcome = async p => { try { await p; return { code: 'OK', reasons: [] }; }
      catch (e) { return e instanceof IntelligenceFailed ? { code: e.code, reasons: [...e.reasons] } : { code: e instanceof ReadFailed ? e.code : 'other', reasons: [] }; } };
    const history = await outcome(advertiserHistory(rd, SRC, NW));
    const search = await outcome(searchAdvertisers(rd, { sources: [SRC], query: 'synthetic' }));
    const status = await outcome(freshness(rd, SRC, period));
    for (const o of [history, search, status]) assert.deepEqual(o, { code: 'SOURCE_UNAVAILABLE', reasons: ['SUSPENDED'] }, 'typed, with its reason; nothing released');
    report.insights.after_suspension = { history, search, status };
  });

  await scenario('U1', 'Every request left a committed, consumed request record (audit)', async () => {
    const r = (await A.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE state = 'CONSUMED')::int AS c FROM si.read_intents`)).rows[0];
    report.insights.request_records = r;
    assert.ok(r.n >= 8 && r.c >= 1);
  });
} catch (e) {
  report.scenarios.push({ id: 'X', name: 'unexpected demo error', outcome: 'FAIL', reason: `${e?.name}:${e?.code ?? ''}` });
  console.log(`FAIL X unexpected — ${e?.name}`);
} finally { for (const c of clients) await c.end().catch(() => {}); }

report.limitations = [
  'SYNTHETIC data only; not live market conditions; no real advertiser, ad or campaign.',
  'History, search and freshness are internal evaluation outputs; no customer display, export or mirroring.',
  'Missing observations do not show that an advertisement stopped running; no performance, spend, reach or conversion data exists or is inferred.',
  'Advertiser identity is the normalized name within one source; no cross-source identity resolution.',
  'Historical timestamps are a labelled superuser fixture (time shift).'
];
const failed = report.scenarios.filter(s => s.outcome === 'FAIL');
report.result = failed.length ? 'FAIL' : 'PASS';
if (cfg.report) writeFileSync(cfg.report, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.insights, null, 2));
console.log(`RESULT ${report.result}: ${report.scenarios.length - failed.length} passed, ${failed.length} failed (SYNTHETIC DATA — not live market conditions)`);
process.exitCode = failed.length ? 1 : 0;
